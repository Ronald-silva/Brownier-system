// LLM Interpreter — componente isolado e testável que chamaria um provider
// de IA para converter texto em AgentConversationAction[] quando o
// Deterministic Interpreter não entender. É usado como fallback elegível
// pelo Text Conversation Service; não chama Tools, não chama Orders, não
// cria pedido e não faz rede — isso fica restrito ao provider injetado.
import { buildLlmSystemPrompt, buildLlmUserPrompt, LLM_INTERPRETER_PROMPT_VERSION } from "./llm-prompt.ts";
import { DEFAULT_MAX_OUTPUT_LENGTH, validateLlmOutput } from "./llm-output-validator.ts";
import type {
  CreateLlmInterpreterInput,
  InterpretLlmMessageInput,
  LlmInterpretationResult,
  LlmInterpreter,
} from "./llm-interpreter.types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

const MIN_MAX_OUTPUT_LENGTH = 100;
const MAX_MAX_OUTPUT_LENGTH = 200_000;

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  const truncated = Math.trunc(timeoutMs);
  if (truncated < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (truncated > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return truncated;
}

function resolveMaxOutputLength(maxOutputLength: number | undefined): number {
  if (typeof maxOutputLength !== "number" || !Number.isFinite(maxOutputLength)) return DEFAULT_MAX_OUTPUT_LENGTH;
  const truncated = Math.trunc(maxOutputLength);
  if (truncated < MIN_MAX_OUTPUT_LENGTH) return MIN_MAX_OUTPUT_LENGTH;
  if (truncated > MAX_MAX_OUTPUT_LENGTH) return MAX_MAX_OUTPUT_LENGTH;
  return truncated;
}

const PROVIDER_TIMEOUT_MARKER = "LLM_PROVIDER_TIMEOUT";

const SAFE_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  "NVIDIA_AUTHENTICATION",
  "NVIDIA_RATE_LIMIT",
  "NVIDIA_TIMEOUT",
  "NVIDIA_SERVER_ERROR",
  "NVIDIA_EMPTY_OUTPUT",
  "NVIDIA_UNKNOWN",
  "TIMEOUT",
  "AUTHENTICATION",
  "RATE_LIMIT",
  "SERVER_ERROR",
  "EMPTY_OUTPUT",
  "UNKNOWN",
  "LOCAL_RATE_LIMIT",
  "LOCAL_CONCURRENCY_LIMIT",
]);

type SafeProviderError = {
  reason: string;
  retryable: boolean;
};

const PROVIDER_REJECTED: SafeProviderError = {
  reason: "PROVIDER_REJECTED",
  retryable: false,
};

// Extrai apenas os dois campos seguros já classificados pelos adapters. Não
// espalha nem serializa o erro, para que mensagem, stack, request ou resposta
// nunca saiam do limite do provider.
function extractSafeProviderError(error: unknown): SafeProviderError {
  if (typeof error !== "object" || error === null) return PROVIDER_REJECTED;

  try {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (
      typeof candidate.code !== "string" ||
      !SAFE_PROVIDER_ERROR_CODES.has(candidate.code) ||
      typeof candidate.retryable !== "boolean"
    ) {
      return PROVIDER_REJECTED;
    }
    return { reason: candidate.code, retryable: candidate.retryable };
  } catch {
    return PROVIDER_REJECTED;
  }
}

// TEMPORÁRIO — ver comentário no ponto de chamada (createLlmInterpreter,
// branch MATCHED). Não há módulo de observabilidade estruturada neste
// projeto ainda; console.warn em JSON é o mecanismo mais simples que o
// Railway já captura, sem introduzir uma dependência nova só para isto.
function logShowMenuMatch(input: {
  status: "MATCHED";
  actionTypes: string[];
  intent?: string;
  confidence?: "HIGH" | "LOW";
}): void {
  console.warn(JSON.stringify({ tag: "llm_interpreter_show_menu_matched", ...input }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(PROVIDER_TIMEOUT_MARKER)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createLlmInterpreter(input: CreateLlmInterpreterInput): LlmInterpreter {
  if (!input || !input.provider || typeof input.provider.generateStructuredOutput !== "function") {
    throw new Error("createLlmInterpreter requires a provider implementing generateStructuredOutput");
  }
  const { provider } = input;
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const maxOutputLength = resolveMaxOutputLength(input.maxOutputLength);

  return {
    async interpret(interpretInput: InterpretLlmMessageInput): Promise<LlmInterpretationResult> {
      // Cópias defensivas: nada que o provider ou o validator recebam pode
      // ser o mesmo objeto do chamador.
      const session = structuredClone(interpretInput.session);
      const context = interpretInput.context ? structuredClone(interpretInput.context) : undefined;
      const deterministicResult = interpretInput.deterministicResult
        ? structuredClone(interpretInput.deterministicResult)
        : undefined;
      const text = typeof interpretInput.text === "string" ? interpretInput.text : "";

      const shortHistory = interpretInput.shortHistory ? structuredClone(interpretInput.shortHistory) : undefined;
      const systemPrompt = buildLlmSystemPrompt();
      const userPrompt = buildLlmUserPrompt({ text, session, context, deterministicResult, shortHistory });

      const startedAt = Date.now();
      let raw: unknown;
      try {
        raw = await withTimeout(
          provider.generateStructuredOutput({
            systemPrompt,
            userPrompt,
            schemaName: "llm_interpreter_output_v1",
            timeoutMs,
          }),
          timeoutMs,
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const isTimeout = error instanceof Error && error.message === PROVIDER_TIMEOUT_MARKER;
        const providerError = isTimeout
          ? { reason: "TIMEOUT", retryable: true }
          : extractSafeProviderError(error);
        return {
          status: "PROVIDER_ERROR",
          reason: providerError.reason,
          retryable: providerError.retryable,
          promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
          durationMs,
        };
      }

      const durationMs = Date.now() - startedAt;
      const validated = validateLlmOutput({ raw, session, context, maxOutputLength });

      if (validated.status === "MATCHED") {
        // TEMPORÁRIO — logging de causa raiz para o incidente de SHOW_MENU
        // repetido (ver docs/audits/2026-08-01-show-menu-repetido.md).
        // Dispara só quando a ação decidida é SHOW_MENU, para não virar
        // ruído nem ampliar a superfície de exposição além do necessário.
        // Nunca inclui texto do cliente, contactId ou qualquer PII — apenas
        // metadados já classificados pelo validator. Remover ou promover a
        // observabilidade permanente assim que o padrão estiver confirmado
        // com dados reais.
        if (validated.actions.some(action => action.type === "SHOW_MENU")) {
          logShowMenuMatch({
            status: validated.status,
            actionTypes: validated.actions.map(action => action.type),
            ...(validated.intent ? { intent: validated.intent } : {}),
            ...(validated.confidence ? { confidence: validated.confidence } : {}),
          });
        }
        return {
          status: "MATCHED",
          actions: validated.actions,
          source: "LLM",
          promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
          durationMs,
          ...(validated.intent ? { intent: validated.intent } : {}),
          ...(validated.responseIntent ? { responseIntent: validated.responseIntent } : {}),
          ...(validated.confidence ? { confidence: validated.confidence } : {}),
        };
      }
      if (validated.status === "NOT_UNDERSTOOD") {
        return {
          status: "NOT_UNDERSTOOD",
          reason: validated.reason,
          ...(validated.suggestions ? { suggestions: validated.suggestions } : {}),
          source: "LLM",
          promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
          durationMs,
          ...(validated.intent ? { intent: validated.intent } : {}),
          ...(validated.responseIntent ? { responseIntent: validated.responseIntent } : {}),
          ...(validated.confidence ? { confidence: validated.confidence } : {}),
        };
      }
      if (validated.status === "AMBIGUOUS") {
        return {
          status: "AMBIGUOUS",
          reason: validated.reason,
          ...(validated.candidates ? { candidates: validated.candidates } : {}),
          source: "LLM",
          promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
          durationMs,
          ...(validated.intent ? { intent: validated.intent } : {}),
          ...(validated.responseIntent ? { responseIntent: validated.responseIntent } : {}),
          ...(validated.confidence ? { confidence: validated.confidence } : {}),
        };
      }
      return {
        status: "REJECTED",
        reason: validated.reason,
        source: "VALIDATOR",
        promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
        durationMs,
      };
    },
  };
}
