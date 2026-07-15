import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeOptionalText } from "../src/lib/sanitize.ts";

test("retorna a string aparada quando o valor é uma string", () => {
  assert.equal(sanitizeOptionalText("  Rua das Flores, 123  "), "Rua das Flores, 123");
});

test("retorna string vazia quando o valor é null", () => {
  assert.equal(sanitizeOptionalText(null), "");
});

test("retorna string vazia quando o valor é undefined", () => {
  assert.equal(sanitizeOptionalText(undefined), "");
});

test("retorna string vazia quando o valor não é string (ex.: número)", () => {
  assert.equal(sanitizeOptionalText(123), "");
});
