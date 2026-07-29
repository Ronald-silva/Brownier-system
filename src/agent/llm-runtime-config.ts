// Parser puro da configuração de runtime do fallback OpenAI. Só lê e valida
// um objeto de variáveis de ambiente explícito — nunca process.env
// diretamente — e devolve uma união discriminada por "mode". Não instancia
// provider, não conhece o simulador nem o Text Conversation Service, e não
// faz nenhuma chamada externa. Timeout, limite de tokens, limite de
// entrada, rate limit, concorrência e callback de usage ficam para
// microetapas posteriores.
export type LlmRuntimeConfig =
  | { mode: "DISABLED" }
  | {
      mode: "OPENAI_FALLBACK";
      openaiApiKey: string;
      openaiModel: string;
      maxRequestsPerMinute: number;
      maxConcurrentRequests: number;
    }
  | {
      mode: "NVIDIA_NEMOTRON";
      nvidiaApiKey: string;
      nvidiaModel: string;
      nvidiaBaseUrl: string;
    };

export type LlmRuntimeConfigErrorCode =
  | "INVALID_LLM_MODE"
  | "MISSING_OPENAI_API_KEY"
  | "MISSING_OPENAI_MODEL"
  | "INVALID_OPENAI_MODEL"
  | "INVALID_LLM_MAX_REQUESTS_PER_MINUTE"
  | "INVALID_LLM_MAX_CONCURRENT_REQUESTS"
  | "MISSING_NVIDIA_API_KEY"
  | "INVALID_NVIDIA_MODEL"
  | "INVALID_NVIDIA_BASE_URL";

// Mensagem nunca inclui o valor de nenhuma variável — só o nome da
// variável envolvida, quando ajuda a diagnosticar.
export class LlmRuntimeConfigError extends Error {
  readonly code: LlmRuntimeConfigErrorCode;

  constructor(code: LlmRuntimeConfigErrorCode, message: string) {
    super(message);
    this.name = "LlmRuntimeConfigError";
    this.code = code;
  }
}

const MAX_OPENAI_MODEL_LENGTH = 200;

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 30;
const MAX_REQUESTS_PER_MINUTE_CEILING = 600;

const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const MAX_CONCURRENT_REQUESTS_CEILING = 20;

const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

function trimOrEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoundedInteger(
  rawValue: string | undefined,
  defaultValue: number,
  ceiling: number,
  errorCode: LlmRuntimeConfigErrorCode,
  variableName: string,
): number {
  const trimmed = trimOrEmpty(rawValue);
  if (trimmed === "") {
    return defaultValue;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ceiling) {
    throw new LlmRuntimeConfigError(errorCode, `${variableName} contém um valor inválido`);
  }
  return parsed;
}

function readNvidiaApiKey(raw: string | undefined): string {
  if (raw !== undefined && typeof raw !== "string") {
    throw new LlmRuntimeConfigError("MISSING_NVIDIA_API_KEY", "NVIDIA_API_KEY é obrigatória quando BF_LLM_MODE=NVIDIA_NEMOTRON");
  }
  const trimmed = trimOrEmpty(raw);
  if (trimmed === "") {
    throw new LlmRuntimeConfigError("MISSING_NVIDIA_API_KEY", "NVIDIA_API_KEY é obrigatória quando BF_LLM_MODE=NVIDIA_NEMOTRON");
  }
  return trimmed;
}

function readNvidiaModel(raw: string | undefined): string {
  if (raw !== undefined && typeof raw !== "string") {
    throw new LlmRuntimeConfigError("INVALID_NVIDIA_MODEL", "NVIDIA_MODEL contém um valor inválido");
  }
  const trimmed = trimOrEmpty(raw);
  return trimmed === "" ? DEFAULT_NVIDIA_MODEL : trimmed;
}

function readNvidiaBaseUrl(raw: string | undefined): string {
  if (raw !== undefined && typeof raw !== "string") {
    throw new LlmRuntimeConfigError("INVALID_NVIDIA_BASE_URL", "NVIDIA_BASE_URL contém um valor inválido");
  }
  const trimmed = trimOrEmpty(raw);
  if (trimmed === "") {
    return DEFAULT_NVIDIA_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LlmRuntimeConfigError("INVALID_NVIDIA_BASE_URL", "NVIDIA_BASE_URL contém um valor inválido");
  }
  if (parsed.protocol !== "https:") {
    throw new LlmRuntimeConfigError("INVALID_NVIDIA_BASE_URL", "NVIDIA_BASE_URL contém um valor inválido");
  }
  return trimmed;
}

export function readLlmRuntimeConfig(env: Record<string, string | undefined>): LlmRuntimeConfig {
  const mode = trimOrEmpty(env.BF_LLM_MODE);

  if (mode === "" || mode === "DISABLED") {
    return { mode: "DISABLED" };
  }
  if (mode === "NVIDIA_NEMOTRON") {
    const nvidiaApiKey = readNvidiaApiKey(env.NVIDIA_API_KEY);
    const nvidiaModel = readNvidiaModel(env.NVIDIA_MODEL);
    const nvidiaBaseUrl = readNvidiaBaseUrl(env.NVIDIA_BASE_URL);
    return { mode: "NVIDIA_NEMOTRON", nvidiaApiKey, nvidiaModel, nvidiaBaseUrl };
  }
  if (mode !== "OPENAI_FALLBACK") {
    throw new LlmRuntimeConfigError("INVALID_LLM_MODE", "BF_LLM_MODE contém um valor não reconhecido");
  }

  const openaiApiKey = trimOrEmpty(env.OPENAI_API_KEY);
  if (openaiApiKey === "") {
    throw new LlmRuntimeConfigError("MISSING_OPENAI_API_KEY", "OPENAI_API_KEY é obrigatória quando BF_LLM_MODE=OPENAI_FALLBACK");
  }

  const openaiModel = trimOrEmpty(env.OPENAI_MODEL);
  if (openaiModel === "") {
    throw new LlmRuntimeConfigError("MISSING_OPENAI_MODEL", "OPENAI_MODEL é obrigatório quando BF_LLM_MODE=OPENAI_FALLBACK");
  }
  if (openaiModel.length > MAX_OPENAI_MODEL_LENGTH) {
    throw new LlmRuntimeConfigError("INVALID_OPENAI_MODEL", `OPENAI_MODEL excede o tamanho máximo de ${MAX_OPENAI_MODEL_LENGTH} caracteres`);
  }

  const maxRequestsPerMinute = readBoundedInteger(
    env.BF_LLM_MAX_REQUESTS_PER_MINUTE,
    DEFAULT_MAX_REQUESTS_PER_MINUTE,
    MAX_REQUESTS_PER_MINUTE_CEILING,
    "INVALID_LLM_MAX_REQUESTS_PER_MINUTE",
    "BF_LLM_MAX_REQUESTS_PER_MINUTE",
  );

  const maxConcurrentRequests = readBoundedInteger(
    env.BF_LLM_MAX_CONCURRENT_REQUESTS,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    MAX_CONCURRENT_REQUESTS_CEILING,
    "INVALID_LLM_MAX_CONCURRENT_REQUESTS",
    "BF_LLM_MAX_CONCURRENT_REQUESTS",
  );

  return { mode: "OPENAI_FALLBACK", openaiApiKey, openaiModel, maxRequestsPerMinute, maxConcurrentRequests };
}
