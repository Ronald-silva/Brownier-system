import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentConversationService,
  AgentConversationServiceError,
  type AgentConversationServiceDependencies,
} from "../src/agent/conversation.service.ts";
import { InMemoryAgentSessionStore, buildAgentSessionKey, type AgentSessionStore } from "../src/agent/session.store.ts";
import { createAgentTools, type AgentDomainStore, type AgentTools } from "../src/agent/tools.ts";
import { AgentConversationError, type AgentConversationAction } from "../src/agent/conversation.types.ts";
import type { AgentSession } from "../src/agent/session.types.ts";

// --- fábricas de teste (mesmo padrão de tests/agent_conversation_engine.test.ts) ---

function product(overrides: Partial<AgentDomainStore["products"][number]> = {}) {
  return {
    id: "p1", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "Descrição do brigadeiro",
    category: "Brownies", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20,
    isActive: true, isAvailable: true, displayOrder: 1, ingredients: "Chocolate", allergens: "Glúten",
    ...overrides,
  };
}

function makeDomainStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888",
      pickupEnabled: true, deliveryEnabled: true, deliveryFee: 5,
      pickupSlots: ["19:00", "18:00"], availabilityNotice: "Sabores podem variar.",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [product()],
    orders: [],
    ...overrides,
  };
}

function makeClock(startIso: string) {
  let current = new Date(startIso).getTime();
  return { now: () => new Date(current), advance(ms: number) { current += ms; } };
}

function makeService(overrides: Partial<AgentConversationServiceDependencies & { domainStore: AgentDomainStore }> = {}) {
  const domainStore = overrides.domainStore ?? makeDomainStore();
  const sessionStore = overrides.sessionStore ?? new InMemoryAgentSessionStore();
  const tools = overrides.tools ?? createAgentTools({ store: domainStore });
  const service = createAgentConversationService({
    sessionStore,
    tools,
    now: overrides.now,
    generateOrderIdempotencyKey: overrides.generateOrderIdempotencyKey,
  });
  return { service, sessionStore, tools, domainStore };
}

function wrapWithBrokenUpdate(base: AgentSessionStore): AgentSessionStore {
  return {
    get: sessionKey => base.get(sessionKey),
    create: input => base.create(input),
    getOrCreate: input => base.getOrCreate(input),
    update: () => { throw new Error("falha de persistência simulada"); },
    delete: sessionKey => base.delete(sessionKey),
    touch: sessionKey => base.touch(sessionKey),
    markMessageProcessed: (sessionKey, messageId) => base.markMessageProcessed(sessionKey, messageId),
    hasProcessedMessage: (sessionKey, messageId) => base.hasProcessedMessage(sessionKey, messageId),
    clearExpired: () => base.clearExpired(),
    size: () => base.size(),
  };
}

const START: AgentConversationAction = { type: "START_CONVERSATION" };
const SHOW_MENU: AgentConversationAction = { type: "SHOW_MENU" };

// --- 1-3: sessionKey e criação/reuso de sessão ---

test("gera sessionKey determinístico a partir de channel e contactId", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "(85) 99999-9999", action: START });
  assert.equal(result.sessionKey, buildAgentSessionKey("whatsapp", "85999999999"));
});

test("cria sessão inexistente em START, com step inicial START", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  assert.equal(result.sessionBefore.step, "START");
  assert.equal(result.sessionBefore.channel, "whatsapp");
  assert.equal(result.sessionBefore.contactId, "111");
  assert.deepEqual(result.sessionBefore.items, []);
});

test("reutiliza sessão existente em vez de recriar", () => {
  const { service } = makeService();
  const first = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  const second = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU });
  assert.equal(second.sessionBefore.createdAt, first.sessionAfter.createdAt);
  assert.equal(second.sessionBefore.step, "BROWSING_MENU");
});

// --- 4-6: chamada ao engine e persistência ---

test("chama o engine com a sessão atual e devolve o resultado dele", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  assert.equal(result.result.event, "WELCOME");
  assert.equal(result.result.currentStep, "BROWSING_MENU");
});

test("persiste a sessão retornada pelo engine no Session Store", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  const stored = sessionStore.get(result.sessionKey);
  assert.equal(stored?.step, "BROWSING_MENU");
});

test("sessionAfter reflete a sessão realmente persistida, não apenas o objeto do engine", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  const stored = sessionStore.get(result.sessionKey);
  assert.deepEqual(result.sessionAfter, stored);
  assert.deepEqual(result.result.session, stored);
});

// --- 7-10: messageId e deduplicação ---

test("mensagem sem messageId é processada normalmente e duplicateMessage é false", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  assert.equal(result.duplicateMessage, false);
  assert.equal(result.sessionAfter.processedMessageIds.length, 0);
});

test("messageId inédito é registrado como processado", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  assert.equal(sessionStore.hasProcessedMessage(result.sessionKey, "m1"), true);
  assert.deepEqual(result.sessionAfter.processedMessageIds, ["m1"]);
});

test("messageId repetido não chama o engine nem altera o estado de negócio", () => {
  const { service, domainStore } = makeService();
  service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  const before = JSON.parse(JSON.stringify(domainStore));
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m1" });
  assert.equal(result.duplicateMessage, true);
  assert.deepEqual(domainStore, before);
  assert.equal(result.sessionAfter.step, "BROWSING_MENU");
});

test("messageId repetido devolve MESSAGE_ALREADY_PROCESSED com a sessão atual, sem alterar o passo", () => {
  const { service } = makeService();
  const first = service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m1" });
  assert.equal(result.result.event, "MESSAGE_ALREADY_PROCESSED");
  assert.equal(result.result.messageKey, "MESSAGE_ALREADY_PROCESSED");
  assert.equal(result.result.previousStep, first.sessionAfter.step);
  assert.equal(result.result.currentStep, first.sessionAfter.step);
  assert.deepEqual(result.result.data, { messageId: "m1" });
});

// --- 11: mensagem repetida não cria segundo pedido (fluxo de confirmação) ---

function readySessionPayload(): { channel: string; contactId: string } {
  return { channel: "whatsapp", contactId: "222" };
}

function advanceToAwaitingConfirmation(service: ReturnType<typeof makeService>["service"]) {
  const { channel, contactId } = readySessionPayload();
  service.processAction({ channel, contactId, action: START });
  service.processAction({ channel, contactId, action: { type: "ADD_ITEM", productId: "p1", quantity: 2 } });
  service.processAction({ channel, contactId, action: { type: "FINISH_CART" } });
  service.processAction({ channel, contactId, action: { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" } });
  service.processAction({ channel, contactId, action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" } });
  service.processAction({ channel, contactId, action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" } });
  service.processAction({ channel, contactId, action: { type: "SET_PICKUP_TIME", pickupTime: "18:00" } });
  service.processAction({ channel, contactId, action: { type: "SKIP_CUSTOMER_NOTES" } });
  const last = service.processAction({ channel, contactId, action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" } });
  return last.sessionKey;
}

test("CONFIRM_ORDER repetido com o mesmo messageId cria apenas um pedido", () => {
  const { service, domainStore } = makeService();
  advanceToAwaitingConfirmation(service);
  const { channel, contactId } = readySessionPayload();
  const first = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-1" });
  const second = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-1" });
  assert.equal(first.result.event, "ORDER_CREATED");
  assert.equal(second.duplicateMessage, true);
  assert.equal(domainStore.orders.length, 1);
});

test("CONFIRM_ORDER com messageId diferente após o pedido já criado não gera um segundo pedido", () => {
  const { service, domainStore } = makeService();
  advanceToAwaitingConfirmation(service);
  const { channel, contactId } = readySessionPayload();
  const first = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-a" });
  const second = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-b" });
  assert.equal(first.result.event, "ORDER_CREATED");
  assert.equal(second.duplicateMessage, false);
  assert.equal(second.result.event, "INVALID_ACTION");
  assert.equal(second.sessionAfter.step, "ORDER_CREATED");
  assert.equal(domainStore.orders.length, 1);
});

// --- 12-13: erros técnicos não registram messageId ---

test("erro técnico do engine não registra messageId nem persiste sessão parcial", () => {
  const { service, sessionStore } = makeService({ generateOrderIdempotencyKey: () => "chave com espaço inválida" });
  const { channel, contactId } = readySessionPayload();
  const sessionKey = advanceToAwaitingConfirmation(service);
  assert.throws(
    () => service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-x" }),
    AgentConversationError,
  );
  assert.equal(sessionStore.hasProcessedMessage(sessionKey, "confirm-x"), false);
  const stored = sessionStore.get(sessionKey);
  assert.equal(stored?.step, "AWAITING_CONFIRMATION");
  assert.equal(stored?.createdOrderId, undefined);
});

test("erro de persistência não registra messageId e propaga o erro", () => {
  const base = new InMemoryAgentSessionStore();
  const broken = wrapWithBrokenUpdate(base);
  const { service } = makeService({ sessionStore: broken });
  assert.throws(() => service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" }));
  assert.equal(broken.hasProcessedMessage(buildAgentSessionKey("whatsapp", "111"), "m1"), false);
});

// --- 14-15: isolamento entre canais e contatos ---

test("canais diferentes para o mesmo contato ficam isolados", () => {
  const { service } = makeService();
  service.processAction({ channel: "whatsapp", contactId: "558500000001", action: START });
  const telegram = service.processAction({ channel: "telegram", contactId: "558500000001", action: START });
  assert.notEqual(telegram.sessionKey, buildAgentSessionKey("whatsapp", "558500000001"));
  assert.equal(telegram.sessionBefore.step, "START");
});

test("contatos diferentes no mesmo canal ficam isolados", () => {
  const { service } = makeService();
  service.processAction({ channel: "whatsapp", contactId: "558500000001", action: START });
  const other = service.processAction({ channel: "whatsapp", contactId: "558500000002", action: START });
  assert.equal(other.sessionBefore.step, "START");
  assert.equal(other.sessionBefore.items.length, 0);
});

// --- 16-18: cópias defensivas ---

test("sessionBefore é uma cópia defensiva", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  (result.sessionBefore as AgentSession).step = "ORDER_CREATED";
  const stored = sessionStore.get(result.sessionKey);
  assert.notEqual(stored?.step, "ORDER_CREATED");
});

test("sessionAfter é uma cópia defensiva e mutá-la não afeta o Session Store", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  result.sessionAfter.items.push({ productId: "injetado", quantity: 1 });
  const stored = sessionStore.get(result.sessionKey);
  assert.equal(stored?.items.length, 0);
});

test("mutar o resultado devolvido não altera o domain store internamente", () => {
  const { service, domainStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  (result.result.data as { products: unknown[] }).products.push({ id: "fake" });
  assert.equal(domainStore.products.length, 1);
});

// --- 19: expiresAt continua sob responsabilidade do Session Store ---

test("expiresAt é renovado pelo Session Store, não calculado pelo service", () => {
  const clock = makeClock("2026-07-28T10:00:00.000Z");
  const sessionStore = new InMemoryAgentSessionStore({ now: clock.now });
  const { service } = makeService({ sessionStore });
  const first = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  clock.advance(1000);
  const second = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU });
  assert.ok(new Date(second.sessionAfter.expiresAt).getTime() > new Date(first.sessionAfter.expiresAt).getTime());
});

// --- 20: limite de processedMessageIds já implementado no store é respeitado ---

test("processedMessageIds respeita o limite configurado no Session Store", () => {
  const sessionStore = new InMemoryAgentSessionStore({ maxProcessedMessageIds: 3 });
  const { service } = makeService({ sessionStore });
  service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m2" });
  service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m3" });
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m4" });
  assert.deepEqual(result.sessionAfter.processedMessageIds, ["m2", "m3", "m4"]);
});

// --- messageId inválido é rejeitado sem tocar o engine ---

test("messageId vazio ou apenas espaços é rejeitado com erro técnico controlado", () => {
  const { service } = makeService();
  assert.throws(
    () => service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "   " }),
    AgentConversationServiceError,
  );
});

// --- fluxo completo até ORDER_CREATED ---

test("fluxo completo START..CONFIRM_ORDER cria um pedido e preserva todos os messageIds", () => {
  const { service, sessionStore, domainStore } = makeService();
  const channel = "whatsapp";
  const contactId = "333";
  const steps: Array<{ action: AgentConversationAction; messageId: string }> = [
    { action: { type: "START_CONVERSATION" }, messageId: "msg-1" },
    { action: { type: "SHOW_MENU" }, messageId: "msg-2" },
    { action: { type: "ADD_ITEM", productId: "p1", quantity: 2 }, messageId: "msg-3" },
    { action: { type: "FINISH_CART" }, messageId: "msg-4" },
    { action: { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" }, messageId: "msg-5" },
    { action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" }, messageId: "msg-6" },
    { action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, messageId: "msg-7" },
    { action: { type: "SET_PICKUP_TIME", pickupTime: "18:00" }, messageId: "msg-8" },
    { action: { type: "SKIP_CUSTOMER_NOTES" }, messageId: "msg-9" },
    { action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, messageId: "msg-10" },
    { action: { type: "REVIEW_ORDER" }, messageId: "msg-11" },
    { action: { type: "CONFIRM_ORDER" }, messageId: "msg-12" },
  ];
  let last: ReturnType<typeof service.processAction> | undefined;
  const sessionKeys = new Set<string>();
  for (const step of steps) {
    last = service.processAction({ channel, contactId, action: step.action, messageId: step.messageId });
    sessionKeys.add(last.sessionKey);
  }
  assert.equal(sessionKeys.size, 1);
  assert.equal(last?.sessionAfter.step, "ORDER_CREATED");
  assert.ok(last?.sessionAfter.createdOrderPublicCode);
  assert.deepEqual(
    last?.sessionAfter.processedMessageIds,
    steps.map(s => s.messageId),
  );
  assert.equal(domainStore.orders.length, 1);
  const stored = sessionStore.get(last!.sessionKey);
  assert.equal(stored?.step, "ORDER_CREATED");
});
