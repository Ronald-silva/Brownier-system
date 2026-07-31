import assert from "node:assert/strict";
import test from "node:test";
import { resolveFactualIntent } from "../src/agent/factual-intent.ts";
import type { OperatingStatus } from "../src/agent/operating-status.ts";

const OPEN_STATUS: OperatingStatus = {
  known: true,
  isOpenNow: true,
  nowLocal: "2026-08-03T10:00:00-03:00",
  weekday: "MON",
  timezone: "America/Fortaleza",
  currentClose: "18:00",
  nextOpen: null,
  closedReason: null,
};

for (const text of ["Vocês estão abertos?", "Posso retirar pedido agora?", "Que horas vocês abrem?", "Posso buscar hoje?"]) {
  test(`reconhece pergunta de horário: "${text}"`, () => {
    const intent = resolveFactualIntent({ text, operatingStatus: OPEN_STATUS });
    assert.equal(intent?.kind, "PICKUP_AVAILABILITY");
    if (intent?.kind === "PICKUP_AVAILABILITY") assert.deepEqual(intent.status, OPEN_STATUS);
  });
}

test("sem operatingStatus informado, cai em known:false — nunca undefined silencioso", () => {
  const intent = resolveFactualIntent({ text: "vocês estão abertos?" });
  assert.equal(intent?.kind, "PICKUP_AVAILABILITY");
  if (intent?.kind === "PICKUP_AVAILABILITY") assert.deepEqual(intent.status, { known: false });
});

test("pergunta de endereço continua tendo prioridade e não vira PICKUP_AVAILABILITY", () => {
  const intent = resolveFactualIntent({ text: "qual o endereço da loja?", address: "Rua X, 1", operatingStatus: OPEN_STATUS });
  assert.equal(intent?.kind, "ADDRESS");
});

test("pergunta de cardápio continua funcionando sem relação com horário", () => {
  const intent = resolveFactualIntent({ text: "poderia me mandar o cardápio?", operatingStatus: OPEN_STATUS });
  assert.equal(intent?.kind, "MENU");
});

test("mensagem sem relação com domínio não vira intenção factual nenhuma", () => {
  assert.equal(resolveFactualIntent({ text: "quero 2 brigadeiro", operatingStatus: OPEN_STATUS }), undefined);
});
