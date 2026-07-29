// Smoke test manual e opcional do provider OpenAI contra a API real.
// Nunca roda em npm test, npm run build, lint ou CI — só quando alguém
// executa `npm run agent:smoke:openai` explicitamente com
// BF_LLM_LIVE_SMOKE=YES. Sem essa flag, sai sem criar cliente OpenAI e sem
// chamar a API. Reaproveita readLlmRuntimeConfig() para OPENAI_API_KEY e
// OPENAI_MODEL e createOpenAiLlmProvider() exatamente como já existem —
// nenhuma validação é duplicada aqui.
import { readLlmRuntimeConfig, LlmRuntimeConfigError } from "../src/agent/llm-runtime-config.ts";
import { createOpenAiLlmProvider, OpenAiLlmProviderError } from "../src/agent/providers/openai-llm-provider.ts";
import type { LlmProviderUsage } from "../src/agent/providers/llm-provider-usage.ts";

async function main(): Promise<void> {
  if (process.env.BF_LLM_LIVE_SMOKE !== "YES") {
    console.log("Smoke test do provider OpenAI desativado. Defina BF_LLM_LIVE_SMOKE=YES para executar.");
    return;
  }

  // BF_LLM_MODE é forçado aqui só para reaproveitar a validação de
  // OPENAI_API_KEY/OPENAI_MODEL já existente em readLlmRuntimeConfig() —
  // este smoke test não depende do modo de runtime configurado.
  const config = readLlmRuntimeConfig({ ...process.env, BF_LLM_MODE: "OPENAI_FALLBACK" });
  if (config.mode !== "OPENAI_FALLBACK") {
    return;
  }

  let usage: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    onUsage: (received) => {
      usage = received;
    },
  });

  const outputText = await provider.generateStructuredOutput({
    systemPrompt: "Você interpreta pedidos de brownies.",
    userPrompt: "Quero um brownie.",
    schemaName: "llm_interpreter_output_v1",
  });

  const parsed = JSON.parse(String(outputText)) as { status?: unknown; actions?: unknown[] };
  const actionsCount = Array.isArray(parsed.actions) ? parsed.actions.length : 0;

  console.log(`Status: ${String(parsed.status)}`);
  console.log(`Actions: ${actionsCount}`);
  console.log(`Modelo: ${usage?.model ?? config.openaiModel}`);
  if (usage?.inputTokens !== undefined) console.log(`Input tokens: ${usage.inputTokens}`);
  if (usage?.outputTokens !== undefined) console.log(`Output tokens: ${usage.outputTokens}`);
  if (usage?.totalTokens !== undefined) console.log(`Total tokens: ${usage.totalTokens}`);
  console.log(`Tempo: ${usage?.durationMs ?? "desconhecido"}ms`);
}

main().catch((error: unknown) => {
  if (error instanceof OpenAiLlmProviderError) {
    console.log(`Erro do provider — code: ${error.code}, retryable: ${error.retryable}, mensagem: ${error.message}`);
  } else if (error instanceof LlmRuntimeConfigError) {
    console.log(`Erro de configuração — code: ${error.code}, mensagem: ${error.message}`);
  } else {
    console.log("Erro inesperado ao executar o smoke test.");
  }
  process.exitCode = 1;
});
