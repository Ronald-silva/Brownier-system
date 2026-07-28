// LLM Interpreter — componente isolado e testável que chamaria um provider
// de IA para converter texto em AgentConversationAction[] quando o
// Deterministic Interpreter não entender. Nesta etapa NÃO é chamado por
// nenhum outro componente do sistema (nem Text Conversation Service, nem
// simulador): é infraestrutura pronta para uma integração futura decidir
// quando usá-la. Não chama Tools, não chama Orders, não cria pedido, não
// faz rede — quem faz rede é o provider injetado, que aqui é sempre um
// FakeLlmProvider nos testes.
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

      const systemPrompt = buildLlmSystemPrompt();
      const userPrompt = buildLlmUserPrompt({ text, session, context, deterministicResult });

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
        return {
          status: "PROVIDER_ERROR",
          reason: isTimeout ? "TIMEOUT" : "PROVIDER_REJECTED",
          retryable: isTimeout,
          promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
          durationMs,
        };
      }

      const durationMs = Date.now() - startedAt;
      const validated = validateLlmOutput({ raw, session, context, maxOutputLength });

      if (validated.status === "MATCHED") {
        return {
          status: "MATCHED",
          actions: validated.actions,
          source: "LLM",
          promptVersion: LLM_INTERPRETER_PROMPT_VERSION,
          durationMs,
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
