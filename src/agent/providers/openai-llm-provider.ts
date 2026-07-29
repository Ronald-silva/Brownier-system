// Adaptador OpenAI para o contrato LlmInterpreterProvider — chama a
// Responses API pedindo saída estruturada em JSON e devolve apenas o texto
// final. Não decide nada sobre a conversa: quem valida a saída continua
// sendo o llm-output-validator.ts. Nesta etapa o provider não é ligado ao
// Text Conversation Service, ao simulador nem a nenhuma variável de
// ambiente — é infraestrutura isolada, testável com um cliente fake.
import OpenAI, {
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import type { LlmInterpreterProvider, LlmProviderRequest } from "../llm-interpreter.types.ts";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "./openai-response-schema.ts";
import type { LlmProviderUsage } from "./llm-provider-usage.ts";

// --- erro local ---------------------------------------------------------
// Apenas code + retryable: nunca prompt, chave ou resposta bruta do provider.

export type OpenAiLlmProviderErrorCode =
  | "TIMEOUT"
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "EMPTY_OUTPUT"
  | "UNKNOWN"
  | "LOCAL_RATE_LIMIT"
  | "LOCAL_CONCURRENCY_LIMIT";

export class OpenAiLlmProviderError extends Error {
  readonly code: OpenAiLlmProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: OpenAiLlmProviderErrorCode, retryable: boolean) {
    super(`OpenAiLlmProviderError: ${code}`);
    this.name = "OpenAiLlmProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function mapProviderError(error: unknown): OpenAiLlmProviderError {
  if (error instanceof APIConnectionTimeoutError) return new OpenAiLlmProviderError("TIMEOUT", true);
  if (error instanceof AuthenticationError) return new OpenAiLlmProviderError("AUTHENTICATION", false);
  if (error instanceof RateLimitError) return new OpenAiLlmProviderError("RATE_LIMIT", true);
  if (error instanceof InternalServerError) return new OpenAiLlmProviderError("SERVER_ERROR", true);
  return new OpenAiLlmProviderError("UNKNOWN", false);
}

// --- limitador local de requisições por minuto -----------------------------
// Janela deslizante em memória, por instância do provider — sem timer, sem
// persistência, sem coordenação entre instâncias ou processos.

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 30;
const MAX_REQUESTS_PER_MINUTE_CEILING = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;

function validateMaxRequestsPerMinute(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_REQUESTS_PER_MINUTE;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_REQUESTS_PER_MINUTE_CEILING
  ) {
    throw new TypeError(
      `createOpenAiLlmProvider: maxRequestsPerMinute must be an integer between 1 and ${MAX_REQUESTS_PER_MINUTE_CEILING}`,
    );
  }
  return value;
}

// --- limitador local de concorrência ---------------------------------------
// Contador de chamadas em andamento, por instância do provider — rejeita na
// hora quando os slots acabam, sem fila e sem espera.

const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const MAX_CONCURRENT_REQUESTS_CEILING = 20;

function validateMaxConcurrentRequests(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_REQUESTS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CONCURRENT_REQUESTS_CEILING
  ) {
    throw new TypeError(
      `createOpenAiLlmProvider: maxConcurrentRequests must be an integer between 1 and ${MAX_CONCURRENT_REQUESTS_CEILING}`,
    );
  }
  return value;
}

// --- cliente injetável ----------------------------------------------------
// Only the slice of the OpenAI SDK this provider actually calls, so tests
// can inject a fake without touching the network.

type OpenAiResponseLike = {
  output_text?: string | null;
  id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type OpenAiResponsesClient = {
  responses: {
    create(params: Record<string, unknown>): Promise<OpenAiResponseLike>;
  };
};

export type CreateOpenAiLlmProviderInput = {
  apiKey: string;
  model: string;
  client?: OpenAiResponsesClient;
  onUsage?: (usage: LlmProviderUsage) => void;
  now?: () => number;
  maxRequestsPerMinute?: number;
  maxConcurrentRequests?: number;
};

export function createOpenAiLlmProvider(input: CreateOpenAiLlmProviderInput): LlmInterpreterProvider {
  const { apiKey, model, onUsage } = input;
  const maxRequestsPerMinute = validateMaxRequestsPerMinute(input.maxRequestsPerMinute);
  const maxConcurrentRequests = validateMaxConcurrentRequests(input.maxConcurrentRequests);
  if (input.now !== undefined && typeof input.now !== "function") {
    throw new TypeError("createOpenAiLlmProvider: now must be a function");
  }
  const now = input.now ?? Date.now;
  const client: OpenAiResponsesClient = input.client ?? new OpenAI({ apiKey });

  let requestTimestamps: number[] = [];
  let activeRequestCount = 0;

  return {
    async generateStructuredOutput(request: LlmProviderRequest): Promise<unknown> {
      const { systemPrompt, userPrompt, schemaName } = request;

      const startedAt = now();
      requestTimestamps = requestTimestamps.filter(
        (timestamp) => startedAt - timestamp < RATE_LIMIT_WINDOW_MS,
      );
      if (requestTimestamps.length >= maxRequestsPerMinute) {
        throw new OpenAiLlmProviderError("LOCAL_RATE_LIMIT", true);
      }
      if (activeRequestCount >= maxConcurrentRequests) {
        throw new OpenAiLlmProviderError("LOCAL_CONCURRENCY_LIMIT", true);
      }
      requestTimestamps.push(startedAt);
      activeRequestCount += 1;

      try {
        let response: OpenAiResponseLike;
        try {
          response = await client.responses.create({
            model,
            instructions: systemPrompt,
            input: userPrompt,
            store: false,
            stream: false,
            text: {
              format: {
                type: "json_schema",
                name: schemaName,
                schema: OPENAI_LLM_RESPONSE_SCHEMA,
              },
            },
          });
        } catch (error) {
          throw mapProviderError(error);
        }

        const outputText = response?.output_text;
        if (typeof outputText !== "string" || outputText.trim().length === 0) {
          throw new OpenAiLlmProviderError("EMPTY_OUTPUT", false);
        }

        if (onUsage) {
          try {
            onUsage({
              inputTokens: response.usage?.input_tokens,
              outputTokens: response.usage?.output_tokens,
              totalTokens: response.usage?.total_tokens,
              model: response.model,
              responseId: response.id,
              durationMs: now() - startedAt,
            });
          } catch {
            // onUsage is best-effort telemetry; a throwing callback must never
            // affect the returned output_text or trigger a retry.
          }
        }

        return outputText;
      } finally {
        activeRequestCount -= 1;
      }
    },
  };
}
