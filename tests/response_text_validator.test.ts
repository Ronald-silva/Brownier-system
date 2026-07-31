import assert from "node:assert/strict";
import test from "node:test";
import { validateResponseText } from "../src/agent/response-text-validator.ts";
import type { AllowedFact } from "../src/agent/conversation-intelligence.types.ts";

const PRODUCT: AllowedFact = { factId: "product:p1", key: "PRODUCT", id: "p1", name: "Brownie de Brigadeiro", price: 5, promotionalPrice: null };
const ADDRESS: AllowedFact = { factId: "business_address", key: "BUSINESS_ADDRESS", address: "Rua das Flores, 123" };
const OPEN_STATUS: AllowedFact = {
  factId: "operating_status:2026-01-01", key: "OPERATING_STATUS",
  status: { known: true, isOpenNow: true, nowLocal: "2026-01-01T10:00:00-03:00", weekday: "THU", timezone: "America/Fortaleza", currentClose: "18:00", nextOpen: null, closedReason: null },
};
const CLOSED_UNKNOWN_STATUS: AllowedFact = { factId: "operating_status:unknown", key: "OPERATING_STATUS", status: { known: false } };
const PICKUP_SLOTS: AllowedFact = { factId: "pickup_slots:turn", key: "PICKUP_SLOTS", slots: ["18:00", "19:00"] };

test("factId inexistente em usedFactIds é rejeitado", () => {
  const result = validateResponseText({ text: "O Brownie custa R$ 5,00.", usedFactIds: ["product:inexistente"], facts: [PRODUCT] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNKNOWN_USED_FACT_ID");
});

test("preço inventado não presente em facts é rejeitado", () => {
  const result = validateResponseText({ text: "O Brownie custa R$ 99,90.", usedFactIds: ["product:p1"], facts: [PRODUCT] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNAUTHORIZED_PRICE");
});

test("preço autorizado (igual ao fato citado) é aprovado", () => {
  const result = validateResponseText({ text: "O Brownie de Brigadeiro custa R$ 5,00.", usedFactIds: ["product:p1"], facts: [PRODUCT] });
  assert.equal(result.ok, true);
});

test("produto fora do catálogo autorizado neste turno é rejeitado mesmo sendo um produto real", () => {
  const outroProduto: AllowedFact = { factId: "product:p2", key: "PRODUCT", id: "p2", name: "Brownie de Ninho", price: 6, promotionalPrice: null };
  const result = validateResponseText({
    text: "Temos também o Brownie de Ninho!",
    usedFactIds: ["product:p1"],
    facts: [PRODUCT],
    catalogProductNames: [outroProduto.name],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNAUTHORIZED_PRODUCT_CITATION");
});

test("endereço citado diferente do BUSINESS_ADDRESS autorizado é rejeitado", () => {
  const result = validateResponseText({ text: "Estamos na Rua das Palmeiras, 45.", usedFactIds: ["business_address"], facts: [ADDRESS] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "ADDRESS_MISMATCH");
});

test("endereço citado sem o fato BUSINESS_ADDRESS autorizado é rejeitado", () => {
  const result = validateResponseText({ text: "Fica na Rua das Flores, 123.", usedFactIds: [], facts: [] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNAUTHORIZED_ADDRESS_MENTION");
});

test("endereço citado corretamente e autorizado é aprovado", () => {
  const result = validateResponseText({ text: "O endereço para retirada é Rua das Flores, 123.", usedFactIds: ["business_address"], facts: [ADDRESS] });
  assert.equal(result.ok, true);
});

test("horário específico (HH:mm) não presente em OPERATING_STATUS/PICKUP_SLOTS é rejeitado", () => {
  const result = validateResponseText({ text: "Abrimos às 07:00.", usedFactIds: ["pickup_slots:turn"], facts: [PICKUP_SLOTS] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNAUTHORIZED_TIME");
});

test("horário presente em PICKUP_SLOTS é aprovado", () => {
  const result = validateResponseText({ text: "Você pode retirar às 18:00.", usedFactIds: ["pickup_slots:turn"], facts: [PICKUP_SLOTS] });
  assert.equal(result.ok, true);
});

test("afirmação de 'estamos abertos' com OPERATING_STATUS.known === false é rejeitada", () => {
  const result = validateResponseText({ text: "Sim, estamos abertos agora!", usedFactIds: ["operating_status:unknown"], facts: [CLOSED_UNKNOWN_STATUS] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNAUTHORIZED_OPERATING_STATUS_CLAIM");
});

test("afirmação de aberto/fechado sem nenhum OPERATING_STATUS citado é rejeitada", () => {
  const result = validateResponseText({ text: "Estamos fechados agora.", usedFactIds: [], facts: [] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNAUTHORIZED_OPERATING_STATUS_CLAIM");
});

test("afirmação de aberto com OPERATING_STATUS.known === true é aprovada", () => {
  const result = validateResponseText({ text: "Sim, estamos abertos agora! Você pode retirar até às 18:00.", usedFactIds: ["operating_status:2026-01-01"], facts: [OPEN_STATUS] });
  assert.equal(result.ok, true);
});

test("texto contendo telefone/link não autorizado é rejeitado", () => {
  const result = validateResponseText({ text: "Chama no 85999998888 direto!", usedFactIds: [], facts: [] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "UNSAFE_CONTACT_MENTION");
});

test("texto vazio é rejeitado (fail-closed)", () => {
  const result = validateResponseText({ text: "   ", usedFactIds: [], facts: [] });
  assert.equal(result.ok, false);
});

test("texto válido citando só fatos presentes via usedFactIds correto é aprovado", () => {
  const result = validateResponseText({
    text: "Oi! O Brownie de Brigadeiro custa R$ 5,00 e estamos abertos até às 18:00.",
    usedFactIds: ["product:p1", "operating_status:2026-01-01"],
    facts: [PRODUCT, OPEN_STATUS],
  });
  assert.equal(result.ok, true);
});

test("resposta social sem nenhum fato citado (sem preço/endereço/horário) é aprovada", () => {
  const result = validateResponseText({ text: "Por nada! Fico à disposição.", usedFactIds: [], facts: [] });
  assert.equal(result.ok, true);
});
