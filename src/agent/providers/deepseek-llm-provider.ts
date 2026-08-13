// Adaptador DeepSeek para o contrato LlmInterpreterProvider — chama a API
// compatível com OpenAI Chat Completions exposta pela DeepSeek e devolve
// apenas o texto final. Não decide nada sobre a conversa: quem valida a
// saída continua sendo o llm-output-validator.ts. O provider é criado
// somente quando BF_LLM_MODE=DEEPSEEK_FALLBACK e é testável com um cliente
// fake, sem acesso a rede na suíte.
//
// Diferença importante em relação ao provider NVIDIA: a API da DeepSeek não
// suporta `guided_json`/`chat_template_kwargs` (extensões específicas do
// NVIDIA NIM/vLLM) — só o modo genérico `response_format: {"type":
// "json_object"}`, que garante JSON válido, mas não força o schema exato.
// A DeepSeek também exige a palavra "json" em algum lugar do prompt quando
// esse modo é usado, e recomenda um `max_tokens` explícito para evitar
// truncamento no meio do JSON. Fonte: docs.deepseek.com (guia "JSON
// Output"). O llm-output-validator.ts já rejeita com segurança qualquer
// saída fora do schema esperado antes de qualquer ação ser executada — a
// ausência de guided_json aqui não é um risco de segurança, só um provider
// potencialmente menos aderente ao formato, compensado pela validação local
// já existente.
import OpenAI, {
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import type { LlmInterpreterProvider, LlmProviderRequest } from "../llm-interpreter.types.ts";
import type { LlmVerbalizerProvider, LlmVerbalizerProviderRequest } from "../llm-verbalizer.ts";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "./openai-response-schema.ts";
import { VERBALIZER_RESPONSE_SCHEMA } from "./verbalizer-response-schema.ts";

// --- erro local ---------------------------------------------------------
// Apenas code + retryable: nunca prompt, chave ou resposta bruta do provider.

export type DeepseekLlmProviderErrorCode =
  | "DEEPSEEK_AUTHENTICATION"
  | "DEEPSEEK_RATE_LIMIT"
  | "DEEPSEEK_TIMEOUT"
  | "DEEPSEEK_SERVER_ERROR"
  | "DEEPSEEK_EMPTY_OUTPUT"
  | "DEEPSEEK_UNKNOWN"
  | "LOCAL_RATE_LIMIT"
  | "LOCAL_CONCURRENCY_LIMIT";

export class DeepseekLlmProviderError extends Error {
  readonly code: DeepseekLlmProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: DeepseekLlmProviderErrorCode, retryable: boolean) {
    super(`DeepseekLlmProviderError: ${code}`);
    this.name = "DeepseekLlmProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function mapProviderError(error: unknown): DeepseekLlmProviderError {
  if (error instanceof APIConnectionTimeoutError) return new DeepseekLlmProviderError("DEEPSEEK_TIMEOUT", true);
  if (error instanceof AuthenticationError) return new DeepseekLlmProviderError("DEEPSEEK_AUTHENTICATION", false);
  if (error instanceof RateLimitError) return new DeepseekLlmProviderError("DEEPSEEK_RATE_LIMIT", true);
  if (error instanceof InternalServerError) return new DeepseekLlmProviderError("DEEPSEEK_SERVER_ERROR", true);
  return new DeepseekLlmProviderError("DEEPSEEK_UNKNOWN", false);
}

// --- valores padrão ---------------------------------------------------------

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MAX_TOKENS = 2000;

// --- cliente injetável ----------------------------------------------------
// Only the slice of the OpenAI-compatible SDK this provider actually calls,
// so tests can inject a fake without touching the network.

type DeepseekChatCompletionLike = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type DeepseekChatCompletionRequest = {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  temperature: 0;
  max_tokens: number;
  response_format: { type: "json_object" };
};

export type DeepseekCompatibleClient = {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<DeepseekChatCompletionLike>;
    };
  };
};

export type CreateDeepseekLlmProviderInput = {
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxRequestsPerMinute?: number;
  maxConcurrentRequests?: number;
  client?: DeepseekCompatibleClient;
};

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 30;
const MAX_REQUESTS_PER_MINUTE_CEILING = 600;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const MAX_CONCURRENT_REQUESTS_CEILING = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

function validateLimit(value: unknown, defaultValue: number, ceiling: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new TypeError(`createDeepseekLlmProvider: ${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

function normalizeApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new TypeError("createDeepseekLlmProvider: apiKey must be a non-empty string");
  }
  return apiKey.trim();
}

function normalizeModel(model: unknown): string {
  if (model === undefined) return DEEPSEEK_DEFAULT_MODEL;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new TypeError("createDeepseekLlmProvider: model must be a non-empty string");
  }
  return model.trim();
}

function normalizeBaseURL(baseURL: unknown): string {
  if (baseURL === undefined) return DEEPSEEK_DEFAULT_BASE_URL;
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    throw new TypeError("createDeepseekLlmProvider: baseURL must be a non-empty string");
  }
  return baseURL.trim();
}

// --- prompt ------------------------------------------------------------
// A DeepSeek exige a palavra "json" (minúscula, per docs) em algum lugar do
// prompt quando response_format=json_object é usado, além de um exemplo do
// formato esperado — daí o texto explícito abaixo, em vez de só citar o
// nome do schema como o provider NVIDIA faz.

function buildSystemPrompt(systemPrompt: string, schemaName: string, schema: unknown): string {
  const serializedSchema = JSON.stringify(schema);
  return (
    `${systemPrompt}\n\n` +
    `Responda somente em json válido, sem texto adicional, sem markdown e sem comentários. ` +
    `O json deve respeitar exatamente o schema "${schemaName}" a seguir:\n${serializedSchema}`
  );
}

function createDeepseekStructuredProvider(input: CreateDeepseekLlmProviderInput, schema: unknown): { generateStructuredOutput(request: LlmProviderRequest | LlmVerbalizerProviderRequest): Promise<unknown> } {
  const apiKey = normalizeApiKey(input.apiKey);
  const model = normalizeModel(input.model);
  const baseURL = normalizeBaseURL(input.baseURL);
  const maxRequestsPerMinute = validateLimit(input.maxRequestsPerMinute, DEFAULT_MAX_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE_CEILING, "maxRequestsPerMinute");
  const maxConcurrentRequests = validateLimit(input.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS, MAX_CONCURRENT_REQUESTS_CEILING, "maxConcurrentRequests");
  const client: DeepseekCompatibleClient = input.client ?? (new OpenAI({ apiKey, baseURL }) as unknown as DeepseekCompatibleClient);
  let requestTimestamps: number[] = [];
  let activeRequestCount = 0;

  return {
    async generateStructuredOutput(request: LlmProviderRequest | LlmVerbalizerProviderRequest): Promise<unknown> {
      const { systemPrompt, userPrompt, schemaName } = request;
      const startedAt = Date.now();
      requestTimestamps = requestTimestamps.filter(timestamp => startedAt - timestamp < RATE_LIMIT_WINDOW_MS);
      if (requestTimestamps.length >= maxRequestsPerMinute) {
        throw new DeepseekLlmProviderError("LOCAL_RATE_LIMIT", true);
      }
      if (activeRequestCount >= maxConcurrentRequests) {
        throw new DeepseekLlmProviderError("LOCAL_CONCURRENCY_LIMIT", true);
      }
      requestTimestamps.push(startedAt);
      activeRequestCount += 1;

      try {
        let response: DeepseekChatCompletionLike;
        try {
          const requestBody: DeepseekChatCompletionRequest = {
            model,
            messages: [
              { role: "system", content: buildSystemPrompt(systemPrompt, schemaName, schema) },
              { role: "user", content: userPrompt },
            ],
            temperature: 0,
            max_tokens: DEEPSEEK_MAX_TOKENS,
            response_format: { type: "json_object" },
          };
          response = await client.chat.completions.create(requestBody);
        } catch (error) {
          throw mapProviderError(error);
        }

        const content = response?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim().length === 0) {
          throw new DeepseekLlmProviderError("DEEPSEEK_EMPTY_OUTPUT", true);
        }
        return content;
      } finally {
        activeRequestCount -= 1;
      }
    },
  };
}

export function createDeepseekLlmProvider(input: CreateDeepseekLlmProviderInput): LlmInterpreterProvider {
  return createDeepseekStructuredProvider(input, OPENAI_LLM_RESPONSE_SCHEMA);
}

export function createDeepseekVerbalizerProvider(input: CreateDeepseekLlmProviderInput): LlmVerbalizerProvider {
  return createDeepseekStructuredProvider(input, VERBALIZER_RESPONSE_SCHEMA);
}
