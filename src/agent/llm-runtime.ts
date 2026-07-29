// Ponte entre a configuração de runtime (llm-runtime-config.ts) e as duas
// peças de infraestrutura que ela liga sob demanda: o provider OpenAI e o
// LLM Interpreter já existentes. Não conhece Tools, Session Store,
// Conversation Service nem Engine — devolve só { llmMode, llmInterpreter? }
// para quem for injetar isso no Text Conversation Service (hoje, o
// simulador). Em DISABLED, nenhum provider é criado.
import { readLlmRuntimeConfig } from "./llm-runtime-config.ts";
import { createOpenAiLlmProvider } from "./providers/openai-llm-provider.ts";
import type { OpenAiResponsesClient } from "./providers/openai-llm-provider.ts";
import { createNvidiaNemotronLlmProvider } from "./providers/nvidia-nemotron-llm-provider.ts";
import type { NvidiaCompatibleClient } from "./providers/nvidia-nemotron-llm-provider.ts";
import { createLlmInterpreter } from "./llm-interpreter.ts";
import type { LlmInterpreter } from "./llm-interpreter.types.ts";

export type LlmRuntime =
  | { llmMode: "DISABLED" }
  | { llmMode: "FALLBACK"; llmInterpreter: LlmInterpreter }
  | { llmMode: "NVIDIA_NEMOTRON"; llmInterpreter: LlmInterpreter };

export type ResolveLlmRuntimeInput = {
  env: Record<string, string | undefined>;
  // Só para testes: quando ausente, createOpenAiLlmProvider/
  // createNvidiaNemotronLlmProvider criam o cliente oficial do SDK (rede
  // real). Nunca exposto de volta no retorno.
  openAiClient?: OpenAiResponsesClient;
  nvidiaClient?: NvidiaCompatibleClient;
};

export function resolveLlmRuntime(input: ResolveLlmRuntimeInput): LlmRuntime {
  const config = readLlmRuntimeConfig(input.env);

  if (config.mode === "DISABLED") {
    return { llmMode: "DISABLED" };
  }

  if (config.mode === "OPENAI_FALLBACK") {
    const provider = createOpenAiLlmProvider({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      maxConcurrentRequests: config.maxConcurrentRequests,
      client: input.openAiClient,
    });
    const llmInterpreter = createLlmInterpreter({ provider });

    return { llmMode: "FALLBACK", llmInterpreter };
  }

  if (config.mode === "NVIDIA_NEMOTRON") {
    const provider = createNvidiaNemotronLlmProvider({
      apiKey: config.nvidiaApiKey,
      model: config.nvidiaModel,
      baseURL: config.nvidiaBaseUrl,
      client: input.nvidiaClient,
    });
    const llmInterpreter = createLlmInterpreter({ provider });

    return { llmMode: "NVIDIA_NEMOTRON", llmInterpreter };
  }

  throw new Error("resolveLlmRuntime: modo de LLM não tratado");
}
