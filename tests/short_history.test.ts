import assert from "node:assert/strict";
import test from "node:test";
import { appendShortHistory, appendShortHistoryTurn, DEFAULT_SHORT_HISTORY_LIMIT } from "../src/agent/short-history.ts";

test("appendShortHistory adiciona a entrada preservando role/text/at", () => {
  const history = appendShortHistory(undefined, { role: "customer", text: "Oi", at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(history, [{ role: "customer", text: "Oi", at: "2026-01-01T00:00:00.000Z" }]);
});

test("mantém um teto fixo, removendo as entradas mais antigas primeiro", () => {
  let history: ReturnType<typeof appendShortHistory> = [];
  for (let i = 0; i < DEFAULT_SHORT_HISTORY_LIMIT + 5; i += 1) {
    history = appendShortHistory(history, { role: "customer", text: `msg-${i}`, at: "2026-01-01T00:00:00.000Z" });
  }
  assert.equal(history.length, DEFAULT_SHORT_HISTORY_LIMIT);
  assert.equal(history[0]!.text, "msg-5");
  assert.equal(history[history.length - 1]!.text, `msg-${DEFAULT_SHORT_HISTORY_LIMIT + 4}`);
});

test("texto vazio não é adicionado", () => {
  const history = appendShortHistory(undefined, { role: "agent", text: "   ", at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(history, []);
});

test("appendShortHistoryTurn adiciona a mensagem do cliente e a resposta do agente, nessa ordem", () => {
  const history = appendShortHistoryTurn(undefined, {
    customerText: "Quero 2 brownies", customerAt: "2026-01-01T00:00:00.000Z",
    agentText: "Adicionamos 2x Brownie ao seu pedido.", agentAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(history.length, 2);
  assert.equal(history[0]!.role, "customer");
  assert.equal(history[1]!.role, "agent");
});

test("appendShortHistoryTurn sem agentText grava só a mensagem do cliente", () => {
  const history = appendShortHistoryTurn(undefined, { customerText: "Oi", customerAt: "2026-01-01T00:00:00.000Z", agentAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(history.length, 1);
  assert.equal(history[0]!.role, "customer");
});

test("nunca registra messageId quando não informado", () => {
  const history = appendShortHistory(undefined, { role: "customer", text: "Oi", at: "2026-01-01T00:00:00.000Z" });
  assert.equal("messageId" in history[0]!, false);
});

test("respeita um limite customizado", () => {
  let history: ReturnType<typeof appendShortHistory> = [];
  for (let i = 0; i < 5; i += 1) {
    history = appendShortHistory(history, { role: "customer", text: `m${i}`, at: "2026-01-01T00:00:00.000Z" }, 3);
  }
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(h => h.text), ["m2", "m3", "m4"]);
});
