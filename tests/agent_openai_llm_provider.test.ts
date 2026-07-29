import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationError,
  RateLimitError,
  InternalServerError,
  APIConnectionTimeoutError,
} from "openai";
import {
  createOpenAiLlmProvider,
  OpenAiLlmProviderError,
} from "../src/agent/providers/openai-llm-provider.ts";
import type { OpenAiResponsesClient } from "../src/agent/providers/openai-llm-provider.ts";
import type { LlmProviderRequest } from "../src/agent/llm-interpreter.types.ts";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "../src/agent/providers/openai-response-schema.ts";
import type { LlmProviderUsage } from "../src/agent/providers/llm-provider-usage.ts";

const FAKE_API_KEY = "sk-test-not-a-real-key";

class FakeOpenAiClient implements OpenAiResponsesClient {
  calls: Record<string, unknown>[] = [];
  responses: { create(params: Record<string, unknown>): Promise<{ output_text?: string | null }> };

  constructor(impl: (params: Record<string, unknown>) => Promise<{ output_text?: string | null }>) {
    this.responses = {
      create: async (params: Record<string, unknown>) => {
        this.calls.push(params);
        return impl(params);
      },
    };
  }
}

function fixedClient(outputText: string | null | undefined): FakeOpenAiClient {
  return new FakeOpenAiClient(async () => ({ output_text: outputText }));
}

function throwingClient(error: unknown): FakeOpenAiClient {
  return new FakeOpenAiClient(async () => {
    throw error;
  });
}

function richClient(fields: {
  output_text?: string | null;
  id?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}): FakeOpenAiClient {
  return new FakeOpenAiClient(async () => fields);
}

function manualClock(startAt: number): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
    set: (t: number) => { current = t; },
  };
}

const BASE_REQUEST: LlmProviderRequest = {
  systemPrompt: "system instructions",
  userPrompt: "user message",
  schemaName: "llm_interpreter_output_v1",
};

test("calls responses.create exactly once", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 1);
});

test("uses the configured model", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5-mini", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["model"], "gpt-5-mini");
});

test("sends store: false", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["store"], false);
});

test("does not send tools", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["tools"], undefined);
});

test("sends systemPrompt as instructions", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["instructions"], "system instructions");
});

test("sends userPrompt as input", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls[0]!["input"], "user message");
});

test("requests structured JSON output via text.format json_schema", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const text = client.calls[0]!["text"] as { format?: { type?: string; name?: string } };
  assert.equal(text.format?.type, "json_schema");
  assert.equal(text.format?.name, "llm_interpreter_output_v1");
});

test("sends OPENAI_LLM_RESPONSE_SCHEMA as the json_schema payload", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const text = client.calls[0]!["text"] as { format?: { schema?: unknown } };
  assert.deepEqual(text.format?.schema, OPENAI_LLM_RESPONSE_SCHEMA);
});

test("does not mutate or recreate the schema between calls", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  const snapshot = JSON.parse(JSON.stringify(OPENAI_LLM_RESPONSE_SCHEMA));
  await provider.generateStructuredOutput(BASE_REQUEST);
  await provider.generateStructuredOutput(BASE_REQUEST);
  const firstSchema = (client.calls[0]!["text"] as { format?: { schema?: unknown } }).format?.schema;
  const secondSchema = (client.calls[1]!["text"] as { format?: { schema?: unknown } }).format?.schema;
  assert.equal(firstSchema, OPENAI_LLM_RESPONSE_SCHEMA);
  assert.equal(secondSchema, OPENAI_LLM_RESPONSE_SCHEMA);
  assert.deepEqual(OPENAI_LLM_RESPONSE_SCHEMA, snapshot);
});

test("returns only output_text", async () => {
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
});

test("empty output_text throws a safe local error", async () => {
  const client = fixedClient("");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "EMPTY_OUTPUT");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("authentication error is not retryable", async () => {
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "AUTHENTICATION");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("rate limit error is retryable", async () => {
  const client = throwingClient(new RateLimitError(429, {}, "too many requests", undefined));
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "RATE_LIMIT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("server error is retryable", async () => {
  const client = throwingClient(new InternalServerError(500, {}, "server exploded", undefined));
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "SERVER_ERROR");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("timeout error is retryable", async () => {
  const client = throwingClient(new APIConnectionTimeoutError());
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("unknown thrown value becomes a non-retryable UNKNOWN error", async () => {
  const client = throwingClient(new Error("something else broke"));
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "UNKNOWN");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("fake client never touches the network (no real OpenAI client is built when client is injected)", async () => {
  // apiKey is obviously invalid; if the provider ever constructed a real
  // OpenAI client instead of using the injected fake, any network attempt
  // in this sandboxed test run would fail loudly instead of resolving.
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createOpenAiLlmProvider({ apiKey: "not-a-real-key", model: "gpt-5", client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  assert.equal(client.calls.length, 1);
});

test("API key never appears in thrown errors", async () => {
  const secretApiKey = "sk-super-secret-do-not-leak";
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  const provider = createOpenAiLlmProvider({ apiKey: secretApiKey, model: "gpt-5", client });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(secretApiKey));
      assert.ok(!Object.keys(error).includes("apiKey"));
      return true;
    },
  );
});

test("request input passed to generateStructuredOutput is not mutated", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  const request: LlmProviderRequest = { ...BASE_REQUEST };
  const snapshot = { ...request };
  await provider.generateStructuredOutput(request);
  assert.deepEqual(request, snapshot);
});

// --- onUsage callback ------------------------------------------------------

test("onUsage is optional: provider works without it", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, "{}");
});

test("without onUsage, the return value remains output_text", async () => {
  const client = richClient({
    output_text: '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}',
    id: "resp_1",
    model: "gpt-5",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
});

test("onUsage callback receives inputTokens from response.usage.input_tokens", async () => {
  const client = richClient({ output_text: "{}", usage: { input_tokens: 42 } });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.inputTokens, 42);
});

test("onUsage callback receives outputTokens from response.usage.output_tokens", async () => {
  const client = richClient({ output_text: "{}", usage: { output_tokens: 7 } });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.outputTokens, 7);
});

test("onUsage callback receives totalTokens from response.usage.total_tokens", async () => {
  const client = richClient({ output_text: "{}", usage: { total_tokens: 49 } });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.totalTokens, 49);
});

test("onUsage callback receives model from response.model", async () => {
  const client = richClient({ output_text: "{}", model: "gpt-5-mini" });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5-mini",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.model, "gpt-5-mini");
});

test("onUsage callback receives responseId from response.id", async () => {
  const client = richClient({ output_text: "{}", id: "resp_abc123" });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.responseId, "resp_abc123");
});

test("onUsage callback receives durationMs", async () => {
  const client = fixedClient("{}");
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(typeof received?.durationMs, "number");
});

test("fields absent from the response remain undefined in usage", async () => {
  const client = fixedClient("{}");
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.inputTokens, undefined);
  assert.equal(received?.outputTokens, undefined);
  assert.equal(received?.totalTokens, undefined);
  assert.equal(received?.model, undefined);
  assert.equal(received?.responseId, undefined);
});

test("onUsage receives a new object, not a reference to internal state", async () => {
  const client = richClient({ output_text: "{}", id: "resp_1", model: "gpt-5" });
  const received: LlmProviderUsage[] = [];
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received.push(usage); },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received.length, 2);
  assert.notEqual(received[0], received[1]);
});

test("onUsage does not receive the prompt", async () => {
  const client = richClient({ output_text: "{}" });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const serialized = JSON.stringify(received);
  assert.ok(!serialized.includes("system instructions"));
  assert.ok(!serialized.includes("user message"));
});

test("onUsage does not receive the API key", async () => {
  const secretApiKey = "sk-super-secret-do-not-leak";
  const client = richClient({ output_text: "{}" });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: secretApiKey,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const serialized = JSON.stringify(received);
  assert.ok(!serialized.includes(secretApiKey));
});

test("onUsage does not receive the raw response object", async () => {
  const client = richClient({
    output_text: "{}",
    id: "resp_1",
    model: "gpt-5",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const allowedKeys = ["inputTokens", "outputTokens", "totalTokens", "model", "responseId", "durationMs"];
  for (const key of Object.keys(received ?? {})) {
    assert.ok(allowedKeys.includes(key), `unexpected key leaked onto usage object: ${key}`);
  }
});

test("onUsage does not receive headers", async () => {
  const client = richClient({ output_text: "{}" });
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal((received as Record<string, unknown> | undefined)?.["headers"], undefined);
});

test("an error thrown by onUsage does not break the return value", async () => {
  const client = fixedClient('{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => { throw new Error("callback exploded"); },
  });
  const result = await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(result, '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}');
});

test("an error thrown by onUsage does not cause a second call to OpenAI", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => { throw new Error("callback exploded"); },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 1);
});

test("onUsage is called exactly once per generateStructuredOutput call", async () => {
  const client = fixedClient("{}");
  let callCount = 0;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => { callCount += 1; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(callCount, 1);
});

test("onUsage is not called on empty output_text", async () => {
  const client = fixedClient("");
  let called = false;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => { called = true; },
  });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(called, false);
});

test("onUsage is not called when the provider throws (authentication error)", async () => {
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  let called = false;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => { called = true; },
  });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(called, false);
});

test("onUsage is not called when the provider throws (unknown error)", async () => {
  const client = throwingClient(new Error("boom"));
  let called = false;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => { called = true; },
  });
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(called, false);
});

test("an injected now() makes durationMs deterministic", async () => {
  const client = fixedClient("{}");
  let tick = 1000;
  const now = () => {
    const current = tick;
    tick += 250;
    return current;
  };
  let received: LlmProviderUsage | undefined;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now,
    onUsage: (usage) => { received = usage; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(received?.durationMs, 250);
});

test("request input is still not mutated when onUsage is configured", async () => {
  const client = richClient({ output_text: "{}", id: "resp_1", model: "gpt-5" });
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    onUsage: () => {},
  });
  const request: LlmProviderRequest = { ...BASE_REQUEST };
  const snapshot = { ...request };
  await provider.generateStructuredOutput(request);
  assert.deepEqual(request, snapshot);
});

// --- local rate limiter -----------------------------------------------------

test("default maxRequestsPerMinute allows up to 30 calls per minute", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, now: clock.now });
  for (let i = 0; i < 30; i++) {
    await provider.generateStructuredOutput(BASE_REQUEST);
  }
  assert.equal(client.calls.length, 30);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      return true;
    },
  );
});

test("a valid maxRequestsPerMinute is accepted", () => {
  const client = fixedClient("{}");
  assert.doesNotThrow(() => {
    createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxRequestsPerMinute: 5 });
  });
});

test("maxRequestsPerMinute of zero is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxRequestsPerMinute: 0 }),
    TypeError,
  );
});

test("negative maxRequestsPerMinute is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxRequestsPerMinute: -1 }),
    TypeError,
  );
});

test("decimal maxRequestsPerMinute is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxRequestsPerMinute: 1.5 }),
    TypeError,
  );
});

test("maxRequestsPerMinute above 600 is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxRequestsPerMinute: 601 }),
    TypeError,
  );
});

test("non-numeric maxRequestsPerMinute is rejected at runtime", () => {
  const client = fixedClient("{}");
  assert.throws(
    () =>
      createOpenAiLlmProvider({
        apiKey: FAKE_API_KEY,
        model: "gpt-5",
        client,
        maxRequestsPerMinute: "10" as unknown as number,
      }),
    TypeError,
  );
});

test("maxRequestsPerMinute rejection does not create the client or reach the API, and never includes the API key", () => {
  const secretApiKey = "sk-super-secret-do-not-leak";
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: secretApiKey, model: "gpt-5", maxRequestsPerMinute: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!error.message.includes(secretApiKey));
      return true;
    },
  );
});

test("calls exactly at the limit are allowed", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 2,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
});

test("the call after the limit is blocked", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 2,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
});

test("blocking raises LOCAL_RATE_LIMIT", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      return true;
    },
  );
});

test("LOCAL_RATE_LIMIT is retryable", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("a blocked call never reaches responses.create", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(client.calls.length, 1);
});

test("a blocked call never triggers onUsage", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  let usageCallCount = 0;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
    onUsage: () => { usageCallCount += 1; },
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(usageCallCount, 1);
});

test("calls that fail at the provider still count toward the local limit", async () => {
  const client = throwingClient(new AuthenticationError(401, {}, "unauthorized", undefined));
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "AUTHENTICATION");
      return true;
    },
  );
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      return true;
    },
  );
});

test("an empty response counts toward the local limit", async () => {
  const client = fixedClient("");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "EMPTY_OUTPUT");
      return true;
    },
  );
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      return true;
    },
  );
});

test("a blocked call is not registered as a new attempt", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST); // t=0, registers
  clock.set(30000);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST)); // blocked, must not register at t=30000
  clock.set(60001); // original t=0 timestamp is now expired (age 60001 >= 60000)
  await provider.generateStructuredOutput(BASE_REQUEST); // must succeed: if the blocked call had wrongly registered at t=30000, this would still be blocked (age 30001 < 60000)
  assert.equal(client.calls.length, 2);
});

test("after 60000ms, old calls expire", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  clock.set(60000);
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
});

test("a timestamp with exactly 60000ms of age expires", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST); // t=0
  clock.set(60000); // age === 60000
  await provider.generateStructuredOutput(BASE_REQUEST); // must be allowed: the old entry expired
  assert.equal(client.calls.length, 2);
});

test("a timestamp with 59999ms of age still counts", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST); // t=0
  clock.set(59999); // age === 59999
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      return true;
    },
  );
});

test("the sliding window is based on the injected now, not on wall-clock time", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(10 ** 12); // arbitrary time base, far from Date.now()
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  clock.advance(59999);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  clock.advance(1);
  await provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
});

test("two provider instances have independent limits", async () => {
  const clock = manualClock(0);
  const clientA = fixedClient("{}");
  const clientB = fixedClient("{}");
  const providerA = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client: clientA,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  const providerB = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client: clientB,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await providerA.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => providerA.generateStructuredOutput(BASE_REQUEST));
  await providerB.generateStructuredOutput(BASE_REQUEST);
  assert.equal(clientA.calls.length, 1);
  assert.equal(clientB.calls.length, 1);
});

test("LOCAL_RATE_LIMIT error never contains the API key", async () => {
  const secretApiKey = "sk-super-secret-do-not-leak";
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: secretApiKey,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(secretApiKey));
      return true;
    },
  );
});

test("LOCAL_RATE_LIMIT error never contains the prompt", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(BASE_REQUEST.systemPrompt));
      assert.ok(!serialized.includes(BASE_REQUEST.userPrompt));
      return true;
    },
  );
});

test("request input is not mutated by a blocked call", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  const request: LlmProviderRequest = { ...BASE_REQUEST };
  const snapshot = { ...request };
  await assert.rejects(() => provider.generateStructuredOutput(request));
  assert.deepEqual(request, snapshot);
});

// --- local concurrency limiter -----------------------------------------

type PendingCall = {
  params: Record<string, unknown>;
  resolve: (value: { output_text?: string | null; id?: string; model?: string; usage?: unknown }) => void;
  reject: (error: unknown) => void;
};

class PendingOpenAiClient implements OpenAiResponsesClient {
  calls: Record<string, unknown>[] = [];
  pending: PendingCall[] = [];
  responses: { create(params: Record<string, unknown>): Promise<{ output_text?: string | null }> };

  constructor() {
    this.responses = {
      create: (params: Record<string, unknown>) => {
        this.calls.push(params);
        return new Promise((resolve, reject) => {
          this.pending.push({ params, resolve, reject });
        });
      },
    };
  }

  resolveNext(value: { output_text?: string | null; id?: string; model?: string; usage?: unknown } = { output_text: "{}" }): void {
    const call = this.pending.shift();
    if (!call) throw new Error("no pending call to resolve");
    call.resolve(value);
  }

  rejectNext(error: unknown): void {
    const call = this.pending.shift();
    if (!call) throw new Error("no pending call to reject");
    call.reject(error);
  }
}

test("default maxConcurrentRequests allows 2 simultaneous calls", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  client.resolveNext();
  await Promise.all([p1, p2]);
});

test("a valid maxConcurrentRequests is accepted", () => {
  const client = fixedClient("{}");
  assert.doesNotThrow(() => {
    createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 5 });
  });
});

test("maxConcurrentRequests of zero is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 0 }),
    TypeError,
  );
});

test("negative maxConcurrentRequests is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: -1 }),
    TypeError,
  );
});

test("decimal maxConcurrentRequests is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1.5 }),
    TypeError,
  );
});

test("maxConcurrentRequests above 20 is rejected", () => {
  const client = fixedClient("{}");
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 21 }),
    TypeError,
  );
});

test("non-numeric maxConcurrentRequests is rejected at runtime", () => {
  const client = fixedClient("{}");
  assert.throws(
    () =>
      createOpenAiLlmProvider({
        apiKey: FAKE_API_KEY,
        model: "gpt-5",
        client,
        maxConcurrentRequests: "3" as unknown as number,
      }),
    TypeError,
  );
});

test("maxConcurrentRequests rejection does not create the client or reach the API, and never includes the API key", () => {
  const secretApiKey = "sk-super-secret-do-not-leak";
  assert.throws(
    () => createOpenAiLlmProvider({ apiKey: secretApiKey, model: "gpt-5", maxConcurrentRequests: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!error.message.includes(secretApiKey));
      return true;
    },
  );
});

test("a call within the limit is permitted", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 1);
  client.resolveNext();
  await p1;
});

test("exactly at the concurrency limit, calls are permitted", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 2 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  client.resolveNext();
  await Promise.all([p1, p2]);
});

test("a call above the concurrency limit is blocked immediately", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_CONCURRENCY_LIMIT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(client.calls.length, 1);
  client.resolveNext();
  await p1;
});

test("a call blocked by concurrency never reaches responses.create", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(client.calls.length, 1);
  client.resolveNext();
  await p1;
});

test("a call blocked by concurrency never triggers onUsage", async () => {
  const client = new PendingOpenAiClient();
  let usageCallCount = 0;
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    maxConcurrentRequests: 1,
    onUsage: () => { usageCallCount += 1; },
  });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(() => provider.generateStructuredOutput(BASE_REQUEST));
  assert.equal(usageCallCount, 0);
  client.resolveNext();
  await p1;
  assert.equal(usageCallCount, 1);
});

test("slot is released after success", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.resolveNext({ output_text: "{}" });
  await p1;
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("slot is released after an empty response", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.resolveNext({ output_text: "" });
  await assert.rejects(
    () => p1,
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "EMPTY_OUTPUT");
      return true;
    },
  );
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("slot is released after a timeout", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.rejectNext(new APIConnectionTimeoutError());
  await assert.rejects(
    () => p1,
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "TIMEOUT");
      return true;
    },
  );
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("slot is released after an authentication error", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.rejectNext(new AuthenticationError(401, {}, "unauthorized", undefined));
  await assert.rejects(
    () => p1,
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "AUTHENTICATION");
      return true;
    },
  );
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("slot is released after a remote rate limit error", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.rejectNext(new RateLimitError(429, {}, "too many requests", undefined));
  await assert.rejects(
    () => p1,
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "RATE_LIMIT");
      return true;
    },
  );
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("slot is released after a server error", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.rejectNext(new InternalServerError(500, {}, "server exploded", undefined));
  await assert.rejects(
    () => p1,
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "SERVER_ERROR");
      return true;
    },
  );
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("slot is released after an unknown error", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.rejectNext(new Error("boom"));
  await assert.rejects(
    () => p1,
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "UNKNOWN");
      return true;
    },
  );
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("an error thrown by onUsage does not hold the slot", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    maxConcurrentRequests: 1,
    onUsage: () => { throw new Error("callback exploded"); },
  });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  client.resolveNext({ output_text: "{}" });
  await p1;
  const p2 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p2;
});

test("the active call counter never goes negative across repeated sequential calls", async () => {
  const client = fixedClient("{}");
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  for (let i = 0; i < 5; i++) {
    await provider.generateStructuredOutput(BASE_REQUEST);
  }
  assert.equal(client.calls.length, 5);
});

test("two provider instances have independent concurrency limits", async () => {
  const clientA = new PendingOpenAiClient();
  const clientB = new PendingOpenAiClient();
  const providerA = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client: clientA, maxConcurrentRequests: 1 });
  const providerB = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client: clientB, maxConcurrentRequests: 1 });
  const pA1 = providerA.generateStructuredOutput(BASE_REQUEST);
  const pB1 = providerB.generateStructuredOutput(BASE_REQUEST);
  assert.equal(clientA.calls.length, 1);
  assert.equal(clientB.calls.length, 1);
  clientA.resolveNext();
  clientB.resolveNext();
  await Promise.all([pA1, pB1]);
});

test("a call blocked by concurrency does not consume the per-minute rate limit quota", async () => {
  const client = new PendingOpenAiClient();
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 2,
    maxConcurrentRequests: 1,
  });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_CONCURRENCY_LIMIT");
      return true;
    },
  );
  client.resolveNext();
  await p1;
  const p3 = provider.generateStructuredOutput(BASE_REQUEST);
  assert.equal(client.calls.length, 2);
  client.resolveNext();
  await p3;
});

test("calls that reach the API still consume the per-minute rate limit quota", async () => {
  const client = fixedClient("{}");
  const clock = manualClock(0);
  const provider = createOpenAiLlmProvider({
    apiKey: FAKE_API_KEY,
    model: "gpt-5",
    client,
    now: clock.now,
    maxRequestsPerMinute: 1,
    maxConcurrentRequests: 2,
  });
  await provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      assert.equal(error.code, "LOCAL_RATE_LIMIT");
      return true;
    },
  );
});

test("LOCAL_CONCURRENCY_LIMIT error never contains the API key", async () => {
  const secretApiKey = "sk-super-secret-do-not-leak";
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: secretApiKey, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(secretApiKey));
      return true;
    },
  );
  client.resolveNext();
  await p1;
});

test("LOCAL_CONCURRENCY_LIMIT error never contains the prompt", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  await assert.rejects(
    () => provider.generateStructuredOutput(BASE_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiLlmProviderError);
      const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!serialized.includes(BASE_REQUEST.systemPrompt));
      assert.ok(!serialized.includes(BASE_REQUEST.userPrompt));
      return true;
    },
  );
  client.resolveNext();
  await p1;
});

test("request input is not mutated by a call blocked on concurrency", async () => {
  const client = new PendingOpenAiClient();
  const provider = createOpenAiLlmProvider({ apiKey: FAKE_API_KEY, model: "gpt-5", client, maxConcurrentRequests: 1 });
  const p1 = provider.generateStructuredOutput(BASE_REQUEST);
  const request: LlmProviderRequest = { ...BASE_REQUEST };
  const snapshot = { ...request };
  await assert.rejects(() => provider.generateStructuredOutput(request));
  assert.deepEqual(request, snapshot);
  client.resolveNext();
  await p1;
});
