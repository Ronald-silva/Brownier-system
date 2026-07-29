import assert from "node:assert/strict";
import test from "node:test";
import { createHealthHandler } from "../src/lib/health.ts";

type CapturedResponse = {
  statusCode?: number;
  body?: Record<string, unknown>;
  status: (code: number) => CapturedResponse;
  json: (body: Record<string, unknown>) => CapturedResponse;
};

function responseCapture(): CapturedResponse {
  const response: CapturedResponse = {
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(body) {
      response.body = body;
      return response;
    },
  };
  return response;
}

test("health responde 200 sem expor detalhes quando PostgreSQL está conectado", async () => {
  const response = responseCapture();

  await createHealthHandler(async () => {})({} as never, response as never, (() => undefined) as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual({ ...response.body, timestamp: typeof response.body?.timestamp }, {
    status: "ok",
    service: "brownier",
    database: "connected",
    timestamp: "string",
  });
});

test("health responde 503 sem vazar erro interno quando PostgreSQL está indisponível", async () => {
  const response = responseCapture();

  await createHealthHandler(async () => { throw new Error("postgres://internal-user:secret@host/db"); })({} as never, response as never, (() => undefined) as never);

  assert.equal(response.statusCode, 503);
  assert.deepEqual({ ...response.body, timestamp: typeof response.body?.timestamp }, {
    status: "error",
    service: "brownier",
    database: "disconnected",
    timestamp: "string",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /postgres|secret|internal-user/i);
});
