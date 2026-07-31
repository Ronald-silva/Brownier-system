// Adaptador NVIDIA Nemotron para a chamada de verbalização (NVIDIA #2) — a
// mesma API compatível com OpenAI Chat Completions do NIM, com um schema de
// saída próprio (texto natural + usedFactIds), nunca o schema de ações do
// LLM Interpreter. Estrutura irmã de nvidia-nemotron-llm-provider.ts
// (mesmo rate limit/concorrência local, mesmo mapeamento de erro seguro),
// mantida em arquivo separado para não alterar o contrato já testado do
// provider de planejamento. NVIDIA_NEMOTRON continua o único provider.
import OpenAI, {
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import type { NvidiaCompatibleClient } from "./nvidia-nemotron-llm-provider.ts";
import { VERBALIZER_RESPONSE_SCHEMA } from "./verbalizer-response-schema.ts";

export type NvidiaNemotronVerbalizerProviderErrorCode =
  | "NVIDIA_AUTHENTICATION"
  | "NVIDIA_RATE_LIMIT"
  | "NVIDIA_TIMEOUT"
  | "NVIDIA_SERVER_ERROR"
  | "NVIDIA_EMPTY_OUTPUT"
  | "NVIDIA_UNKNOWN"
  | "LOCAL_RATE_LIMIT"
  | "LOCAL_CONCURRENCY_LIMIT";

export class NvidiaNemotronVerbalizerProviderError extends Error {
  readonly code: NvidiaNemotronVerbalizerProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: NvidiaNemotronVerbalizerProviderErrorCode, retryable: boolean) {
    super(`NvidiaNemotronVerbalizerProviderError: ${code}`);
    this.name = "NvidiaNemotronVerbalizerProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function mapProviderError(error: unknown): NvidiaNemotronVerbalizerProviderError {
  if (error instanceof APIConnectionTimeoutError) return new NvidiaNemotronVerbalizerProviderError("NVIDIA_TIMEOUT", true);
  if (error instanceof AuthenticationError) return new NvidiaNemotronVerbalizerProviderError("NVIDIA_AUTHENTICATION", false);
  if (error instanceof RateLimitError) return new NvidiaNemotronVerbalizerProviderError("NVIDIA_RATE_LIMIT", true);
  if (error instanceof InternalServerError) return new NvidiaNemotronVerbalizerProviderError("NVIDIA_SERVER_ERROR", true);
  return new NvidiaNemotronVerbalizerProviderError("NVIDIA_UNKNOWN", false);
}

export const NVIDIA_NEMOTRON_VERBALIZER_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const NVIDIA_NEMOTRON_VERBALIZER_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export type LlmVerbalizerProviderRequest = {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  timeoutMs?: number;
};

export interface LlmVerbalizerProvider {
  generateStructuredOutput(request: LlmVerbalizerProviderRequest): Promise<unknown>;
}

export type CreateNvidiaNemotronVerbalizerProviderInput = {
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxRequestsPerMinute?: number;
  maxConcurrentRequests?: number;
  client?: NvidiaCompatibleClient;
};

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 30;
const MAX_REQUESTS_PER_MINUTE_CEILING = 600;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const MAX_CONCURRENT_REQUESTS_CEILING = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

function validateLimit(value: unknown, defaultValue: number, ceiling: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new TypeError(`createNvidiaNemotronVerbalizerProvider: ${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

function normalizeApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new TypeError("createNvidiaNemotronVerbalizerProvider: apiKey must be a non-empty string");
  }
  return apiKey.trim();
}

function normalizeModel(model: unknown): string {
  if (model === undefined) return NVIDIA_NEMOTRON_VERBALIZER_DEFAULT_MODEL;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new TypeError("createNvidiaNemotronVerbalizerProvider: model must be a non-empty string");
  }
  return model.trim();
}

function normalizeBaseURL(baseURL: unknown): string {
  if (baseURL === undefined) return NVIDIA_NEMOTRON_VERBALIZER_DEFAULT_BASE_URL;
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    throw new TypeError("createNvidiaNemotronVerbalizerProvider: baseURL must be a non-empty string");
  }
  return baseURL.trim();
}

function buildSystemPrompt(systemPrompt: string, schemaName: string): string {
  const serializedSchema = JSON.stringify(VERBALIZER_RESPONSE_SCHEMA);
  return (
    `${systemPrompt}\n\n` +
    `A resposta deve conter somente JSON válido, sem texto adicional, sem markdown e sem comentários. ` +
    `O JSON deve respeitar exatamente o schema "${schemaName}" a seguir:\n${serializedSchema}`
  );
}

export function createNvidiaNemotronVerbalizerProvider(
  input: CreateNvidiaNemotronVerbalizerProviderInput,
): LlmVerbalizerProvider {
  const apiKey = normalizeApiKey(input.apiKey);
  const model = normalizeModel(input.model);
  const baseURL = normalizeBaseURL(input.baseURL);
  const maxRequestsPerMinute = validateLimit(input.maxRequestsPerMinute, DEFAULT_MAX_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE_CEILING, "maxRequestsPerMinute");
  const maxConcurrentRequests = validateLimit(input.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS, MAX_CONCURRENT_REQUESTS_CEILING, "maxConcurrentRequests");
  const client: NvidiaCompatibleClient = input.client ?? (new OpenAI({ apiKey, baseURL }) as unknown as NvidiaCompatibleClient);
  let requestTimestamps: number[] = [];
  let activeRequestCount = 0;

  return {
    async generateStructuredOutput(request: LlmVerbalizerProviderRequest): Promise<unknown> {
      const { systemPrompt, userPrompt, schemaName } = request;
      const startedAt = Date.now();
      requestTimestamps = requestTimestamps.filter(timestamp => startedAt - timestamp < RATE_LIMIT_WINDOW_MS);
      if (requestTimestamps.length >= maxRequestsPerMinute) {
        throw new NvidiaNemotronVerbalizerProviderError("LOCAL_RATE_LIMIT", true);
      }
      if (activeRequestCount >= maxConcurrentRequests) {
        throw new NvidiaNemotronVerbalizerProviderError("LOCAL_CONCURRENCY_LIMIT", true);
      }
      requestTimestamps.push(startedAt);
      activeRequestCount += 1;

      try {
        let response: { choices?: Array<{ message?: { content?: string | null } }> };
        try {
          response = await client.chat.completions.create({
            model,
            messages: [
              { role: "system", content: buildSystemPrompt(systemPrompt, schemaName) },
              { role: "user", content: userPrompt },
            ],
            temperature: 0,
            chat_template_kwargs: { enable_thinking: false },
            guided_json: VERBALIZER_RESPONSE_SCHEMA,
          });
        } catch (error) {
          throw mapProviderError(error);
        }

        const content = response?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim().length === 0) {
          throw new NvidiaNemotronVerbalizerProviderError("NVIDIA_EMPTY_OUTPUT", true);
        }
        return content;
      } finally {
        activeRequestCount -= 1;
      }
    },
  };
}
