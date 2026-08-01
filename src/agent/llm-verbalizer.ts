// LLM Verbalizer — chamada NVIDIA #2. Recebe um VerbalizationRequest (só
// fatos já autorizados pelo servidor + histórico curto + mensagem atual) e
// devolve o texto final em português natural. Não decide render strategy,
// não executa ação nenhuma, não persiste nada. A checagem de grounding
// (todo usedFactId realmente existe em facts, preço/endereço/horário citado
// bate com o autorizado etc.) é sempre depois, em response-text-validator.ts
// — este módulo só troca "JSON malformado" por REJECTED, nunca valida
// conteúdo semântico.
import { buildVerbalizerSystemPrompt, buildVerbalizerUserPrompt, LLM_VERBALIZER_PROMPT_VERSION } from "./llm-verbalizer-prompt.ts";
import { parseLlmOutput } from "./llm-output-validator.ts";
import { VERBALIZER_RESPONSE_TEXT_MAX_LENGTH } from "./providers/verbalizer-response-schema.ts";
import type { VerbalizationRequest, VerbalizationResult } from "./conversation-intelligence.types.ts";

export type LlmVerbalizerProviderRequest = {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  timeoutMs?: number;
};

export interface LlmVerbalizerProvider {
  generateStructuredOutput(request: LlmVerbalizerProviderRequest): Promise<unknown>;
}

export type CreateLlmVerbalizerInput = {
  provider: LlmVerbalizerProvider;
  timeoutMs?: number;
  maxOutputLength?: number;
};

export type LlmVerbalizer = {
  verbalize(request: VerbalizationRequest): Promise<VerbalizationResult>;
};

const DEFAULT_TIMEOUT_MS = 4_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 10_000;
const MAX_USED_FACT_IDS = 20;

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  const truncated = Math.trunc(timeoutMs);
  if (truncated < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (truncated > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return truncated;
}

const PROVIDER_TIMEOUT_MARKER = "LLM_VERBALIZER_PROVIDER_TIMEOUT";

const SAFE_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  "NVIDIA_AUTHENTICATION",
  "NVIDIA_RATE_LIMIT",
  "NVIDIA_TIMEOUT",
  "NVIDIA_SERVER_ERROR",
  "NVIDIA_EMPTY_OUTPUT",
  "NVIDIA_UNKNOWN",
  "TIMEOUT",
  "LOCAL_RATE_LIMIT",
  "LOCAL_CONCURRENCY_LIMIT",
]);

type SafeProviderError = { reason: string; retryable: boolean };
const PROVIDER_REJECTED: SafeProviderError = { reason: "PROVIDER_REJECTED", retryable: false };

function extractSafeProviderError(error: unknown): SafeProviderError {
  if (typeof error !== "object" || error === null) return PROVIDER_REJECTED;
  try {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (typeof candidate.code !== "string" || !SAFE_PROVIDER_ERROR_CODES.has(candidate.code) || typeof candidate.retryable !== "boolean") {
      return PROVIDER_REJECTED;
    }
    return { reason: candidate.code, retryable: candidate.retryable };
  } catch {
    return PROVIDER_REJECTED;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(PROVIDER_TIMEOUT_MARKER)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Logging permanente de latência real (verbalização = chamada NVIDIA #2).
// Preparado para quando BF_VERBALIZATION_MODE=ENABLED for ligado em
// produção — hoje nunca dispara ali (verbalização segue DISABLED), mas o
// mecanismo já existe para não depender de outro deploy nesse dia. Mesma
// disciplina do log de planejamento: nunca inclui responseText, usedFactIds
// ou qualquer dado derivado da mensagem do cliente — apenas status/reason
// (ambos enums já classificados) e durationMs.
function logVerbalizationCall(result: VerbalizationResult): void {
  const entry: Record<string, unknown> = {
    event: "llm_verbalization_call",
    status: result.status,
    durationMs: result.durationMs,
    timestamp: new Date().toISOString(),
  };
  if (result.status !== "VERBALIZED") entry.reason = result.reason;
  console.log(JSON.stringify(entry));
}

function logAndReturn(result: VerbalizationResult): VerbalizationResult {
  logVerbalizationCall(result);
  return result;
}

function extractUsedFactIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_USED_FACT_IDS) break;
  }
  return out;
}

export function createLlmVerbalizer(input: CreateLlmVerbalizerInput): LlmVerbalizer {
  if (!input || !input.provider || typeof input.provider.generateStructuredOutput !== "function") {
    throw new Error("createLlmVerbalizer requires a provider implementing generateStructuredOutput");
  }
  const { provider } = input;
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const maxOutputLength = input.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;

  return {
    async verbalize(request: VerbalizationRequest): Promise<VerbalizationResult> {
      const systemPrompt = buildVerbalizerSystemPrompt();
      const userPrompt = buildVerbalizerUserPrompt(request);

      const startedAt = Date.now();
      let raw: unknown;
      try {
        raw = await withTimeout(
          provider.generateStructuredOutput({
            systemPrompt,
            userPrompt,
            schemaName: "llm_verbalizer_output_v1",
            timeoutMs,
          }),
          timeoutMs,
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const isTimeout = error instanceof Error && error.message === PROVIDER_TIMEOUT_MARKER;
        const providerError = isTimeout ? { reason: "TIMEOUT", retryable: true } : extractSafeProviderError(error);
        return logAndReturn({ status: "PROVIDER_ERROR", reason: providerError.reason, retryable: providerError.retryable, durationMs });
      }

      const durationMs = Date.now() - startedAt;
      const parsed = parseLlmOutput(raw, maxOutputLength);
      if (parsed.ok === false) return logAndReturn({ status: "REJECTED", reason: parsed.reason, durationMs });

      const value = parsed.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return logAndReturn({ status: "REJECTED", reason: "INVALID_SCHEMA", durationMs });
      }
      const obj = value as Record<string, unknown>;
      const responseText = typeof obj.responseText === "string" ? obj.responseText.trim() : "";
      if (!responseText) return logAndReturn({ status: "REJECTED", reason: "EMPTY_RESPONSE_TEXT", durationMs });
      if (responseText.length > VERBALIZER_RESPONSE_TEXT_MAX_LENGTH) {
        return logAndReturn({ status: "REJECTED", reason: "RESPONSE_TEXT_TOO_LONG", durationMs });
      }

      const usedFactIds = extractUsedFactIds(obj.usedFactIds);
      return logAndReturn({ status: "VERBALIZED", text: responseText, usedFactIds, durationMs });
    },
  };
}
