import assert from "node:assert/strict";
import test from "node:test";
import {
  generateOrderIdempotencyKey,
  isValidOrderIdempotencyKey,
} from "../src/agent/order-idempotency.ts";

test("generateOrderIdempotencyKey produz uma chave válida pela regra oficial", () => {
  const key = generateOrderIdempotencyKey();
  assert.ok(isValidOrderIdempotencyKey(key));
});

test("generateOrderIdempotencyKey usa o prefixo agent-order:", () => {
  const key = generateOrderIdempotencyKey();
  assert.ok(key.startsWith("agent-order:"));
});

test("generateOrderIdempotencyKey não repete valores entre chamadas", () => {
  const a = generateOrderIdempotencyKey();
  const b = generateOrderIdempotencyKey();
  assert.notEqual(a, b);
});

test("isValidOrderIdempotencyKey rejeita chave curta demais", () => {
  assert.equal(isValidOrderIdempotencyKey("short"), false);
});

test("isValidOrderIdempotencyKey rejeita chave longa demais", () => {
  assert.equal(isValidOrderIdempotencyKey("a".repeat(129)), false);
});

test("isValidOrderIdempotencyKey aceita chave de 128 caracteres", () => {
  assert.equal(isValidOrderIdempotencyKey("a".repeat(128)), true);
});

test("isValidOrderIdempotencyKey aceita chave de 8 caracteres", () => {
  assert.equal(isValidOrderIdempotencyKey("a".repeat(8)), true);
});

test("isValidOrderIdempotencyKey rejeita caracteres fora de [A-Za-z0-9._:-]", () => {
  assert.equal(isValidOrderIdempotencyKey("agent-order:tem espaço"), false);
  assert.equal(isValidOrderIdempotencyKey("agent-order:tem*asterisco"), false);
});

test("isValidOrderIdempotencyKey rejeita valores não-string", () => {
  assert.equal(isValidOrderIdempotencyKey(undefined), false);
  assert.equal(isValidOrderIdempotencyKey(123 as unknown as string), false);
});
