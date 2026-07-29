// Smoke manual do caminho NVIDIA completo. Só pode fazer rede quando a flag
// explícita BF_LLM_LIVE_SMOKE for exatamente YES.
import { readLlmRuntimeConfig, LlmRuntimeConfigError } from "../src/agent/llm-runtime-config.ts";
import { resolveLlmRuntime } from "../src/agent/llm-runtime.ts";

function printError(input: {
  step: string;
  code?: string;
  retryable?: boolean;
  className?: "LlmRuntimeConfigError";
}): void {
  console.log("status: ERROR");
  console.log(`step: ${input.step}`);
  if (input.code !== undefined) console.log(`code: ${input.code}`);
  if (input.retryable !== undefined) console.log(`retryable: ${input.retryable}`);
  if (input.className !== undefined) console.log(`class: ${input.className}`);
}

async function main(): Promise<void> {
  if (process.env.BF_LLM_LIVE_SMOKE !== "YES") {
    printError({ step: "LIVE_SMOKE_DISABLED" });
    process.exitCode = 1;
    return;
  }

  let config: ReturnType<typeof readLlmRuntimeConfig>;
  try {
    config = readLlmRuntimeConfig(process.env);
  } catch (error) {
    if (error instanceof LlmRuntimeConfigError) {
      printError({ step: "CONFIGURATION", code: error.code, className: "LlmRuntimeConfigError" });
    } else {
      printError({ step: "CONFIGURATION" });
    }
    process.exitCode = 1;
    return;
  }

  if (config.mode !== "NVIDIA_NEMOTRON") {
    printError({ step: "EXPECTED_NVIDIA_NEMOTRON" });
    process.exitCode = 1;
    return;
  }

  let runtime: ReturnType<typeof resolveLlmRuntime>;
  try {
    runtime = resolveLlmRuntime({ env: process.env });
  } catch (error) {
    if (error instanceof LlmRuntimeConfigError) {
      printError({ step: "RUNTIME_INITIALIZATION", code: error.code, className: "LlmRuntimeConfigError" });
    } else {
      printError({ step: "RUNTIME_INITIALIZATION" });
    }
    process.exitCode = 1;
    return;
  }

  if (runtime.llmMode !== "NVIDIA_NEMOTRON") {
    printError({ step: "EXPECTED_NVIDIA_NEMOTRON" });
    process.exitCode = 1;
    return;
  }

  const startedAt = performance.now();
  const result = await runtime.llmInterpreter.interpret({
    text: "Quero iniciar uma conversa para montar um pedido de brownies.",
    session: {
      sessionKey: "smoke:nvidia",
      channel: "smoke",
      contactId: "nvidia-smoke",
      step: "START",
      items: [],
      processedMessageIds: [],
      underHumanHandoff: false,
      misunderstandingCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:30:00.000Z",
    },
  });
  const durationMs = Math.round(performance.now() - startedAt);

  if (result.status === "PROVIDER_ERROR") {
    printError({ step: "INTERPRETATION", code: result.reason, retryable: result.retryable });
    process.exitCode = 1;
    return;
  }
  if (result.status === "REJECTED") {
    printError({ step: "INTERPRETER_VALIDATION", code: "REJECTED_BY_VALIDATOR" });
    process.exitCode = 1;
    return;
  }

  const actionsCount = result.status === "MATCHED" ? result.actions.length : 0;
  console.log("status: SUCCESS");
  console.log("provider: NVIDIA_NEMOTRON");
  console.log(`model: ${config.nvidiaModel}`);
  console.log(`interpretation: ${result.status}`);
  console.log(`actions: ${actionsCount}`);
  console.log(`durationMs: ${durationMs}`);
  console.log("interpreter: PASSED");
}

main().catch(() => {
  printError({ step: "UNEXPECTED" });
  process.exitCode = 1;
});
