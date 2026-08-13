import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { renderConversationResult, renderConversationPresentation, renderTextConversationPolicyMessage } from "../src/agent/renderer.ts";
import type { AgentConversationResult } from "../src/agent/conversation.types.ts";
import type { AgentConversationPresentation, AgentPresentationContext } from "../src/agent/presentation.ts";

function makeResult(overrides: Partial<AgentConversationResult>): AgentConversationResult {
  return {
    session: {} as AgentConversationResult["session"],
    previousStep: "START",
    currentStep: "START",
    event: "TEST",
    messageKey: "WELCOME",
    ...overrides,
  };
}

test("renderConversationResult sempre devolve um array", () => {
  const messages = renderConversationResult(makeResult({ messageKey: "ASK_CUSTOMER_NAME" }));
  assert.ok(Array.isArray(messages));
});

test("WELCOME inclui o nome do negócio", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "WELCOME", data: { business: { name: "Brownieria Fortal" }, products: [] } }),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "text");
  assert.match(messages[0].text, /Brownieria Fortal/);
});

test("MENU_READY monta o cardápio a partir de data.products", () => {
  const messages = renderConversationResult(
    makeResult({
      messageKey: "MENU_READY",
      data: { products: [{ name: "Brownie Tradicional", basePrice: 12 }] },
    }),
  );
  assert.match(messages[0].text, /Brownie Tradicional/);
  assert.match(messages[0].text, /R\$ 12,00/);
});

test("MENU_READY não lança erro com lista de produtos vazia", () => {
  assert.doesNotThrow(() =>
    renderConversationResult(makeResult({ messageKey: "MENU_READY", data: { products: [] } })),
  );
});

test("ITEM_ADDED informa a quantidade atual", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "ITEM_ADDED", data: { productId: "brownie-1", quantity: 3 } }),
  );
  assert.match(messages[0].text, /3x/);
});

test("ASK_PAYMENT_METHOD monta as opções a partir de data.options", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "ASK_PAYMENT_METHOD", data: { options: ["PIX", "DINHEIRO", "CARTÃO"] } }),
  );
  assert.match(messages[0].text, /• PIX/);
  assert.match(messages[0].text, /• DINHEIRO/);
  assert.match(messages[0].text, /• CARTÃO/);
});

test("ASK_PAYMENT_METHOD não lança erro quando data.options está ausente", () => {
  assert.doesNotThrow(() => renderConversationResult(makeResult({ messageKey: "ASK_PAYMENT_METHOD" })));
});

test("PAYMENT_METHOD_ACCEPTED confirma a forma de pagamento escolhida", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "PAYMENT_METHOD_ACCEPTED", data: { paymentMethod: "PIX" } }),
  );
  assert.match(messages[0].text, /PIX/);
});

test("ORDER_REVIEW monta o resumo do pedido", () => {
  const messages = renderConversationResult(
    makeResult({
      messageKey: "ORDER_REVIEW",
      data: {
        items: [{ productId: "brownie-1", quantity: 2, product: { name: "Brownie Tradicional" } }],
        customerName: "José",
        pickupTime: "19:00",
        paymentMethod: "PIX",
      },
    }),
  );
  const text = messages[0].text;
  assert.match(text, /2x Brownie Tradicional/);
  assert.match(text, /19:00/);
  assert.match(text, /PIX/);
  assert.match(text, /José/);
});

test("ORDER_CREATED expõe o código público, nunca o id interno", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "ORDER_CREATED", data: { orderId: "internal-uuid-123", publicCode: "ABC123" } }),
  );
  assert.match(messages[0].text, /ABC123/);
  assert.doesNotMatch(messages[0].text, /internal-uuid-123/);
});

test("INVALID_ACTION nunca expõe detalhes técnicos", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "INVALID_ACTION", data: { currentStep: "START", actionType: "FOO" } }),
  );
  assert.doesNotMatch(messages[0].text, /START/);
  assert.doesNotMatch(messages[0].text, /FOO/);
});

test("INVALID_PRODUCT informa mensagem amigável", () => {
  const messages = renderConversationResult(makeResult({ messageKey: "INVALID_PRODUCT", data: { productId: "xyz" } }));
  assert.ok(messages[0].text.length > 0);
});

test("ORDER_CREATION_FAILED traduz o código em mensagem amigável", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "ORDER_CREATION_FAILED", data: { code: "invalid_pickup_time" } }),
  );
  assert.doesNotMatch(messages[0].text, /invalid_pickup_time/);
  assert.ok(messages[0].text.length > 0);
});

test("ORDER_CREATION_FAILED nunca lança erro para código desconhecido", () => {
  assert.doesNotThrow(() =>
    renderConversationResult(makeResult({ messageKey: "ORDER_CREATION_FAILED", data: { code: "algo_novo" } })),
  );
});

test("MESSAGE_ALREADY_PROCESSED devolve array vazio", () => {
  const messages = renderConversationResult(
    makeResult({ messageKey: "MESSAGE_ALREADY_PROCESSED", data: { messageId: "m1" } }),
  );
  assert.deepEqual(messages, []);
});

test("placeholder inexistente no data não lança erro e fica vazio", () => {
  assert.doesNotThrow(() => renderConversationResult(makeResult({ messageKey: "CUSTOMER_PHONE_SET" })));
});

test("nenhum messageKey conhecido fica sem mensagem renderizada", () => {
  const keys = [
    "WELCOME", "MENU_READY", "CART_READY", "ITEM_ADDED", "ITEMS_ADDED_BATCH", "ITEM_QUANTITY_UPDATED", "ITEM_REMOVED",
    "CART_EMPTY", "INVALID_PRODUCT", "INVALID_QUANTITY", "ASK_CUSTOMER_NAME", "INVALID_CUSTOMER_NAME",
    "CUSTOMER_PHONE_SET", "INVALID_CUSTOMER_PHONE", "ASK_FULFILLMENT", "ASK_PICKUP_TIME", "INVALID_PICKUP_TIME",
    "ASK_NOTES", "INVALID_CUSTOMER_NOTES", "ASK_PAYMENT_METHOD", "PAYMENT_METHOD_ACCEPTED", "PAYMENT_METHOD_INVALID",
    "PAYMENT_METHOD_UNAVAILABLE", "PAYMENT_METHOD_REQUIRED", "ORDER_REVIEW", "INCOMPLETE_ORDER_DATA",
    "ORDER_CREATED", "ORDER_ALREADY_CREATED", "ORDER_CREATION_FAILED", "INVALID_ACTION",
    "CONVERSATION_CANCELLED", "CONVERSATION_RESET", "HUMAN_HANDOFF_STARTED",
  ];
  for (const key of keys) {
    const messages = renderConversationResult(makeResult({ messageKey: key }));
    assert.equal(messages.length, 1, `esperava 1 mensagem para ${key}`);
    assert.equal(messages[0].type, "text");
    assert.equal(typeof messages[0].text, "string");
  }
});

// --- renderConversationPresentation (caminho oficial, com contexto) --------

function makePresentation(
  messageKey: string,
  context: AgentPresentationContext,
  data?: Record<string, unknown>,
): AgentConversationPresentation {
  return {
    result: makeResult({ messageKey, data }),
    session: {} as AgentConversationResult["session"],
    context,
  };
}

test("renderConversationPresentation sempre devolve um array", () => {
  const messages = renderConversationPresentation(makePresentation("ASK_CUSTOMER_NAME", {}));
  assert.ok(Array.isArray(messages));
});

test("WELCOME com nome do negócio no contexto", () => {
  const messages = renderConversationPresentation(makePresentation("WELCOME", { business: { name: "Brownieria Fortal" } }));
  assert.match(messages[0].text, /Brownieria Fortal/);
});

test("WELCOME sem nome do negócio produz saudação válida", () => {
  const messages = renderConversationPresentation(makePresentation("WELCOME", {}));
  assert.doesNotMatch(messages[0].text, /undefined/);
  assert.ok(messages[0].text.length > 0);
});

test("MENU_READY completo usa os produtos do contexto", () => {
  const messages = renderConversationPresentation(
    makePresentation("MENU_READY", { products: [{ id: "p1", name: "Brownie Tradicional", price: 12 }] }),
  );
  assert.match(messages[0].text, /Brownie Tradicional/);
  assert.match(messages[0].text, /R\$ 12,00/);
});

test("ITEM_ADDED com nome do produto resolvido", () => {
  const messages = renderConversationPresentation(
    makePresentation("ITEM_ADDED", { currentProduct: { id: "p1", name: "Brownie de Brigadeiro" } }, { quantity: 2 }),
  );
  assert.match(messages[0].text, /Brownie de Brigadeiro/);
  assert.match(messages[0].text, /2x/);
});

test("ITEM_ADDED informa o total parcial calculado pelo servidor", () => {
  const messages = renderConversationPresentation(
    makePresentation(
      "ITEM_ADDED",
      {
        currentProduct: { id: "p1", name: "Brownie de Brigadeiro" },
        cartQuote: { items: [], subtotal: 24, discount: 0, total: 24 },
      },
      { quantity: 2 },
    ),
  );
  assert.match(messages[0].text, /Total parcial: R\$ 24,00/);
});

test("ORDER_REVIEW informa desconto e total do pedido", () => {
  const messages = renderConversationPresentation(
    makePresentation("ORDER_REVIEW", {
      cartItems: [{ productId: "p1", name: "Brownie de Brigadeiro", quantity: 20, unitPrice: 3 }],
      cartQuote: { items: [], subtotal: 60, discount: 40, total: 60 },
    }),
  );
  assert.match(messages[0].text, /Desconto:\nR\$ 40,00/);
  assert.match(messages[0].text, /Total do pedido:\nR\$ 60,00/);
});

test("ITEM_ADDED sem nome resolvido usa mensagem genérica sem productId técnico", () => {
  const messages = renderConversationPresentation(makePresentation("ITEM_ADDED", {}, { productId: "p1", quantity: 2 }));
  assert.doesNotMatch(messages[0].text, /p1/);
  assert.match(messages[0].text, /2x/);
});

test("ITEMS_ADDED_BATCH lista todos os produtos do lote, não só o último", () => {
  const messages = renderConversationPresentation(
    makePresentation("ITEMS_ADDED_BATCH", {
      cartItems: [
        { productId: "p1", name: "Brownie de Brigadeiro", quantity: 2 },
        { productId: "p2", name: "Brownie de Ninho", quantity: 1 },
      ],
    }),
  );
  assert.match(messages[0].text, /2x Brownie de Brigadeiro/);
  assert.match(messages[0].text, /1x Brownie de Ninho/);
});

test("ITEMS_ADDED_BATCH sem itens resolvidos não lança erro e não fica em branco", () => {
  const messages = renderConversationPresentation(makePresentation("ITEMS_ADDED_BATCH", { cartItems: [] }));
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.length > 0);
});

test("ASK_PAYMENT_METHOD com opções no contexto", () => {
  const messages = renderConversationPresentation(makePresentation("ASK_PAYMENT_METHOD", { paymentOptions: ["PIX", "DINHEIRO"] }));
  assert.match(messages[0].text, /• PIX/);
  assert.match(messages[0].text, /• DINHEIRO/);
});

test("ASK_PAYMENT_METHOD sem opções usa mensagem segura de indisponibilidade", () => {
  const messages = renderConversationPresentation(makePresentation("ASK_PAYMENT_METHOD", { paymentOptions: [] }));
  assert.match(messages[0].text, /não há formas de pagamento/);
});

test("ASK_PICKUP_TIME com horários lista os horários", () => {
  const messages = renderConversationPresentation(makePresentation("ASK_PICKUP_TIME", { pickupSlots: ["18:00", "19:00"] }));
  assert.match(messages[0].text, /18:00/);
  assert.match(messages[0].text, /19:00/);
});

test("ASK_PICKUP_TIME sem horários não lança erro e não inventa horário", () => {
  const messages = renderConversationPresentation(makePresentation("ASK_PICKUP_TIME", { pickupSlots: [] }));
  assert.ok(messages[0].text.length > 0);
  assert.doesNotMatch(messages[0].text, /undefined/);
});

test("ORDER_REVIEW com todos os campos do contexto", () => {
  const messages = renderConversationPresentation(
    makePresentation("ORDER_REVIEW", {
      cartItems: [{ productId: "p1", name: "Brownie Tradicional", quantity: 2, unitPrice: 12 }],
      customerName: "José",
      pickupTime: "19:00",
      paymentMethod: "PIX",
      customerNotes: "sem açúcar",
    }),
  );
  const text = messages[0].text;
  assert.match(text, /2x Brownie Tradicional/);
  assert.match(text, /19:00/);
  assert.match(text, /PIX/);
  assert.match(text, /José/);
  assert.match(text, /sem açúcar/);
});

test("ORDER_REVIEW sem notas não exibe seção de observações", () => {
  const messages = renderConversationPresentation(
    makePresentation("ORDER_REVIEW", {
      cartItems: [{ productId: "p1", name: "Brownie Tradicional", quantity: 1 }],
      customerName: "José",
    }),
  );
  assert.doesNotMatch(messages[0].text, /Observações/);
});

test("ORDER_REVIEW não exibe undefined quando campos estão ausentes", () => {
  const messages = renderConversationPresentation(
    makePresentation("ORDER_REVIEW", { cartItems: [{ productId: "p1", name: "Brownie Tradicional", quantity: 1 }] }),
  );
  assert.doesNotMatch(messages[0].text, /undefined/);
});

test("ORDER_REVIEW não exibe seções vazias desnecessárias (Retirada/Pagamento/Nome ausentes)", () => {
  const messages = renderConversationPresentation(
    makePresentation("ORDER_REVIEW", { cartItems: [{ productId: "p1", name: "Brownie Tradicional", quantity: 1 }] }),
  );
  assert.doesNotMatch(messages[0].text, /Retirada:/);
  assert.doesNotMatch(messages[0].text, /Pagamento:/);
  assert.doesNotMatch(messages[0].text, /Nome:/);
});

test("ORDER_CREATED exibe apenas publicCode do contexto", () => {
  const messages = renderConversationPresentation(makePresentation("ORDER_CREATED", { order: { publicCode: "ABC123" } }));
  assert.match(messages[0].text, /ABC123/);
});

test("ORDER_ALREADY_CREATED exibe publicCode do contexto", () => {
  const messages = renderConversationPresentation(makePresentation("ORDER_ALREADY_CREATED", { order: { publicCode: "XYZ999" } }));
  assert.match(messages[0].text, /XYZ999/);
});

test("MESSAGE_ALREADY_PROCESSED (via presentation) devolve array vazio", () => {
  const messages = renderConversationPresentation(makePresentation("MESSAGE_ALREADY_PROCESSED", {}));
  assert.deepEqual(messages, []);
});

test("renderConversationPresentation sempre devolve array mesmo com contexto vazio", () => {
  for (const key of ["WELCOME", "MENU_READY", "ORDER_REVIEW", "ASK_PAYMENT_METHOD", "ASK_PICKUP_TIME"]) {
    const messages = renderConversationPresentation(makePresentation(key, {}));
    assert.ok(Array.isArray(messages));
  }
});

test("renderTextConversationPolicyMessage renderiza POLICY_LLM_TEMPORARILY_UNAVAILABLE", () => {
  const messages = renderTextConversationPolicyMessage({ messageKey: "POLICY_LLM_TEMPORARILY_UNAVAILABLE" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.metadata?.policyMessageKey, "POLICY_LLM_TEMPORARILY_UNAVAILABLE");
  assert.match(messages[0]!.text, /cardápio|pedido|atendente/i);
  assert.doesNotMatch(messages[0]!.text, /Não consegui processar sua mensagem agora/);
});

test("renderTextConversationPolicyMessage informa o total sem depender do LLM", () => {
  const messages = renderTextConversationPolicyMessage({ messageKey: "CART_TOTAL", data: { total: "R$ 24,00" } });
  assert.match(messages[0].text, /R\$ 24,00/);
});

test("renderTextConversationPolicyMessage redireciona produto fora do cardápio sem handoff", () => {
  const messages = renderTextConversationPolicyMessage({ messageKey: "OUT_OF_SCOPE_PRODUCT" });
  assert.match(messages[0].text, /brownies/i);
  assert.match(messages[0].text, /não com produtos por quilo/i);
});

test("Renderer não importa Agent Tools", async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, "..", "src", "agent", "renderer.ts"), "utf8");
  assert.doesNotMatch(source, /["']\.\/tools\.ts["']/);
});
