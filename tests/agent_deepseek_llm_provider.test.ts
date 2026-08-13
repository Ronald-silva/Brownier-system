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
  createDeepseekLlmProvider,
  DeepseekLlmProviderError,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_BASE_URL,
} from "../src/agent/providers/deepseek-llm-provider.ts";
import type { DeepseekCompatibleClient } from "../src/agent/providers/deepseek-llm-provider.ts";
import type { LlmProviderRequest } from "../src/agent/llm-interpreter.types.ts";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "../src/agent/providers/openai-response-schema.ts";

const FAKE_API_KEY = "sk-test-not-a-real-key";

class FakeDeepseekClient implements DeepseekCompatibleClient {
  calls: Record<string, unknown>[] = [];
  chat: DeepseekCompatibleClient["chat"];

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

function fixedClient(content: string | null | undefined): FakeDeepseekClient {
  return new FakeDeepseekClient(async () => ({ choices: [{ message: { content } }] }));
}

function throwingClient(error: unknown): FakeDeepseekClient {
  return new FakeDeepseekClient(async () => {
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
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], DEEPSEEK_DEFAULT_MODEL);
  assert.equal(DEEPSEEK_DEFAULT_MODEL, "deepseek-chat");
});

test("constructing without an injected client uses the default base URL and never touches the network", () => {
  assert.doesNotThrow(() => {
    createDeepseekLlmProvider({ apiKey: FAKE_API_KEY });
  });
  assert.equal(DEEPSEEK_DEFAULT_BASE_URL, "https://api.deepseek.com");
});

test("accepts a custom model", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, model: "deepseek-reasoner", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], "deepseek-reasoner");
});

test("accepts a custom base URL without throwing", () => {
  assert.doesNotThrow(() => {
    createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "https://custom.example.com/v1" });
  });
});

// --- trim e validação de configuração ---------------------------------------

test("trims the API key", () => {
  assert.doesNotThrow(() => {
    createDeepseekLlmProvider({ apiKey: "  " + FAKE_API_KEY + "  " });
  });
});

test("trims the model", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, model: "  deepseek-reasoner  ", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], "deepseek-reasoner");
});

test("trims the base URL", () => {
  assert.doesNotThrow(() => {
    createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "  https://custom.example.com/v1  " });
  });
});

test("rejects an empty API key", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: "" }), TypeError);
});

test("rejects a whitespace-only API key", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: "   " }), TypeError);
});

test("rejects an empty model", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, model: "" }), TypeError);
});

test("rejects a whitespace-only model", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, model: "   " }), TypeError);
});

test("rejects an empty base URL", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "" }), TypeError);
});

test("rejects a whitespace-only base URL", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "   " }), TypeError);
});

// --- cliente injetado --------------------------------------------------------

test("the injected client is used without creating a real client (no network access)", async () => {
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createDeepseekLlmProvider({ apiKey: "not-a-real-key", client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  assert.equal(client.calls.length, 1);
});

test("calls chat.completions.create exactly once", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 1);
});

// --- requisição enviada -------------------------------------------------------
// Diferente do provider NVIDIA: aqui é response_format:{"type":"json_object"},
// nunca guided_json nem chat_template_kwargs (a DeepSeek não suporta essas
// extensões específicas do NIM/vLLM).

test("sends temperature 0", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["temperature"], 0);
});

test("sends a numeric max_tokens to avoid a truncated JSON response", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(typeof client.calls[0]!["max_tokens"], "number");
  assert.ok((client.calls[0]!["max_tokens"] as number) > 0);
});

test("sends response_format json_object at the top level, never guided_json or chat_template_kwargs", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.deepEqual(client.calls[0]!["response_format"], { type: "json_object" });
  assert.equal("guided_json" in client.calls[0]!, false);
  assert.equal("chat_template_kwargs" in client.calls[0]!, false);
  assert.equal("extra_body" in client.calls[0]!, false);
});

test("includes the schema serialized in the system message and the word 'json' (DeepSeek requirement)", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const messages = client.calls[0]!["messages"] as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((message) => message.role === "system");
  assert.ok(systemMessage?.content.toLowerCase().includes("json"));
  assert.ok(systemMessage?.content.includes(JSON.stringify(OPENAI_LLM_RESPONSE_SCHEMA)));
});

test("the real SDK serializes response_format at the top level of the HTTP body", async () => {
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
        model: "deepseek-chat",
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
    const provider = createDeepseekLlmProvider({
      apiKey: FAKE_API_KEY,
      model: "deepseek-chat",
      baseURL: `http://127.0.0.1:${address.port}`,
    });
    const result = await provider.generateStructuredOutput(BASE_REQUEST);
    const body = await receivedBody;

    assert.equal(result, "{}");
    assert.equal(requestCount, 1);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal("guided_json" in body, false);
    assert.equal("chat_template_kwargs" in body, false);
    assert.equal("extra_body" in body, false);
    assert.equal(JSON.stringify(body).includes(FAKE_API_KEY), false);
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }
});

test("includes the user prompt in the user message", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const messages = client.calls[0]!["messages"] as Array<{ role: string; content: string }>;
  const userMessage = messages.find((message) => message.role === "user");
  assert.equal(userMessage?.content, "user message");
});

test("returns choices[0].message.content", async () => {
  const client = fixedClient('{"status":"MATCHED"}');
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"MATCHED"}');
});

test("rejects a missing content field", async () => {
  const client = new FakeDeepseekClient(async () => ({ choices: [{ message: {} }] }));
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_EMPTY_OUTPUT");
    return true;
  });
});

test("rejects an empty content field", async () => {
  const client = fixedClient("");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_EMPTY_OUTPUT");
    return true;
  });
});

test("rejects a whitespace-only content field", async () => {
  const client = fixedClient("   ");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_EMPTY_OUTPUT");
    return true;
  });
});

// --- mapeamento de erros -------------------------------------------------

test("maps authentication errors", async () => {
  const authError = Object.create(AuthenticationError.prototype) as InstanceType<typeof AuthenticationError>;
  const client = throwingClient(authError);
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_AUTHENTICATION");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("maps rate limit errors", async () => {
  const rateLimitError = Object.create(RateLimitError.prototype) as InstanceType<typeof RateLimitError>;
  const client = throwingClient(rateLimitError);
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_RATE_LIMIT");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("maps timeout errors", async () => {
  const timeoutError = Object.create(APIConnectionTimeoutError.prototype) as InstanceType<typeof APIConnectionTimeoutError>;
  const client = throwingClient(timeoutError);
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_TIMEOUT");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("maps server errors", async () => {
  const serverError = Object.create(InternalServerError.prototype) as InstanceType<typeof InternalServerError>;
  const client = throwingClient(serverError);
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_SERVER_ERROR");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("maps unknown errors", async () => {
  const client = throwingClient(new Error("something else"));
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "DEEPSEEK_UNKNOWN");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("errors never contain the API key", async () => {
  const client = throwingClient(new Error(`leaked ${FAKE_API_KEY}`));
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  try {
    await provider.generateStructuredOutput(BASE_REQUEST);
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.message.includes(FAKE_API_KEY), false);
  }
});

test("errors never contain the prompt", async () => {
  const client = throwingClient(new Error("boom"));
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  try {
    await provider.generateStructuredOutput(BASE_REQUEST);
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.message.includes("system instructions"), false);
    assert.equal(error.message.includes("user message"), false);
  }
});

test("does not mutate the request input", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  const request = { ...BASE_REQUEST };
  const snapshot = JSON.stringify(request);
  await provider.generateStructuredOutput(request);
  assert.equal(JSON.stringify(request), snapshot);
});

test("no network call occurs when a fake client is injected", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, baseURL: "https://this-domain-does-not-exist.invalid", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 1);
});

// --- limitador local de rate limit / concorrência -------------------------
// Mesmo padrão do provider NVIDIA: janela deslizante em memória, sem timer,
// sem persistência, isolada por instância.

test("default maxRequestsPerMinute allows up to 30 calls per minute", async () => {
  let now = 0;
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    for (let i = 0; i < 30; i++) {
      await provider.generateStructuredOutput(BASE_REQUEST);
    }
    await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
      assert.ok(error instanceof DeepseekLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    Date.now = originalNow;
  }
});

test("a valid maxRequestsPerMinute is accepted", () => {
  assert.doesNotThrow(() => {
    createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, maxRequestsPerMinute: 5 });
  });
});

test("maxRequestsPerMinute of zero is rejected", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, maxRequestsPerMinute: 0 }), TypeError);
});

test("default maxConcurrentRequests allows 2 simultaneous calls", async () => {
  let resolveFirst: () => void;
  const gate = new Promise<void>(resolve => { resolveFirst = resolve; });
  const client = new FakeDeepseekClient(async () => {
    await gate;
    return { choices: [{ message: { content: "{}" } }] };
  });
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, client });

  const call1 = provider.generateStructuredOutput(BASE_REQUEST);
  const call2 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.equal(error.code, "LOCAL_CONCURRENCY_LIMIT");
    return true;
  });
  resolveFirst!();
  await Promise.all([call1, call2]);
});

test("a valid maxConcurrentRequests is accepted", () => {
  assert.doesNotThrow(() => {
    createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, maxConcurrentRequests: 5 });
  });
});

test("maxConcurrentRequests of zero is rejected", () => {
  assert.throws(() => createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, maxConcurrentRequests: 0 }), TypeError);
});

test("slot is released after success", async () => {
  const client = fixedClient("{}");
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, maxConcurrentRequests: 1, client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.doesNotReject(() => provider.generateStructuredOutput(BASE_REQUEST));
});

test("slot is released after an error", async () => {
  const client = throwingClient(new Error("boom"));
  const provider = createDeepseekLlmProvider({ apiKey: FAKE_API_KEY, maxConcurrentRequests: 1, client });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST), (error: unknown) => {
    assert.ok(error instanceof DeepseekLlmProviderError);
    assert.notEqual(error.code, "LOCAL_CONCURRENCY_LIMIT");
    return true;
  });
});
