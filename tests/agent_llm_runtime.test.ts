import assert from "node:assert/strict";
import test from "node:test";
import { resolveLlmRuntime } from "../src/agent/llm-runtime.ts";
import { LlmRuntimeConfigError } from "../src/agent/llm-runtime-config.ts";
import type { OpenAiResponsesClient } from "../src/agent/providers/openai-llm-provider.ts";
import { NvidiaNemotronLlmProviderError } from "../src/agent/providers/nvidia-nemotron-llm-provider.ts";
import type { NvidiaCompatibleClient } from "../src/agent/providers/nvidia-nemotron-llm-provider.ts";
import { DeepseekLlmProviderError } from "../src/agent/providers/deepseek-llm-provider.ts";
import type { DeepseekCompatibleClient } from "../src/agent/providers/deepseek-llm-provider.ts";

type Env = Record<string, string | undefined>;

function validFallbackEnv(overrides: Env = {}): Env {
  return {
    BF_LLM_MODE: "OPENAI_FALLBACK",
    OPENAI_API_KEY: "sk-test-not-a-real-key",
    OPENAI_MODEL: "gpt-test-model",
    ...overrides,
  };
}

function validNvidiaEnv(overrides: Env = {}): Env {
  return {
    BF_LLM_MODE: "NVIDIA_NEMOTRON",
    NVIDIA_API_KEY: "nvapi-test-not-a-real-key",
    NVIDIA_MODEL: "nvidia/test-model",
    NVIDIA_BASE_URL: "https://nvidia.example.com/v1",
    ...overrides,
  };
}

function validDeepseekEnv(overrides: Env = {}): Env {
  return {
    BF_LLM_MODE: "DEEPSEEK_FALLBACK",
    DEEPSEEK_API_KEY: "sk-deepseek-test-not-a-real-key",
    ...overrides,
  };
}

class FakeOpenAiClient implements OpenAiResponsesClient {
  calls: Record<string, unknown>[] = [];
  responses: { create(params: Record<string, unknown>): Promise<{ output_text?: string | null }> };

  constructor(outputText: string) {
    this.responses = {
      create: async (params: Record<string, unknown>) => {
        this.calls.push(params);
        return { output_text: outputText };
      },
    };
  }
}

class FakeNvidiaClient implements NvidiaCompatibleClient {
  calls: Record<string, unknown>[] = [];
  chat: NvidiaCompatibleClient["chat"];

  constructor(outputText: string) {
    this.chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          this.calls.push(params);
          return { choices: [{ message: { content: outputText } }] };
        },
      },
    };
  }
}

class ThrowingFakeNvidiaClient implements NvidiaCompatibleClient {
  calls: Record<string, unknown>[] = [];
  chat: NvidiaCompatibleClient["chat"];

  constructor(error: Error) {
    this.chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          this.calls.push(params);
          throw error;
        },
      },
    };
  }
}

class FakeDeepseekClient implements DeepseekCompatibleClient {
  calls: Record<string, unknown>[] = [];
  chat: DeepseekCompatibleClient["chat"];

  constructor(outputText: string) {
    this.chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          this.calls.push(params);
          return { choices: [{ message: { content: outputText } }] };
        },
      },
    };
  }
}

test("env vazio resolve para DISABLED sem cliente OpenAI", () => {
  const runtime = resolveLlmRuntime({ env: {} });
  assert.deepEqual(runtime, { llmMode: "DISABLED" });
});

test("BF_LLM_MODE=DISABLED resolve para DISABLED mesmo com openAiClient fornecido", () => {
  const client = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: { BF_LLM_MODE: "DISABLED" }, openAiClient: client });
  assert.deepEqual(runtime, { llmMode: "DISABLED" });
  assert.equal(client.calls.length, 0);
});

test("OPENAI_FALLBACK válido resolve para FALLBACK com um llmInterpreter", () => {
  const client = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validFallbackEnv(), openAiClient: client });
  assert.equal(runtime.llmMode, "FALLBACK");
  assert.equal(typeof (runtime as { llmInterpreter: { interpret: unknown } }).llmInterpreter.interpret, "function");
});

test("OPENAI_FALLBACK sem chave lança LlmRuntimeConfigError antes de criar qualquer provider", () => {
  assert.throws(
    () => resolveLlmRuntime({ env: validFallbackEnv({ OPENAI_API_KEY: undefined }) }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "MISSING_OPENAI_API_KEY");
      return true;
    },
  );
});

test("OPENAI_FALLBACK sem modelo lança LlmRuntimeConfigError", () => {
  assert.throws(
    () => resolveLlmRuntime({ env: validFallbackEnv({ OPENAI_MODEL: undefined }) }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "MISSING_OPENAI_MODEL");
      return true;
    },
  );
});

test("modo desconhecido lança LlmRuntimeConfigError", () => {
  assert.throws(
    () => resolveLlmRuntime({ env: { BF_LLM_MODE: "OPENAI" } }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "INVALID_LLM_MODE");
      return true;
    },
  );
});

test("cliente fake injetado é usado pelo provider quando o interpreter chama o LLM", async () => {
  const client = new FakeOpenAiClient(
    '{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}',
  );
  const runtime = resolveLlmRuntime({ env: validFallbackEnv(), openAiClient: client });
  assert.equal(runtime.llmMode, "FALLBACK");
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  const result = await runtime.llmInterpreter.interpret({
    text: "algo que o determinístico não entendeu",
    session: {
      sessionKey: "simulator:c1",
      channel: "simulator",
      contactId: "c1",
      step: "BUILDING_ORDER",
      items: [],
      processedMessageIds: [],
      underHumanHandoff: false,
      misunderstandingCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
    },
  });

  assert.equal(client.calls.length, 1);
  assert.equal(result.status, "NOT_UNDERSTOOD");
});

function buildSession() {
  return {
    sessionKey: "simulator:c1",
    channel: "simulator",
    contactId: "c1",
    step: "BUILDING_ORDER" as const,
    items: [],
    processedMessageIds: [],
    underHumanHandoff: false,
    misunderstandingCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:00.000Z",
  };
}

test("OPENAI_FALLBACK repassa BF_LLM_MAX_REQUESTS_PER_MINUTE ao provider", async () => {
  const client = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({
    env: validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "1" }),
    openAiClient: client,
  });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  const first = await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });
  const second = await runtime.llmInterpreter.interpret({ text: "oi de novo", session: buildSession() });

  assert.equal(first.status, "NOT_UNDERSTOOD");
  assert.equal(second.status, "PROVIDER_ERROR");
});

test("OPENAI_FALLBACK repassa BF_LLM_MAX_CONCURRENT_REQUESTS ao provider", async () => {
  const client = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({
    env: validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "1" }),
    openAiClient: client,
  });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  const firstPromise = runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });
  const secondPromise = runtime.llmInterpreter.interpret({ text: "oi de novo", session: buildSession() });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.status, "NOT_UNDERSTOOD");
  assert.equal(second.status, "PROVIDER_ERROR");
});

test("ambos os limites chegam intactos ao provider (sem transformação)", async () => {
  const client = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({
    env: validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "3", BF_LLM_MAX_CONCURRENT_REQUESTS: "3" }),
    openAiClient: client,
  });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  const results = await Promise.all([
    runtime.llmInterpreter.interpret({ text: "1", session: buildSession() }),
    runtime.llmInterpreter.interpret({ text: "2", session: buildSession() }),
    runtime.llmInterpreter.interpret({ text: "3", session: buildSession() }),
    runtime.llmInterpreter.interpret({ text: "4", session: buildSession() }),
  ]);

  assert.deepEqual(
    results.map((result) => result.status),
    ["NOT_UNDERSTOOD", "NOT_UNDERSTOOD", "NOT_UNDERSTOOD", "PROVIDER_ERROR"],
  );
});

test("DISABLED continua sem criar provider mesmo com os novos limites presentes no env", () => {
  const client = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({
    env: { BF_LLM_MODE: "DISABLED", BF_LLM_MAX_REQUESTS_PER_MINUTE: "1", BF_LLM_MAX_CONCURRENT_REQUESTS: "1" },
    openAiClient: client,
  });
  assert.deepEqual(runtime, { llmMode: "DISABLED" });
  assert.equal(client.calls.length, 0);
});

test("OPENAI_FALLBACK com limite inválido lança LlmRuntimeConfigError vinda de readLlmRuntimeConfig", () => {
  assert.throws(
    () => resolveLlmRuntime({ env: validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "0" }) }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
      return true;
    },
  );
});

test("duas chamadas a resolveLlmRuntime não compartilham estado (cada uma cria seu próprio provider/interpreter)", () => {
  const clientA = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const clientB = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtimeA = resolveLlmRuntime({ env: validFallbackEnv(), openAiClient: clientA });
  const runtimeB = resolveLlmRuntime({ env: validFallbackEnv(), openAiClient: clientB });
  assert.notEqual(runtimeA, runtimeB);
  if (runtimeA.llmMode === "FALLBACK" && runtimeB.llmMode === "FALLBACK") {
    assert.notEqual(runtimeA.llmInterpreter, runtimeB.llmInterpreter);
  }
});

test("BF_LLM_MODE=DISABLED resolve para DISABLED mesmo com nvidiaClient fornecido", () => {
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: { BF_LLM_MODE: "DISABLED" }, nvidiaClient });
  assert.deepEqual(runtime, { llmMode: "DISABLED" });
  assert.equal(nvidiaClient.calls.length, 0);
});

test("OPENAI_FALLBACK usa somente openAiClient, nunca nvidiaClient", async () => {
  const openAiClient = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validFallbackEnv(), openAiClient, nvidiaClient });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });

  assert.equal(openAiClient.calls.length, 1);
  assert.equal(nvidiaClient.calls.length, 0);
});

test("NVIDIA_NEMOTRON válido resolve para NVIDIA_NEMOTRON com um llmInterpreter", () => {
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validNvidiaEnv(), nvidiaClient });
  assert.equal(runtime.llmMode, "NVIDIA_NEMOTRON");
  assert.equal(typeof (runtime as { llmInterpreter: { interpret: unknown } }).llmInterpreter.interpret, "function");
});

test("NVIDIA_NEMOTRON usa somente nvidiaClient, nunca openAiClient", async () => {
  const openAiClient = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validNvidiaEnv(), openAiClient, nvidiaClient });
  if (runtime.llmMode !== "NVIDIA_NEMOTRON") throw new Error("unreachable");

  const result = await runtime.llmInterpreter.interpret({ text: "algo", session: buildSession() });

  assert.equal(nvidiaClient.calls.length, 1);
  assert.equal(openAiClient.calls.length, 0);
  assert.equal(result.status, "NOT_UNDERSTOOD");
});

test("NVIDIA_NEMOTRON repassa nvidiaApiKey, nvidiaModel e nvidiaBaseUrl ao provider", async () => {
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({
    env: validNvidiaEnv({ NVIDIA_MODEL: "nvidia/custom-model" }),
    nvidiaClient,
  });
  if (runtime.llmMode !== "NVIDIA_NEMOTRON") throw new Error("unreachable");

  await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });

  assert.equal(nvidiaClient.calls.length, 1);
  assert.equal(nvidiaClient.calls[0].model, "nvidia/custom-model");
});

test("NVIDIA_NEMOTRON sem NVIDIA_API_KEY lança LlmRuntimeConfigError antes de criar qualquer provider", () => {
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  assert.throws(
    () => resolveLlmRuntime({ env: validNvidiaEnv({ NVIDIA_API_KEY: undefined }), nvidiaClient }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "MISSING_NVIDIA_API_KEY");
      return true;
    },
  );
  assert.equal(nvidiaClient.calls.length, 0);
});

test("erro do provider NVIDIA é preservado como PROVIDER_ERROR pelo llmInterpreter", async () => {
  const nvidiaClient = new ThrowingFakeNvidiaClient(new NvidiaNemotronLlmProviderError("NVIDIA_UNKNOWN", false));
  const runtime = resolveLlmRuntime({ env: validNvidiaEnv(), nvidiaClient });
  if (runtime.llmMode !== "NVIDIA_NEMOTRON") throw new Error("unreachable");

  const result = await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });

  assert.equal(result.status, "PROVIDER_ERROR");
});

test("NVIDIA_NEMOTRON sem nvidiaClient injetado ainda resolve o runtime (cliente oficial só seria usado em chamada real)", () => {
  const runtime = resolveLlmRuntime({ env: validNvidiaEnv() });
  assert.equal(runtime.llmMode, "NVIDIA_NEMOTRON");
});

// --- DEEPSEEK_FALLBACK -------------------------------------------------

test("DEEPSEEK_FALLBACK válido resolve para FALLBACK com um llmInterpreter", () => {
  const client = new FakeDeepseekClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validDeepseekEnv(), deepseekClient: client });
  assert.equal(runtime.llmMode, "FALLBACK");
  assert.equal(typeof (runtime as { llmInterpreter: { interpret: unknown } }).llmInterpreter.interpret, "function");
});

test("DEEPSEEK_FALLBACK sem chave lança LlmRuntimeConfigError antes de criar qualquer provider", () => {
  const client = new FakeDeepseekClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  assert.throws(
    () => resolveLlmRuntime({ env: validDeepseekEnv({ DEEPSEEK_API_KEY: undefined }), deepseekClient: client }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "MISSING_DEEPSEEK_API_KEY");
      return true;
    },
  );
  assert.equal(client.calls.length, 0);
});

test("DEEPSEEK_FALLBACK sem modelo usa o padrão deepseek-chat, não lança erro", () => {
  const client = new FakeDeepseekClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validDeepseekEnv({ DEEPSEEK_MODEL: undefined }), deepseekClient: client });
  assert.equal(runtime.llmMode, "FALLBACK");
});

test("DEEPSEEK_FALLBACK repassa o modelo customizado ao provider", async () => {
  const client = new FakeDeepseekClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validDeepseekEnv({ DEEPSEEK_MODEL: "deepseek-reasoner" }), deepseekClient: client });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]!["model"], "deepseek-reasoner");
});

test("DEEPSEEK_FALLBACK repassa BF_LLM_MAX_REQUESTS_PER_MINUTE ao provider", async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const client = new FakeDeepseekClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
    const runtime = resolveLlmRuntime({ env: validDeepseekEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "1" }), deepseekClient: client });
    if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

    await runtime.llmInterpreter.interpret({ text: "1", session: buildSession() });
    const second = await runtime.llmInterpreter.interpret({ text: "2", session: buildSession() });

    assert.equal(second.status, "PROVIDER_ERROR");
  } finally {
    Date.now = originalNow;
  }
});

test("DEEPSEEK_FALLBACK com limite inválido lança LlmRuntimeConfigError vinda de readLlmRuntimeConfig", () => {
  assert.throws(
    () => resolveLlmRuntime({ env: validDeepseekEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "0" }) }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.code, "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
      return true;
    },
  );
});

test("DEEPSEEK_FALLBACK usa somente deepseekClient, nunca nvidiaClient nem openAiClient", async () => {
  const deepseekClient = new FakeDeepseekClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const nvidiaClient = new FakeNvidiaClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":"GENERIC","suggestions":[]}');
  const openAiClient = new FakeOpenAiClient('{"status":"NOT_UNDERSTOOD","actions":[],"reason":null,"suggestions":[]}');
  const runtime = resolveLlmRuntime({ env: validDeepseekEnv(), deepseekClient, nvidiaClient, openAiClient });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });

  assert.equal(deepseekClient.calls.length, 1);
  assert.equal(nvidiaClient.calls.length, 0);
  assert.equal(openAiClient.calls.length, 0);
});

test("erro do provider DeepSeek é preservado como PROVIDER_ERROR pelo llmInterpreter", async () => {
  const throwingClient: DeepseekCompatibleClient = {
    chat: {
      completions: {
        create: async () => {
          throw new DeepseekLlmProviderError("DEEPSEEK_UNKNOWN", false);
        },
      },
    },
  };
  const runtime = resolveLlmRuntime({ env: validDeepseekEnv(), deepseekClient: throwingClient });
  if (runtime.llmMode !== "FALLBACK") throw new Error("unreachable");

  const result = await runtime.llmInterpreter.interpret({ text: "oi", session: buildSession() });

  assert.equal(result.status, "PROVIDER_ERROR");
});

test("DEEPSEEK_FALLBACK sem deepseekClient injetado ainda resolve o runtime (cliente oficial só seria usado em chamada real)", () => {
  const runtime = resolveLlmRuntime({ env: validDeepseekEnv() });
  assert.equal(runtime.llmMode, "FALLBACK");
});
