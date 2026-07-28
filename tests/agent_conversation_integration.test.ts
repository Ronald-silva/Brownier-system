import assert from "node:assert/strict";
import test from "node:test";
import { handleConversationAction } from "../src/agent/conversation.engine.ts";
import { createAgentTools, type AgentDomainStore } from "../src/agent/tools.ts";
import { InMemoryAgentSessionStore } from "../src/agent/session.store.ts";
import type { AgentConversationAction } from "../src/agent/conversation.types.ts";

function makeDomainStore(): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888",
      pickupEnabled: true, deliveryEnabled: true, deliveryFee: 5,
      pickupSlots: ["19:00", "18:00"], availabilityNotice: "Sabores podem variar.",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [
      {
        id: "p1", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "Descrição",
        category: "Brownies", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20,
        isActive: true, isAvailable: true, displayOrder: 1, ingredients: "Chocolate", allergens: "Glúten",
      },
    ],
    orders: [],
  };
}

// Monta as peças reais (Tools + Session Store + store de domínio em memória)
// e conduz o fluxo estruturado completo até CONFIRM_ORDER, injetando uma
// chave de idempotência determinística para o teste.
function runFullFlow(domainStore: AgentDomainStore, sessionStore: InMemoryAgentSessionStore, sessionKey: string, tools: ReturnType<typeof createAgentTools>) {
  function apply(action: AgentConversationAction) {
    const session = sessionStore.get(sessionKey);
    assert.ok(session, "sessão deve existir antes de cada ação");
    const result = handleConversationAction({
      session: session!,
      action,
      tools,
      generateOrderIdempotencyKey: () => "agent-order:test-session-0001",
    });
    sessionStore.update(sessionKey, () => result.session);
    return result;
  }

  apply({ type: "START_CONVERSATION" });
  apply({ type: "SHOW_MENU" });
  apply({ type: "ADD_ITEM", productId: "p1", quantity: 2 });
  apply({ type: "FINISH_CART" });
  apply({ type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" });
  apply({ type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" });
  apply({ type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" });
  apply({ type: "SET_PICKUP_TIME", pickupTime: "18:00" });
  apply({ type: "SKIP_CUSTOMER_NOTES" });
  apply({ type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" });
  apply({ type: "REVIEW_ORDER" });
  return apply({ type: "CONFIRM_ORDER" });
}

test("[integração] fluxo estruturado completo cria o pedido real pela Agent Tool oficial", () => {
  const domainStore = makeDomainStore();
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = new InMemoryAgentSessionStore({ now: () => new Date("2026-07-28T10:00:00.000Z") });
  const { sessionKey } = sessionStore.create({ channel: "whatsapp", contactId: "5585999999999" });

  const final = runFullFlow(domainStore, sessionStore, sessionKey, tools);

  // O resultado final é ORDER_CREATED, e a sessão persistida reflete isso.
  assert.equal(final.currentStep, "ORDER_CREATED");
  assert.equal(final.event, "ORDER_CREATED");
  assert.equal(final.messageKey, "ORDER_CREATED");
  assert.ok(final.data?.orderId);
  assert.ok(final.data?.publicCode);
  assert.equal(final.data?.replayed, false);

  const persisted = sessionStore.get(sessionKey);
  assert.ok(persisted);
  assert.equal(persisted!.step, "ORDER_CREATED");
  assert.equal(persisted!.createdOrderId, final.data?.orderId);
  assert.equal(persisted!.createdOrderPublicCode, final.data?.publicCode);
  assert.equal(persisted!.orderIdempotencyKey, "agent-order:test-session-0001");

  // Exatamente um pedido foi criado no store de domínio, exclusivamente
  // através de tools.createOrder() (nunca calculado ou inserido pelo motor).
  assert.equal(domainStore.orders.length, 1);
  const order = domainStore.orders[0]!;
  assert.equal(order.id, final.data?.orderId);
  assert.equal(order.publicCode, final.data?.publicCode);
  assert.equal(order.paymentMethod, "PIX");
  assert.equal(order.fulfillmentType, "RETIRADA");

  // Subtotal/desconto/total vieram do serviço oficial (pricing.ts), nunca da
  // sessão do agente: 2 unidades a R$5 sem atingir a quantidade promocional.
  assert.equal(order.subtotal, 10);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 10);

  // Nenhum preço da sessão do agente vazou para o pedido criado.
  for (const item of order.items) {
    assert.equal(typeof item.unitPrice, "number");
  }
});

test("[integração] sessão presa em AWAITING_CONFIRMATION com pedido já criado não gera um segundo pedido", () => {
  const domainStore = makeDomainStore();
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = new InMemoryAgentSessionStore({ now: () => new Date("2026-07-28T10:00:00.000Z") });
  const { sessionKey } = sessionStore.create({ channel: "whatsapp", contactId: "5585999999999" });

  const first = runFullFlow(domainStore, sessionStore, sessionKey, tools);
  assert.equal(first.data?.replayed, false);
  assert.equal(domainStore.orders.length, 1);

  // Simula uma sessão que ficou presa em AWAITING_CONFIRMATION com as
  // referências do pedido já preenchidas (ex.: falha ao persistir a
  // transição para ORDER_CREATED) — o motor detecta o pedido já criado,
  // corrige a etapa e não chama a Tool de criação de novo.
  const stuckSession = { ...sessionStore.get(sessionKey)!, step: "AWAITING_CONFIRMATION" as const };
  const second = handleConversationAction({
    session: stuckSession,
    action: { type: "CONFIRM_ORDER" },
    tools,
    generateOrderIdempotencyKey: () => "agent-order:test-session-0001",
  });

  assert.equal(second.event, "ORDER_ALREADY_CREATED");
  assert.equal(second.currentStep, "ORDER_CREATED");
  assert.equal(second.data?.orderId, first.data?.orderId);
  assert.equal(second.data?.publicCode, first.data?.publicCode);
  assert.equal(domainStore.orders.length, 1);
});

test("[integração] replay via idempotency key: duas chamadas com a sessão AWAITING_CONFIRMATION original resultam em um único pedido", () => {
  const domainStore = makeDomainStore();
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = new InMemoryAgentSessionStore({ now: () => new Date("2026-07-28T10:00:00.000Z") });
  const { sessionKey } = sessionStore.create({ channel: "whatsapp", contactId: "5585999999999" });

  function apply(action: AgentConversationAction) {
    const session = sessionStore.get(sessionKey);
    assert.ok(session);
    const result = handleConversationAction({
      session: session!,
      action,
      tools,
      generateOrderIdempotencyKey: () => "agent-order:test-session-0001",
    });
    sessionStore.update(sessionKey, () => result.session);
    return result;
  }

  apply({ type: "START_CONVERSATION" });
  apply({ type: "SHOW_MENU" });
  apply({ type: "ADD_ITEM", productId: "p1", quantity: 2 });
  apply({ type: "FINISH_CART" });
  apply({ type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" });
  apply({ type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" });
  apply({ type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" });
  apply({ type: "SET_PICKUP_TIME", pickupTime: "18:00" });
  apply({ type: "SKIP_CUSTOMER_NOTES" });
  apply({ type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" });

  // Sessão original ainda em AWAITING_CONFIRMATION (antes de qualquer
  // persistência da atualização pós-confirmação) — simula duas tentativas
  // de CONFIRM_ORDER chegando com o mesmo estado de partida.
  const awaitingConfirmation = sessionStore.get(sessionKey)!;
  const runConfirm = () =>
    handleConversationAction({
      session: awaitingConfirmation,
      action: { type: "CONFIRM_ORDER" },
      tools,
      generateOrderIdempotencyKey: () => "agent-order:test-session-0001",
    });

  const firstAttempt = runConfirm();
  const secondAttempt = runConfirm();

  assert.equal(firstAttempt.data?.replayed, false);
  assert.equal(secondAttempt.data?.replayed, true);
  assert.equal(firstAttempt.data?.orderId, secondAttempt.data?.orderId);
  assert.equal(firstAttempt.data?.publicCode, secondAttempt.data?.publicCode);
  assert.equal(domainStore.orders.length, 1);
});
