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

for (const text of ["Vocês estão abertos?", "Posso retirar pedido agora?", "Que horas vocês abrem?", "Posso buscar hoje?", "Posso pegar agora?"]) {
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

for (const text of ["quanto é o dindin?", "qual o preço?"]) {
  test(`pergunta coloquial de preço mostra o cardápio real: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "MENU");
  });
}

for (const text of ["tem bolo?", "tem água?", "tem paçoca?"]) {
  test(`pergunta por produto específico é encaminhada ao catálogo do modelo: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text }), undefined);
  });
}

for (const text of ["quanto tá o kg da manga?", "e da uva", "pera", "morango?"]) {
  test(`produto de feira não cai em incompreensão: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "OUT_OF_SCOPE_PRODUCT");
  });
}

test("pergunta pelo valor total é factual e não depende do provider", () => {
  assert.equal(resolveFactualIntent({ text: "qual o valor total do meu pedido?" })?.kind, "CART_TOTAL");
});

for (const text of ["quem é o responsável?", "com quem eu falo?"]) {
  test(`pergunta pelo responsável é factual: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "RESPONSIBLE");
  });
}

for (const text of ["aceita cartão?", "como posso pagar?"]) {
  test(`pergunta de pagamento é factual: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "PAYMENT_OPTIONS");
  });
}

test("pergunta pela chave PIX é factual", () => {
  assert.equal(resolveFactualIntent({ text: "qual é o pix da loja?" })?.kind, "PIX_KEY");
});

for (const text of ["qual o horário de funcionamento?", "funciona aos finais de semana?"]) {
  test(`pergunta pelo horário completo é factual: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "OPERATING_HOURS");
  });
}

test("pergunta sobre comprovante de PIX não depende do modelo", () => {
  assert.equal(resolveFactualIntent({ text: "onde mando o comprovante?" })?.kind, "PAYMENT_PROOF");
});

for (const text of ["qual o WhatsApp?", "me manda o link do zap"]) {
  test(`pedido de contato do WhatsApp é factual: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "WHATSAPP_CONTACT");
  });
}

for (const text of ["faz entregas?", "tem delivery?"]) {
  test(`pergunta de entrega é factual: "${text}"`, () => {
    assert.equal(resolveFactualIntent({ text })?.kind, "DELIVERY");
  });
}

test("pergunta até que horas pode retirar usa o horário real", () => {
  assert.equal(resolveFactualIntent({ text: "até que horas eu posso ir pegar?", operatingStatus: OPEN_STATUS })?.kind, "PICKUP_AVAILABILITY");
});

test("mensagem sem relação com domínio não vira intenção factual nenhuma", () => {
  assert.equal(resolveFactualIntent({ text: "quero 2 brigadeiro", operatingStatus: OPEN_STATUS }), undefined);
});
