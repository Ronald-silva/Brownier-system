import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  AuthenticationError,
  RateLimitError,
  InternalServerError,
  APIConnectionTimeoutError,
} from "openai";
import {
  createNvidiaNemotronLlmProvider,
  NvidiaNemotronLlmProviderError,
  NVIDIA_NEMOTRON_DEFAULT_MODEL,
  NVIDIA_NEMOTRON_DEFAULT_BASE_URL,
} from "../src/agent/providers/nvidia-nemotron-llm-provider.ts";
import type { NvidiaCompatibleClient } from "../src/agent/providers/nvidia-nemotron-llm-provider.ts";
import type { LlmProviderRequest } from "../src/agent/llm-interpreter.types.ts";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "../src/agent/providers/openai-response-schema.ts";

const FAKE_API_KEY = "nvapi-test-not-a-real-key";

class FakeNvidiaClient implements NvidiaCompatibleClient {
  calls: Record<string, unknown>[] = [];
  chat: NvidiaCompatibleClient["chat"];

  constructor(impl: (params: Record<string, unknown>) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>) {
    this.chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          this.calls.push(params);
          return impl(params);
        },
      },
    };
  }
}

function fixedClient(content: string | null | undefined): FakeNvidiaClient {
  return new FakeNvidiaClient(async () => ({ choices: [{ message: { content } }] }));
}

function throwingClient(error: unknown): FakeNvidiaClient {
  return new FakeNvidiaClient(async () => {
    throw error;
  });
}

const BASE_REQUEST: LlmProviderRequest = {
  systemPrompt: "system instructions",
  userPrompt: "user message",
  schemaName: "llm_interpreter_output_v1",
};

// --- modelo e base URL padrão -----------------------------------------------

test("uses the default model when none is provided", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], NVIDIA_NEMOTRON_DEFAULT_MODEL);
  assert.equal(NVIDIA_NEMOTRON_DEFAULT_MODEL, "nvidia/nemotron-3-ultra-550b-a55b");
});

test("constructing without an injected client uses the default base URL and never touches the network", () => {
  assert.doesNotThrow(() => {
    createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY });
  });
  assert.equal(NVIDIA_NEMOTRON_DEFAULT_BASE_URL, "https://integrate.api.nvidia.com/v1");
});

test("accepts a custom model", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, model: "nvidia/custom-model", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], "nvidia/custom-model");
});

test("accepts a custom base URL without throwing", () => {
  assert.doesNotThrow(() => {
    createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "https://custom.example.com/v1" });
  });
});

// --- trim e validação de configuração ---------------------------------------

test("trims the API key", () => {
  assert.doesNotThrow(() => {
    createNvidiaNemotronLlmProvider({ apiKey: "  " + FAKE_API_KEY + "  " });
  });
});

test("trims the model", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, model: "  nvidia/custom-model  ", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], "nvidia/custom-model");
});

test("trims the base URL", () => {
  assert.doesNotThrow(() => {
    createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "  https://custom.example.com/v1  " });
  });
});

test("rejects an empty API key", () => {
  assert.throws(
    () => createNvidiaNemotronLlmProvider({ apiKey: "" }),
    TypeError,
  );
});

test("rejects a whitespace-only API key", () => {
  assert.throws(
    () => createNvidiaNemotronLlmProvider({ apiKey: "   " }),
    TypeError,
  );
});

test("rejects an empty model", () => {
  assert.throws(
    () => createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, model: "" }),
    TypeError,
  );
});

test("rejects a whitespace-only model", () => {
  assert.throws(
    () => createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, model: "   " }),
    TypeError,
  );
});

test("rejects an empty base URL", () => {
  assert.throws(
    () => createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "" }),
    TypeError,
  );
});

test("rejects a whitespace-only base URL", () => {
  assert.throws(
    () => createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "   " }),
    TypeError,
  );
});

// --- cliente injetado --------------------------------------------------------

test("the injected client is used without creating a real client (no network access)", async () => {
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createNvidiaNemotronLlmProvider({ apiKey: "not-a-real-key", client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  assert.equal(client.calls.length, 1);
});

test("calls chat.completions.create exactly once", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 1);
});

// --- requisição enviada -------------------------------------------------------

test("sends temperature 0", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["temperature"], 0);
});

test("sends guided_json as an object at the top level", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["guided_json"], OPENAI_LLM_RESPONSE_SCHEMA);
  assert.equal(typeof client.calls[0]!["guided_json"], "object");
});

test("sends enable_thinking false via top-level chat_template_kwargs without extra_body or response_format", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const chatTemplateKwargs = client.calls[0]!["chat_template_kwargs"] as { enable_thinking?: boolean };
  assert.equal(chatTemplateKwargs.enable_thinking, false);
  assert.equal("extra_body" in client.calls[0]!, false);
  assert.equal("response_format" in client.calls[0]!, false);
});

test("the real SDK serializes the NIM fields at the top level of the HTTP body", async () => {
  let requestCount = 0;
  let resolveBody: (body: Record<string, unknown>) => void;
  const receivedBody = new Promise<Record<string, unknown>>(resolve => {
    resolveBody = resolve;
  });
  const server = http.createServer((request, response) => {
    requestCount += 1;
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      rawBody += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      resolveBody(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion",
        created: 0,
        model: "nvidia/test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const provider = createNvidiaNemotronLlmProvider({
      apiKey: FAKE_API_KEY,
      model: "nvidia/test-model",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const result = await provider.generateStructuredOutput(BASE_REQUEST);
    const body = await receivedBody;

    assert.equal(result, "{}");
    assert.equal(requestCount, 1);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(body.guided_json, OPENAI_LLM_RESPONSE_SCHEMA);
    assert.equal(typeof body.guided_json, "object");
    assert.equal("extra_body" in body, false);
    assert.equal("response_format" in body, false);
    assert.equal(JSON.stringify(body).includes(FAKE_API_KEY), false);
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }
});

test("includes the system prompt in the system message", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const messages = client.calls[0]!["messages"] as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((message) => message.role === "system");
  assert.ok(systemMessage?.content.includes("system instructions"));
});

test("includes the user prompt in the user message", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const messages = client.calls[0]!["messages"] as Array<{ role: string; content: string }>;
  const userMessage = messages.find((message) => message.role === "user");
  assert.equal(userMessage?.content, "user message");
});

test("includes the schema serialized in the system message instructions", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const messages = client.calls[0]!["messages"] as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((message) => message.role === "system");
  assert.ok(systemMessage?.content.includes(JSON.stringify(OPENAI_LLM_RESPONSE_SCHEMA)));
  assert.ok(systemMessage?.content.includes(BASE_REQUEST.schemaName));
});

// --- extração da resposta -----------------------------------------------------

test("returns choices[0].message.content", async () => {
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
});

test("rejects a missing content field", async () => {
  const client = fixedClient(undefined);
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_EMPTY_OUTPUT");
      return true;
    },
  );
});

test("rejects an empty content field", async () => {
  const client = fixedClient("");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_EMPTY_OUTPUT");
      return true;
    },
  );
});

test("rejects a whitespace-only content field", async () => {
  const client = fixedClient("   ");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_EMPTY_OUTPUT");
      return true;
    },
  );
});

// --- mapeamento de erros -------------------------------------------------------

test("maps authentication errors", async () => {
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_AUTHENTICATION");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("maps rate limit errors", async () => {
  const client = throwingClient(new RateLimitError(429, {}, "too many requests", undefined));
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_RATE_LIMIT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("maps timeout errors", async () => {
  const client = throwingClient(new APIConnectionTimeoutError());
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("maps server errors", async () => {
  const client = throwingClient(new InternalServerError(500, {}, "server exploded", undefined));
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_SERVER_ERROR");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("maps unknown errors", async () => {
  const client = throwingClient(new Error("something else broke"));
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "NVIDIA_UNKNOWN");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

// --- segurança das mensagens de erro --------------------------------------

test("errors never contain the API key", async () => {
  const secretApiKey = "nvapi-super-secret-do-not-leak";
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  const provider = createNvidiaNemotronLlmProvider({ apiKey: secretApiKey, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(secretApiKey));
      assert.ok(!Object.keys(error).includes("apiKey"));
      return true;
    },
  );
});

test("errors never contain the prompt", async () => {
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(BASE_REQUEST.systemPrompt));
      assert.ok(!serialized.includes(BASE_REQUEST.userPrompt));
      return true;
    },
  );
});

// --- imutabilidade e isolamento de rede -----------------------------------

test("does not mutate the request input", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({ apiKey: FAKE_API_KEY, client });
  const request: LlmProviderRequest = { ...BASE_REQUEST };
  const snapshot = { ...request };
  await provider.generateStructuredOutput(request);
  assert.deepEqual(request, snapshot);
});

test("no network call occurs when a fake client is injected", async () => {
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createNvidiaNemotronLlmProvider({ apiKey: "not-a-real-key", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
});

test("aplica rate limit local antes de chamar o NVIDIA", async () => {
  const client = fixedClient("{}");
  const provider = createNvidiaNemotronLlmProvider({
    apiKey: FAKE_API_KEY,
    client,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(client.calls.length, 1);
});

test("aplica limite local de concorrência antes de chamar o NVIDIA", async () => {
  let release: (() => void) | undefined;
  const client = new FakeNvidiaClient(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { choices: [{ message: { content: "{}" } }] };
  });
  const provider = createNvidiaNemotronLlmProvider({
    apiKey: FAKE_API_KEY,
    client,
    maxRequestsPerMinute: 10,
    maxConcurrentRequests: 1,
  });
  const inFlight = provider.generateStructuredOutput(BASE_REQUEST);
  await Promise.resolve();
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaNemotronLlmProviderError);
      assert.equal(error.code, "LOCAL_CONCURRENCY_LIMIT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  release?.();
  await inFlight;
  assert.equal(client.calls.length, 1);
});
