import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_STATUSES } from "../src/lib/orderStatuses.ts";

test("contém a grafia correta de SAIU_PARA_ENTREGA", () => {
  assert.ok(ORDER_STATUSES.includes("SAIU_PARA_ENTREGA"));
});

test("não contém a grafia antiga com erro de digitação", () => {
  assert.ok(!ORDER_STATUSES.includes("SAIU_PARA_ENTEGA" as any));
});

test("contém exatamente os 7 status esperados, na ordem do fluxo operacional", () => {
  assert.deepEqual(ORDER_STATUSES, ["NOVO", "CONFIRMADO", "EM_PREPARO", "PRONTO", "SAIU_PARA_ENTREGA", "CONCLUIDO", "CANCELADO"]);
});
