import assert from "node:assert/strict";
import test from "node:test";
import { decideRenderStrategy } from "../src/agent/response-strategy-policy.ts";
import type { AllowedFact, ResponseIntent } from "../src/agent/conversation-intelligence.types.ts";

const PRODUCT_FACT: AllowedFact = { factId: "product:p1", key: "PRODUCT", id: "p1", name: "Brownie", price: 5, promotionalPrice: null };

test("confidence LOW sempre produz TEMPLATE, independente do restante do plano", () => {
  const responseIntents: ResponseIntent[] = [
    { kind: "SOCIAL_ACK" },
    { kind: "ANSWER_FACTUAL", factKeys: ["PRODUCT"] },
    { kind: "ACKNOWLEDGE_OBJECTION" },
  ];
  for (const responseIntent of responseIntents) {
    assert.equal(decideRenderStrategy({ confidence: "LOW", responseIntent, facts: [PRODUCT_FACT] }), "TEMPLATE");
    assert.equal(decideRenderStrategy({ confidence: "LOW", responseIntent, facts: [] }), "TEMPLATE");
  }
});

test("CONFIRM_ACTION_RESULT sempre produz TEMPLATE (rota de economia)", () => {
  assert.equal(decideRenderStrategy({ confidence: "HIGH", responseIntent: { kind: "CONFIRM_ACTION_RESULT" }, facts: [PRODUCT_FACT] }), "TEMPLATE");
  assert.equal(decideRenderStrategy({ confidence: "HIGH", responseIntent: { kind: "CONFIRM_ACTION_RESULT" }, facts: [] }), "TEMPLATE");
});

test("ANSWER_FACTUAL sem nenhum AllowedFact produz TEMPLATE", () => {
  assert.equal(decideRenderStrategy({ confidence: "HIGH", responseIntent: { kind: "ANSWER_FACTUAL", factKeys: ["PRODUCT"] }, facts: [] }), "TEMPLATE");
});

test("ANSWER_FACTUAL com fatos autorizados produz VERBALIZE", () => {
  assert.equal(decideRenderStrategy({ confidence: "HIGH", responseIntent: { kind: "ANSWER_FACTUAL", factKeys: ["PRODUCT"] }, facts: [PRODUCT_FACT] }), "VERBALIZE");
});

test("OFFER_SUGGESTION sem fatos produz TEMPLATE", () => {
  assert.equal(decideRenderStrategy({ confidence: "HIGH", responseIntent: { kind: "OFFER_SUGGESTION", productIds: ["p1"] }, facts: [] }), "TEMPLATE");
});

test("intenções sociais/de recusa/handoff verbalizam mesmo sem nenhum fato — 'sem fatos = template' não se aplica a elas", () => {
  const withoutFactsKinds: ResponseIntent[] = [
    { kind: "SOCIAL_ACK" },
    { kind: "ASK_CLARIFICATION", ambiguityReason: "mais de um produto possível" },
    { kind: "ACKNOWLEDGE_OBJECTION" },
    { kind: "DECLINE_OUT_OF_SCOPE" },
    { kind: "REQUEST_HUMAN_ACK" },
  ];
  for (const responseIntent of withoutFactsKinds) {
    assert.equal(decideRenderStrategy({ confidence: "HIGH", responseIntent, facts: [] }), "VERBALIZE");
  }
});

test("nenhum input de teste vem de um valor escolhido pelo modelo — a política nunca lê nada além de confidence/responseIntent/facts já validados", () => {
  // Documentação executável: a assinatura de decideRenderStrategy não aceita
  // provider, sessão ou texto livre — só os três campos determinísticos.
  const input = { confidence: "HIGH" as const, responseIntent: { kind: "SOCIAL_ACK" as const }, facts: [] as AllowedFact[] };
  assert.equal(Object.keys(input).length, 3);
  assert.equal(decideRenderStrategy(input), "VERBALIZE");
});

// Regra 0 — confirmação de pedido nunca pode depender só de responseIntent,
// que é auto-reportado pelo modelo. Ver docs/audits: um plano com
// actions: [CONFIRM_ORDER] e um responseIntent "errado" (ex.: SOCIAL_ACK)
// não pode escapar do template determinístico.
test("CONFIRM_ORDER como ação executada sempre produz TEMPLATE, mesmo com responseIntent divergente, confidence HIGH e fatos presentes", () => {
  assert.equal(
    decideRenderStrategy({
      confidence: "HIGH",
      responseIntent: { kind: "SOCIAL_ACK" },
      facts: [PRODUCT_FACT],
      executedActionType: "CONFIRM_ORDER",
    }),
    "TEMPLATE",
  );
});

test("CONFIRM_ORDER como ação executada produz TEMPLATE mesmo sem nenhum responseIntent do modelo (fallback CONFIRM_ACTION_RESULT já cobriria, mas a Regra 0 não depende disso)", () => {
  assert.equal(
    decideRenderStrategy({
      confidence: "HIGH",
      responseIntent: { kind: "CONFIRM_ACTION_RESULT" },
      facts: [],
      executedActionType: "CONFIRM_ORDER",
    }),
    "TEMPLATE",
  );
});

test("messageKey ORDER_CREATED sempre produz TEMPLATE, mesmo com responseIntent divergente e sem executedActionType informado", () => {
  assert.equal(
    decideRenderStrategy({
      confidence: "HIGH",
      responseIntent: { kind: "SOCIAL_ACK" },
      facts: [],
      messageKey: "ORDER_CREATED",
    }),
    "TEMPLATE",
  );
});

test("messageKey ORDER_ALREADY_CREATED sempre produz TEMPLATE, mesmo com responseIntent divergente", () => {
  assert.equal(
    decideRenderStrategy({
      confidence: "HIGH",
      responseIntent: { kind: "ACKNOWLEDGE_OBJECTION" },
      facts: [],
      messageKey: "ORDER_ALREADY_CREATED",
    }),
    "TEMPLATE",
  );
});

test("Regra 0 não interfere em ações/messageKeys fora da confirmação de pedido — comportamento normal preservado", () => {
  assert.equal(
    decideRenderStrategy({
      confidence: "HIGH",
      responseIntent: { kind: "ANSWER_FACTUAL", factKeys: ["PRODUCT"] },
      facts: [PRODUCT_FACT],
      executedActionType: "ADD_ITEM",
      messageKey: "ITEM_ADDED",
    }),
    "VERBALIZE",
  );
});
