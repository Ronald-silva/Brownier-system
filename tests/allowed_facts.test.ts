import assert from "node:assert/strict";
import test from "node:test";
import { buildAllowedFacts } from "../src/agent/allowed-facts.ts";
import { createAgentTools, type AgentDomainStore } from "../src/agent/tools.ts";
import type { AgentConversationResult } from "../src/agent/conversation.types.ts";
import type { AgentSession } from "../src/agent/session.types.ts";

const FIXED_ISO = "2026-01-01T00:00:00.000Z";

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionKey: "whatsapp:c1", channel: "whatsapp", contactId: "c1", step: "BUILDING_ORDER",
    items: [], processedMessageIds: [], underHumanHandoff: false, misunderstandingCount: 0,
    createdAt: FIXED_ISO, updatedAt: FIXED_ISO, expiresAt: "2026-01-01T00:30:00.000Z",
    ...overrides,
  };
}

function domainStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888", address: "Rua das Flores, 123",
      pickupEnabled: true, deliveryEnabled: false, deliveryFee: 0,
      pickupSlots: ["18:00", "19:00"], availabilityNotice: "",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [
      { id: "p1", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "", category: "Brownies", basePrice: 5, promotionalPrice: null, minimumPromotionalQuantity: null, isActive: true, isAvailable: true, displayOrder: 1, ingredients: "", allergens: "" },
      { id: "p2", slug: "ninho", name: "Brownie de Ninho", description: "", category: "Brownies", basePrice: 6, promotionalPrice: 5.5, minimumPromotionalQuantity: 2, isActive: true, isAvailable: true, displayOrder: 2, ingredients: "", allergens: "" },
    ],
    orders: [],
    ...overrides,
  };
}

function result(overrides: Partial<AgentConversationResult>): AgentConversationResult {
  return {
    session: session(),
    previousStep: "BUILDING_ORDER",
    currentStep: "BUILDING_ORDER",
    event: "ITEM_ADDED",
    messageKey: "ITEM_ADDED",
    ...overrides,
  };
}

test("ITEM_ADDED produz PRODUCT + CART_SUMMARY com factId único", () => {
  const tools = createAgentTools({ store: domainStore() });
  const facts = buildAllowedFacts({
    result: result({ messageKey: "ITEM_ADDED", data: { productId: "p1", quantity: 2 }, session: session({ items: [{ productId: "p1", quantity: 2 }] }) }),
    tools,
  });
  const product = facts.find(f => f.key === "PRODUCT");
  assert.ok(product);
  assert.equal(product!.factId, "product:p1");
  const cart = facts.find(f => f.key === "CART_SUMMARY");
  assert.ok(cart);
  assert.deepEqual(new Set(facts.map(f => f.factId)).size, facts.length);
});

test("MENU_READY traz um PRODUCT por item do catálogo, cada um com factId distinto", () => {
  const tools = createAgentTools({ store: domainStore() });
  const facts = buildAllowedFacts({ result: result({ messageKey: "MENU_READY", data: {} }), tools });
  const productFacts = facts.filter(f => f.key === "PRODUCT");
  assert.equal(productFacts.length, 2);
  assert.deepEqual(new Set(productFacts.map(f => f.factId)).size, 2);
});

test("ORDER_CREATED produz ORDER_CONFIRMATION com o publicCode real", () => {
  const tools = createAgentTools({ store: domainStore() });
  const facts = buildAllowedFacts({
    result: result({ messageKey: "ORDER_CREATED", data: { publicCode: "BRW-001", replayed: false } }),
    tools,
  });
  const confirmation = facts.find(f => f.key === "ORDER_CONFIRMATION");
  assert.ok(confirmation);
  assert.equal(confirmation!.key === "ORDER_CONFIRMATION" && confirmation!.publicCode, "BRW-001");
});

test("nunca inclui fato de negócio fora do que a Tool realmente devolveu (produto inexistente é ignorado)", () => {
  const tools = createAgentTools({ store: domainStore() });
  const facts = buildAllowedFacts({
    result: result({ messageKey: "ITEM_ADDED", data: { productId: "produto-inexistente", quantity: 1 } }),
    tools,
  });
  assert.equal(facts.some(f => f.key === "PRODUCT"), false);
});

test("requestedFactKeys traz BUSINESS_ADDRESS/OPERATING_STATUS mesmo sem execução de ação", () => {
  const tools = createAgentTools({ store: domainStore() });
  const facts = buildAllowedFacts({ tools, requestedFactKeys: ["BUSINESS_ADDRESS"] });
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.key, "BUSINESS_ADDRESS");
  assert.equal(facts[0]!.key === "BUSINESS_ADDRESS" && facts[0]!.address, "Rua das Flores, 123");
});

test("dedupe por factId preserva a primeira ocorrência quando a mesma chave é pedida duas vezes", () => {
  const tools = createAgentTools({ store: domainStore() });
  const facts = buildAllowedFacts({
    result: result({ messageKey: "ASK_PAYMENT_METHOD", data: {} }),
    tools,
    requestedFactKeys: ["PAYMENT_OPTIONS"],
  });
  const paymentFacts = facts.filter(f => f.key === "PAYMENT_OPTIONS");
  assert.equal(paymentFacts.length, 1);
});

test("sem resultado nem requestedFactKeys devolve array vazio", () => {
  const tools = createAgentTools({ store: domainStore() });
  assert.deepEqual(buildAllowedFacts({ tools }), []);
});
