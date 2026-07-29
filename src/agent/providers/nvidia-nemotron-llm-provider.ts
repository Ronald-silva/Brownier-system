// Adaptador NVIDIA Nemotron para o contrato LlmInterpreterProvider — chama a
// API compatível com OpenAI Chat Completions exposta pela NVIDIA (NIM) e
// devolve apenas o texto final. Não decide nada sobre a conversa: quem
// valida a saída continua sendo o llm-output-validator.ts. Nesta etapa o
// provider não é ligado ao runtime, ao simulador nem a nenhuma variável de
// ambiente — é infraestrutura isolada, testável com um cliente fake.
import OpenAI, {
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import type { LlmInterpreterProvider, LlmProviderRequest } from "../llm-interpreter.types.ts";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "./openai-response-schema.ts";

// --- erro local ---------------------------------------------------------
// Apenas code + retryable: nunca prompt, chave ou resposta bruta do provider.

export type NvidiaNemotronLlmProviderErrorCode =
  | "NVIDIA_AUTHENTICATION"
  | "NVIDIA_RATE_LIMIT"
  | "NVIDIA_TIMEOUT"
  | "NVIDIA_SERVER_ERROR"
  | "NVIDIA_EMPTY_OUTPUT"
  | "NVIDIA_UNKNOWN";

export class NvidiaNemotronLlmProviderError extends Error {
  readonly code: NvidiaNemotronLlmProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: NvidiaNemotronLlmProviderErrorCode, retryable: boolean) {
    super(`NvidiaNemotronLlmProviderError: ${code}`);
    this.name = "NvidiaNemotronLlmProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function mapProviderError(error: unknown): NvidiaNemotronLlmProviderError {
  if (error instanceof APIConnectionTimeoutError) return new NvidiaNemotronLlmProviderError("NVIDIA_TIMEOUT", true);
  if (error instanceof AuthenticationError) return new NvidiaNemotronLlmProviderError("NVIDIA_AUTHENTICATION", false);
  if (error instanceof RateLimitError) return new NvidiaNemotronLlmProviderError("NVIDIA_RATE_LIMIT", true);
  if (error instanceof InternalServerError) return new NvidiaNemotronLlmProviderError("NVIDIA_SERVER_ERROR", true);
  return new NvidiaNemotronLlmProviderError("NVIDIA_UNKNOWN", false);
}

// --- valores padrão ---------------------------------------------------------

export const NVIDIA_NEMOTRON_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const NVIDIA_NEMOTRON_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

// --- cliente injetável ----------------------------------------------------
// Only the slice of the OpenAI-compatible SDK this provider actually calls,
// so tests can inject a fake without touching the network.

type NvidiaChatCompletionLike = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

// Campos adicionais aceitos pelo endpoint OpenAI-compatible do NVIDIA NIM.
// Este tipo fica restrito ao adapter porque chat_template_kwargs e guided_json
// não fazem parte do contrato público do SDK OpenAI.
type NvidiaChatCompletionRequest = {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  temperature: 0;
  chat_template_kwargs: {
    enable_thinking: false;
  };
  guided_json: typeof OPENAI_LLM_RESPONSE_SCHEMA;
};

export type NvidiaCompatibleClient = {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<NvidiaChatCompletionLike>;
    };
  };
};

export type CreateNvidiaNemotronLlmProviderInput = {
  apiKey: string;
  model?: string;
  baseURL?: string;
  client?: NvidiaCompatibleClient;
};

function normalizeApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new TypeError("createNvidiaNemotronLlmProvider: apiKey must be a non-empty string");
  }
  return apiKey.trim();
}

function normalizeModel(model: unknown): string {
  if (model === undefined) return NVIDIA_NEMOTRON_DEFAULT_MODEL;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new TypeError("createNvidiaNemotronLlmProvider: model must be a non-empty string");
  }
  return model.trim();
}

function normalizeBaseURL(baseURL: unknown): string {
  if (baseURL === undefined) return NVIDIA_NEMOTRON_DEFAULT_BASE_URL;
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    throw new TypeError("createNvidiaNemotronLlmProvider: baseURL must be a non-empty string");
  }
  return baseURL.trim();
}

// --- prompt ------------------------------------------------------------

function buildSystemPrompt(systemPrompt: string, schemaName: string): string {
  const serializedSchema = JSON.stringify(OPENAI_LLM_RESPONSE_SCHEMA);
  return (
    `${systemPrompt}\n\n` +
    `A resposta deve conter somente JSON válido, sem texto adicional, sem markdown e sem comentários. ` +
    `O JSON deve respeitar exatamente o schema "${schemaName}" a seguir:\n${serializedSchema}`
  );
}

export function createNvidiaNemotronLlmProvider(
  input: CreateNvidiaNemotronLlmProviderInput,
): LlmInterpreterProvider {
  const apiKey = normalizeApiKey(input.apiKey);
  const model = normalizeModel(input.model);
  const baseURL = normalizeBaseURL(input.baseURL);
  const client: NvidiaCompatibleClient = input.client ?? (new OpenAI({ apiKey, baseURL }) as unknown as NvidiaCompatibleClient);

  return {
    async generateStructuredOutput(request: LlmProviderRequest): Promise<unknown> {
      const { systemPrompt, userPrompt, schemaName } = request;

      let response: NvidiaChatCompletionLike;
      try {
        const requestBody: NvidiaChatCompletionRequest = {
          model,
          messages: [
            { role: "system", content: buildSystemPrompt(systemPrompt, schemaName) },
            { role: "user", content: userPrompt },
          ],
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
          guided_json: OPENAI_LLM_RESPONSE_SCHEMA,
        };
        response = await client.chat.completions.create(requestBody);
      } catch (error) {
        throw mapProviderError(error);
      }

      const content = response?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new NvidiaNemotronLlmProviderError("NVIDIA_EMPTY_OUTPUT", true);
      }

      return content;
    },
  };
}
