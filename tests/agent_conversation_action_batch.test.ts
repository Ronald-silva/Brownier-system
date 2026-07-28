import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BATCH_ACTIONS,
  checkBatchStructure,
  preflightConversationActions,
  executeConversationActionBatch,
} from "../src/agent/conversation-action-batch.ts";
import { createAgentConversationService } from "../src/agent/conversation.service.ts";
import { InMemoryAgentSessionStore, buildAgentSessionKey } from "../src/agent/session.store.ts";
import { createAgentTools, type AgentDomainStore } from "../src/agent/tools.ts";
import type { AgentConversationAction } from "../src/agent/conversation.types.ts";
import type { AgentSession } from "../src/agent/session.types.ts";

function makeDomainStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888",
      pickupEnabled: true, deliveryEnabled: false, deliveryFee: 0,
      pickupSlots: ["18:00", "19:00"], availabilityNotice: "",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [
      { id: "brownie-tradicional", slug: "tradicional", name: "Brownie Tradicional", description: "D", category: "Brownies", basePrice: 5, promotionalPrice: null, minimumPromotionalQuantity: null, isActive: true, isAvailable: true, displayOrder: 1, ingredients: "", allergens: "" },
      { id: "brownie-ninho", slug: "ninho", name: "Brownie Ninho", description: "D", category: "Brownies", basePrice: 6, promotionalPrice: null, minimumPromotionalQuantity: null, isActive: true, isAvailable: true, displayOrder: 2, ingredients: "", allergens: "" },
    ],
    orders: [],
    ...overrides,
  };
}

function makeStack(step: AgentSession["step"] = "BUILDING_ORDER") {
  const domainStore = makeDomainStore();
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = new InMemoryAgentSessionStore();
  const conversationService = createAgentConversationService({ sessionStore, tools });
  const session = sessionStore.getOrCreate({ channel: "simulator", contactId: "c1", step });
  return { domainStore, tools, sessionStore, conversationService, session };
}

// --- checkBatchStructure ---

test("lote vazio é rejeitado", () => {
  assert.deepEqual(checkBatchStructure([]), { ok: false, reason: "EMPTY_BATCH" });
});

test(`lote acima de ${MAX_BATCH_ACTIONS} é rejeitado`, () => {
  const actions: AgentConversationAction[] = Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }));
  assert.deepEqual(checkBatchStructure(actions), { ok: false, reason: "TOO_MANY_ACTIONS" });
});

test("CONFIRM_ORDER combinado é rejeitado", () => {
  const actions: AgentConversationAction[] = [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "CONFIRM_ORDER" }];
  assert.deepEqual(checkBatchStructure(actions), { ok: false, reason: "SOLO_ONLY_ACTION_COMBINED" });
});

test("REQUEST_HUMAN combinado é rejeitado", () => {
  const actions: AgentConversationAction[] = [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "REQUEST_HUMAN" }];
  assert.deepEqual(checkBatchStructure(actions), { ok: false, reason: "SOLO_ONLY_ACTION_COMBINED" });
});

test("RESET_CONVERSATION combinado é rejeitado", () => {
  const actions: AgentConversationAction[] = [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "RESET_CONVERSATION" }];
  assert.deepEqual(checkBatchStructure(actions), { ok: false, reason: "SOLO_ONLY_ACTION_COMBINED" });
});

test("CANCEL_CONVERSATION combinado é rejeitado", () => {
  const actions: AgentConversationAction[] = [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "CANCEL_CONVERSATION" }];
  assert.deepEqual(checkBatchStructure(actions), { ok: false, reason: "SOLO_ONLY_ACTION_COMBINED" });
});

// --- preflightConversationActions ---

test("preflight aceita uma ação válida", () => {
  const { tools, session } = makeStack();
  const result = preflightConversationActions({ session, tools, actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 2 }] });
  assert.deepEqual(result, { ok: true });
});

test("preflight aceita duas ações válidas em sequência", () => {
  const { tools, session } = makeStack();
  const result = preflightConversationActions({
    session, tools,
    actions: [
      { type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 2 },
      { type: "ADD_ITEM", productId: "brownie-ninho", quantity: 1 },
    ],
  });
  assert.deepEqual(result, { ok: true });
});

test("preflight rejeita ação incompatível com a etapa e devolve o índice", () => {
  const { tools, session } = makeStack("COLLECTING_PAYMENT");
  const result = preflightConversationActions({
    session, tools,
    actions: [{ type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, { type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }],
  });
  assert.equal(result.ok, false);
  assert.equal((result as { failedActionIndex: number }).failedActionIndex, 1);
});

test("preflight não persiste no store real (sessão real intocada)", () => {
  const { tools, session, sessionStore } = makeStack();
  preflightConversationActions({ session, tools, actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 3 }] });
  const stored = sessionStore.get(session.sessionKey);
  assert.deepEqual(stored?.items, []);
});

test("preflight não registra messageId (não há messageId envolvido)", () => {
  const { tools, session, sessionStore } = makeStack();
  preflightConversationActions({ session, tools, actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }] });
  assert.equal(sessionStore.hasProcessedMessage(session.sessionKey, "qualquer"), false);
});

test("preflight não chama createOrder", () => {
  const { tools, session, sessionStore } = makeStack("COLLECTING_PAYMENT");
  sessionStore.update(session.sessionKey, s => ({
    ...s, items: [{ productId: "brownie-tradicional", quantity: 1 }], customerName: "Ana", customerPhone: "85999990000",
    fulfillmentType: "RETIRADA", pickupTime: "18:00",
  }));
  const seeded = sessionStore.get(session.sessionKey)!;
  const result = preflightConversationActions({ session: seeded, tools, actions: [{ type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }] });
  assert.deepEqual(result, { ok: true });
  assert.equal(sessionStore.get(session.sessionKey)?.createdOrderId, undefined);
});

test("entrada (actions) não é mutada pelo preflight", () => {
  const { tools, session } = makeStack();
  const actions: AgentConversationAction[] = [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }];
  const snapshot = structuredClone(actions);
  preflightConversationActions({ session, tools, actions });
  assert.deepEqual(actions, snapshot);
});

test("sessão original não é mutada pelo preflight", () => {
  const { tools, session } = makeStack();
  const snapshot = structuredClone(session);
  preflightConversationActions({ session, tools, actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }] });
  assert.deepEqual(session, snapshot);
});

// --- executeConversationActionBatch ---

test("execução oficial de duas ações válidas usa o Conversation Service e preserva a ordem", () => {
  const { tools, session, conversationService, sessionStore } = makeStack();
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [
      { type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 2 },
      { type: "ADD_ITEM", productId: "brownie-ninho", quantity: 1 },
    ],
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.sessionAfter.items, [
    { productId: "brownie-tradicional", quantity: 2 },
    { productId: "brownie-ninho", quantity: 1 },
  ]);
  const stored = sessionStore.get(session.sessionKey);
  assert.deepEqual(stored?.items, result.sessionAfter.items);
});

test("a sessão da segunda ação usa o resultado da primeira", () => {
  const { tools, session, conversationService } = makeStack();
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [
      { type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 2 },
      { type: "UPDATE_ITEM_QUANTITY", productId: "brownie-tradicional", quantity: 5 },
    ],
  });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.sessionAfter.items, [{ productId: "brownie-tradicional", quantity: 5 }]);
});

test("segunda ação inválida rejeita o lote inteiro no preflight, nenhuma execução oficial ocorre", () => {
  const { tools, session, conversationService, sessionStore } = makeStack("COLLECTING_PAYMENT");
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [
      { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" },
      { type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 },
    ],
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.failedActionIndex, 1);
  const stored = sessionStore.get(session.sessionKey);
  assert.equal(stored?.paymentMethod, undefined);
});

test("CONFIRM_ORDER combinado é rejeitado antes de qualquer preflight", () => {
  const { tools, session, conversationService } = makeStack("AWAITING_CONFIRMATION");
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [{ type: "GO_BACK" }, { type: "CONFIRM_ORDER" }],
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "SOLO_ONLY_ACTION_COMBINED");
  assert.equal(result.results.length, 0);
});

test("REQUEST_HUMAN combinado é rejeitado", () => {
  const { tools, session, conversationService } = makeStack();
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "REQUEST_HUMAN" }],
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "SOLO_ONLY_ACTION_COMBINED");
});

test("RESET combinado é rejeitado", () => {
  const { tools, session, conversationService } = makeStack();
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "RESET_CONVERSATION" }],
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "SOLO_ONLY_ACTION_COMBINED");
});

test("CANCEL combinado é rejeitado", () => {
  const { tools, session, conversationService } = makeStack();
  const result = executeConversationActionBatch({
    conversationService, tools, channel: "simulator", contactId: "c1", session,
    actions: [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }, { type: "CANCEL_CONVERSATION" }],
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "SOLO_ONLY_ACTION_COMBINED");
});

test(`lote acima de ${MAX_BATCH_ACTIONS} ações é rejeitado`, () => {
  const { tools, session, conversationService } = makeStack();
  const actions: AgentConversationAction[] = Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }));
  const result = executeConversationActionBatch({ conversationService, tools, channel: "simulator", contactId: "c1", session, actions });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "TOO_MANY_ACTIONS");
});

test("lote vazio é rejeitado", () => {
  const { tools, session, conversationService } = makeStack();
  const result = executeConversationActionBatch({ conversationService, tools, channel: "simulator", contactId: "c1", session, actions: [] });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "EMPTY_BATCH");
});

test("entrada (actions) e sessão original não são mutadas pela execução do lote", () => {
  const { tools, session, conversationService } = makeStack();
  const actions: AgentConversationAction[] = [{ type: "ADD_ITEM", productId: "brownie-tradicional", quantity: 1 }];
  const actionsSnapshot = structuredClone(actions);
  const sessionSnapshot = structuredClone(session);
  executeConversationActionBatch({ conversationService, tools, channel: "simulator", contactId: "c1", session, actions });
  assert.deepEqual(actions, actionsSnapshot);
  assert.deepEqual(session, sessionSnapshot);
});
