import assert from "node:assert/strict";
import test from "node:test";
import { formatCurrency } from "../src/lib/format.ts";

test("formata um valor inteiro como moeda BRL", () => {
  assert.equal(formatCurrency(700), "R$ 700,00");
});

test("formata um valor com centavos como moeda BRL", () => {
  assert.equal(formatCurrency(28.5), "R$ 28,50");
});
