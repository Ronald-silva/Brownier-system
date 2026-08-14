import assert from "node:assert/strict";
import test from "node:test";
import { handleConversationAction } from "../src/agent/conversation.engine.ts";
import { AgentConversationError, type AgentConversationAction } from "../src/agent/conversation.types.ts";
import type { AgentSession, AgentConversationStep } from "../src/agent/session.types.ts";
import { createAgentTools, type AgentDomainStore, type AgentTools } from "../src/agent/tools.ts";
import { OrderCreationError, type Order } from "../src/lib/orders.ts";
import { INITIAL_OPERATING_HOURS } from "../src/lib/business-hours.ts";

// --- fábricas de teste ---------------------------------------------------

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
      internalNotes: "não deve aparecer para o agente",
    },
    products: [product()],
    orders: [],
    ...overrides,
  };
}

function makeTools(
  overrides: Partial<AgentDomainStore> = {},
  now?: () => Date,
): { tools: AgentTools; store: AgentDomainStore } {
  const store = makeDomainStore(overrides);
  return { tools: createAgentTools({ store, now }), store };
}

// Spy fiel: envolve as Tools reais (sem duplicar sua lógica) só para contar
// chamadas, permitindo provar que o motor "consulta" as Tools em vez de
// adivinhar dados.
function spyOn(tools: AgentTools): { tools: AgentTools; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const wrapped = {} as AgentTools;
  for (const key of Object.keys(tools) as (keyof AgentTools)[]) {
    const original = tools[key] as (...args: unknown[]) => unknown;
    (wrapped as Record<string, unknown>)[key] = (...args: unknown[]) => {
      calls[key] = (calls[key] ?? 0) + 1;
      return original.apply(tools, args);
    };
  }
  return { tools: wrapped, calls };
}

const BASE_TIMESTAMP = "2026-07-28T10:00:00.000Z";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionKey: "whatsapp:5585999999999",
    channel: "whatsapp",
    contactId: "5585999999999",
    step: "START",
    items: [],
    processedMessageIds: [],
    underHumanHandoff: false,
    misunderstandingCount: 0,
    createdAt: BASE_TIMESTAMP,
    updatedAt: BASE_TIMESTAMP,
    expiresAt: "2026-07-28T10:30:00.000Z",
    ...overrides,
  };
}

function fixedNow(iso = "2026-07-28T10:05:00.000Z") {
  return () => new Date(iso);
}

function run(
  session: AgentSession,
  action: AgentConversationAction,
  tools: AgentTools,
  now = fixedNow(),
  generateOrderIdempotencyKey?: () => string,
) {
  return handleConversationAction({ session, action, tools, now, generateOrderIdempotencyKey });
}

// Spy focado só em createOrder, para inspecionar o payload e a idempotencyKey
// exatos que o motor envia à Tool, sem contar as demais chamadas.
function spyCreateOrder(tools: AgentTools): {
  tools: AgentTools;
  calls: Array<Parameters<AgentTools["createOrder"]>[0]>;
} {
  const calls: Array<Parameters<AgentTools["createOrder"]>[0]> = [];
  const wrapped: AgentTools = {
    ...tools,
    createOrder: input => {
      calls.push(input);
      return tools.createOrder(input);
    },
  };
  return { tools: wrapped, calls };
}

// --- 1-2: START_CONVERSATION ---------------------------------------------

test("START_CONVERSATION avança para BROWSING_MENU", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "START" }), { type: "START_CONVERSATION" }, tools);
  assert.equal(result.previousStep, "START");
  assert.equal(result.currentStep, "BROWSING_MENU");
  assert.equal(result.session.step, "BROWSING_MENU");
  assert.equal(result.messageKey, "WELCOME");
});

test("START_CONVERSATION consulta Business e produtos", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyOn(realTools);
  const result = run(makeSession({ step: "START" }), { type: "START_CONVERSATION" }, tools);
  assert.equal(calls.getBusiness, 1);
  assert.equal(calls.listProducts, 1);
  assert.ok(result.data?.business);
  assert.ok(Array.isArray(result.data?.products));
});

// --- 3: SHOW_MENU ----------------------------------------------------------

test("SHOW_MENU retorna apenas produtos da Tool", () => {
  const { tools } = makeTools({
    products: [product({ id: "ativo", displayOrder: 1 }), product({ id: "inativo", isActive: false, displayOrder: 2 })],
  });
  const result = run(makeSession({ step: "BROWSING_MENU" }), { type: "SHOW_MENU" }, tools);
  const products = result.data?.products as Array<{ id: string }>;
  assert.deepEqual(products.map(p => p.id), ["ativo"]);
  assert.equal(result.session.items.length, 0);
});

// --- 4-9: ADD_ITEM ----------------------------------------------------------

test("ADD_ITEM adiciona produto", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "BROWSING_MENU" }), { type: "ADD_ITEM", productId: "p1", quantity: 2 }, tools);
  assert.equal(result.currentStep, "BUILDING_ORDER");
  assert.deepEqual(result.session.items, [{ productId: "p1", quantity: 2 }]);
  assert.equal(result.messageKey, "ITEM_ADDED");
});

test("ADD_ITEM soma quantidade existente", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "ADD_ITEM", productId: "p1", quantity: 3 }, tools);
  assert.deepEqual(result.session.items, [{ productId: "p1", quantity: 5 }]);
});

test("ADD_ITEM rejeita produto inexistente", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BROWSING_MENU" });
  const result = run(session, { type: "ADD_ITEM", productId: "nao-existe", quantity: 1 }, tools);
  assert.equal(result.messageKey, "INVALID_PRODUCT");
  assert.deepEqual(result.session.items, []);
  assert.equal(result.currentStep, "BROWSING_MENU");
});

test("ADD_ITEM rejeita quantidade decimal", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "BROWSING_MENU" }), { type: "ADD_ITEM", productId: "p1", quantity: 1.5 }, tools);
  assert.equal(result.messageKey, "INVALID_QUANTITY");
  assert.deepEqual(result.session.items, []);
});

test("ADD_ITEM rejeita quantidade zero", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "BROWSING_MENU" }), { type: "ADD_ITEM", productId: "p1", quantity: 0 }, tools);
  assert.equal(result.messageKey, "INVALID_QUANTITY");
});

test("ADD_ITEM rejeita quantidade acima de 100", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "BROWSING_MENU" }), { type: "ADD_ITEM", productId: "p1", quantity: 101 }, tools);
  assert.equal(result.messageKey, "INVALID_QUANTITY");
});

// --- 10-11: UPDATE_ITEM_QUANTITY -------------------------------------------

test("UPDATE_ITEM_QUANTITY altera quantidade", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "UPDATE_ITEM_QUANTITY", productId: "p1", quantity: 7 }, tools);
  assert.deepEqual(result.session.items, [{ productId: "p1", quantity: 7 }]);
  assert.equal(result.currentStep, "BUILDING_ORDER");
});

test("UPDATE com zero remove item", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "UPDATE_ITEM_QUANTITY", productId: "p1", quantity: 0 }, tools);
  assert.deepEqual(result.session.items, []);
  assert.equal(result.messageKey, "ITEM_REMOVED");
});

test("UPDATE_ITEM_QUANTITY rejeita quantidade negativa", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "UPDATE_ITEM_QUANTITY", productId: "p1", quantity: -1 }, tools);
  assert.equal(result.messageKey, "INVALID_QUANTITY");
  assert.deepEqual(result.session.items, [{ productId: "p1", quantity: 2 }]);
});

// --- 12: REMOVE_ITEM ---------------------------------------------------

test("REMOVE_ITEM remove produto", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "BUILDING_ORDER",
    items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 1 }],
  });
  const result = run(session, { type: "REMOVE_ITEM", productId: "p1" }, tools);
  assert.deepEqual(result.session.items, [{ productId: "p2", quantity: 1 }]);
});

test("REMOVE_ITEM de produto inexistente não falha", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "REMOVE_ITEM", productId: "nao-existe" }, tools);
  assert.equal(result.messageKey, "ITEM_REMOVED");
  assert.deepEqual(result.session.items, [{ productId: "p1", quantity: 2 }]);
});

// --- 13: CLEAR_CART ---------------------------------------------------

test("CLEAR_CART limpa dados e volta ao menu", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "AWAITING_CONFIRMATION",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria",
    customerPhone: "85999998888",
    fulfillmentType: "RETIRADA",
    pickupTime: "18:00",
    customerNotes: "sem nozes",
    paymentMethod: "PIX",
    processedMessageIds: ["m1"],
  });
  const result = run(session, { type: "CLEAR_CART" }, tools);
  assert.equal(result.currentStep, "BROWSING_MENU");
  assert.deepEqual(result.session.items, []);
  assert.equal(result.session.customerName, undefined);
  assert.equal(result.session.customerPhone, undefined);
  assert.equal(result.session.fulfillmentType, undefined);
  assert.equal(result.session.pickupTime, undefined);
  assert.equal(result.session.customerNotes, undefined);
  assert.equal(result.session.paymentMethod, undefined);
  assert.deepEqual(result.session.processedMessageIds, ["m1"]);
  assert.equal(result.session.sessionKey, session.sessionKey);
});

test("CLEAR_CART é permitida em COLLECTING_PAYMENT", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT", paymentMethod: "PIX" }), { type: "CLEAR_CART" }, tools);
  assert.equal(result.currentStep, "BROWSING_MENU");
  assert.equal(result.session.paymentMethod, undefined);
});

// --- 14-16: FINISH_CART ---------------------------------------------------

test("FINISH_CART rejeita carrinho vazio", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "BUILDING_ORDER", items: [] }), { type: "FINISH_CART" }, tools);
  assert.equal(result.messageKey, "CART_EMPTY");
  assert.equal(result.currentStep, "BUILDING_ORDER");
});

test("FINISH_CART avança para nome", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "FINISH_CART" }, tools);
  assert.equal(result.currentStep, "COLLECTING_NAME");
  assert.equal(result.messageKey, "ASK_CUSTOMER_NAME");
});

test("FINISH_CART revalida produto e rejeita se ficou indisponível", () => {
  const { tools } = makeTools({ products: [product({ id: "p1", isAvailable: false })] });
  const session = makeSession({ step: "BUILDING_ORDER", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "FINISH_CART" }, tools);
  assert.equal(result.messageKey, "INVALID_PRODUCT");
  assert.equal(result.currentStep, "BUILDING_ORDER");
});

// --- 17-18: SET_CUSTOMER_NAME ---------------------------------------------

test("SET_CUSTOMER_NAME inválido não avança", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NAME" }), { type: "SET_CUSTOMER_NAME", customerName: "   " }, tools);
  assert.equal(result.messageKey, "INVALID_CUSTOMER_NAME");
  assert.equal(result.currentStep, "COLLECTING_NAME");
  assert.equal(result.session.customerName, undefined);
});

test("SET_CUSTOMER_NAME válido avança", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NAME" }), { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" }, tools);
  assert.equal(result.session.customerName, "Maria Silva");
  assert.equal(result.currentStep, "COLLECTING_FULFILLMENT");
  assert.equal(result.messageKey, "ASK_FULFILLMENT");
});

// --- 19-20: SET_CUSTOMER_PHONE ---------------------------------------------

test("SET_CUSTOMER_PHONE válido é armazenado", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NAME" }), { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" }, tools);
  assert.equal(result.session.customerPhone, "85999998888");
});

test("SET_CUSTOMER_PHONE inválido é rejeitado", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NAME" }), { type: "SET_CUSTOMER_PHONE", customerPhone: "" }, tools);
  assert.equal(result.messageKey, "INVALID_CUSTOMER_PHONE");
  assert.equal(result.session.customerPhone, undefined);
});

// --- 21-24: SET_FULFILLMENT ---------------------------------------------

test("SET_FULFILLMENT aceita RETIRADA", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_FULFILLMENT" }), { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, tools);
  assert.equal(result.session.fulfillmentType, "RETIRADA");
});

test("SET_FULFILLMENT rejeita ENTREGA", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_FULFILLMENT" }), { type: "SET_FULFILLMENT", fulfillmentType: "ENTREGA" }, tools);
  assert.equal(result.messageKey, "INVALID_ACTION");
  assert.equal(result.session.fulfillmentType, undefined);
  assert.equal(result.currentStep, "COLLECTING_FULFILLMENT");
});

test("retirada com slots configurados avança para horário", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_FULFILLMENT" }), { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, tools);
  assert.equal(result.currentStep, "COLLECTING_PICKUP_TIME");
  assert.equal(result.messageKey, "ASK_PICKUP_TIME");
});

test("retirada sem slots configurados pula para notas", () => {
  const { tools } = makeTools({ business: { ...makeDomainStore().business, pickupSlots: [] } });
  const result = run(makeSession({ step: "COLLECTING_FULFILLMENT" }), { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, tools);
  assert.equal(result.currentStep, "COLLECTING_NOTES");
  assert.equal(result.messageKey, "ASK_NOTES");
});

// --- 25-27: SET_PICKUP_TIME ---------------------------------------------

test("SET_PICKUP_TIME chama a Tool de validação", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyOn(realTools);
  run(makeSession({ step: "COLLECTING_PICKUP_TIME" }), { type: "SET_PICKUP_TIME", pickupTime: "18:00" }, tools);
  assert.equal(calls.validatePickupTime, 1);
});

test("horário inválido não avança", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PICKUP_TIME" }), { type: "SET_PICKUP_TIME", pickupTime: "23:00" }, tools);
  assert.equal(result.messageKey, "INVALID_PICKUP_TIME");
  assert.equal(result.currentStep, "COLLECTING_PICKUP_TIME");
  assert.equal(result.session.pickupTime, undefined);
});

test("horário válido avança", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PICKUP_TIME" }), { type: "SET_PICKUP_TIME", pickupTime: "18:00" }, tools);
  assert.equal(result.session.pickupTime, "18:00");
  assert.equal(result.currentStep, "COLLECTING_NOTES");
});

// --- 28-29: notas ---------------------------------------------------------

test("SET_CUSTOMER_NOTES salva e avança para COLLECTING_PAYMENT", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NOTES" }), { type: "SET_CUSTOMER_NOTES", customerNotes: "sem nozes" }, tools);
  assert.equal(result.session.customerNotes, "sem nozes");
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
  assert.equal(result.messageKey, "ASK_PAYMENT_METHOD");
});

test("SKIP_CUSTOMER_NOTES avança sem nota para COLLECTING_PAYMENT", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "COLLECTING_NOTES", customerNotes: "antiga" });
  const result = run(session, { type: "SKIP_CUSTOMER_NOTES" }, tools);
  assert.equal(result.session.customerNotes, undefined);
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
  assert.equal(result.messageKey, "ASK_PAYMENT_METHOD");
});

// --- SET_PAYMENT_METHOD ---------------------------------------------------

test("SET_PAYMENT_METHOD é rejeitada fora da etapa correta", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NOTES" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, tools);
  assert.equal(result.messageKey, "INVALID_ACTION");
  assert.equal(result.session.paymentMethod, undefined);
});

test("PIX válido é aceito quando permitido pelo Business", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, tools);
  assert.equal(result.session.paymentMethod, "PIX");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
});

test("DINHEIRO válido é aceito quando permitido pelo Business", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "DINHEIRO" }, tools);
  assert.equal(result.session.paymentMethod, "DINHEIRO");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
});

test("A_COMBINAR válido é aceito quando permitido pelo Business", () => {
  const { tools } = makeTools({ business: { ...makeDomainStore().business, paymentMethods: ["A_COMBINAR"] } });
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "A_COMBINAR" }, tools);
  assert.equal(result.session.paymentMethod, "A_COMBINAR");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
});

test("SET_PAYMENT_METHOD normaliza para maiúsculas", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "pix" }, tools);
  assert.equal(result.session.paymentMethod, "PIX");
});

test("SET_PAYMENT_METHOD remove espaços externos", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "  pix  " }, tools);
  assert.equal(result.session.paymentMethod, "PIX");
});

test("SET_PAYMENT_METHOD rejeita valor vazio", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "   " }, tools);
  assert.equal(result.messageKey, "PAYMENT_METHOD_INVALID");
  assert.equal(result.session.paymentMethod, undefined);
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
});

test("SET_PAYMENT_METHOD rejeita método não oferecido pelo Business", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "CARTAO" }, tools);
  assert.equal(result.messageKey, "PAYMENT_METHOD_INVALID");
  assert.equal(result.session.paymentMethod, undefined);
  assert.deepEqual(result.data?.options, ["PIX", "DINHEIRO"]);
});

test("SET_PAYMENT_METHOD com lista de opções vazia retorna PAYMENT_METHOD_UNAVAILABLE", () => {
  const { tools } = makeTools({ business: { ...makeDomainStore().business, paymentMethods: [] } });
  const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, tools);
  assert.equal(result.messageKey, "PAYMENT_METHOD_UNAVAILABLE");
  assert.equal(result.session.paymentMethod, undefined);
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
});

test("SET_PAYMENT_METHOD com lista de opções ausente retorna resultado controlado, sem lançar erro", () => {
  const { tools } = makeTools({ business: { ...makeDomainStore().business, paymentMethods: undefined } });
  assert.doesNotThrow(() => {
    const result = run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, tools);
    assert.equal(result.messageKey, "PAYMENT_METHOD_UNAVAILABLE");
  });
});

test("SET_PAYMENT_METHOD consulta tools.getBusiness() em vez de manter lista própria", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyOn(realTools);
  run(makeSession({ step: "COLLECTING_PAYMENT" }), { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, tools);
  assert.equal(calls.getBusiness, 1);
});

// --- 30: REVIEW_ORDER ---------------------------------------------------

test("REVIEW_ORDER consulta produtos atuais em vez de usar dados da sessão", () => {
  const { tools } = makeTools({ products: [product({ id: "p1", name: "Nome Atual" })] });
  const session = makeSession({
    step: "AWAITING_CONFIRMATION",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria",
  });
  const result = run(session, { type: "REVIEW_ORDER" }, tools);
  const items = result.data?.items as Array<{ productId: string; product: { name: string } | null }>;
  assert.equal(items[0].product?.name, "Nome Atual");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
});

test("REVIEW_ORDER inclui paymentMethod quando já definido", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "AWAITING_CONFIRMATION",
    items: [{ productId: "p1", quantity: 2 }],
    paymentMethod: "PIX",
  });
  const result = run(session, { type: "REVIEW_ORDER" }, tools);
  assert.equal(result.data?.paymentMethod, "PIX");
});

test("REVIEW_ORDER em COLLECTING_PAYMENT não pula a coleta nem avança para confirmação", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "COLLECTING_PAYMENT", items: [{ productId: "p1", quantity: 2 }] });
  const result = run(session, { type: "REVIEW_ORDER" }, tools);
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
  assert.equal(result.data?.paymentMethod, undefined);
  assert.equal(result.data?.paymentPending, true);
});

// --- 31-33: CONFIRM_ORDER ---------------------------------------------------

function readySession(overrides: Partial<AgentSession> = {}): AgentSession {
  return makeSession({
    step: "AWAITING_CONFIRMATION",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria Silva",
    customerPhone: "85999998888",
    fulfillmentType: "RETIRADA",
    pickupTime: "18:00",
    paymentMethod: "PIX",
    ...overrides,
  });
}

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "existing-order-id",
    publicCode: "BF-EXIST01",
    status: "NOVO",
    fulfillmentType: "RETIRADA",
    paymentMethod: "PIX",
    subtotal: 0,
    discount: 0,
    deliveryFee: 0,
    total: 0,
    customerName: "Outro Cliente",
    customerPhone: "85911112222",
    deliveryAddress: "",
    reference: "",
    customerNotes: "",
    internalNotes: "",
    changeFor: "",
    pickupTime: "18:00",
    items: [],
    createdAt: BASE_TIMESTAMP,
    updatedAt: BASE_TIMESTAMP,
    ...overrides,
  };
}

test("CONFIRM_ORDER rejeita dados incompletos", () => {
  const { tools } = makeTools();
  const result = run(readySession({ customerPhone: undefined }), { type: "CONFIRM_ORDER" }, tools);
  assert.equal(result.messageKey, "INCOMPLETE_ORDER_DATA");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
});

test("CONFIRM_ORDER sem paymentMethod é rejeitado", () => {
  const { tools } = makeTools();
  const result = run(readySession({ paymentMethod: undefined }), { type: "CONFIRM_ORDER" }, tools);
  assert.equal(result.messageKey, "PAYMENT_METHOD_REQUIRED");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
  assert.equal(result.session.paymentMethod, undefined);
});

test("CONFIRM_ORDER revalida o método salvo contra as opções atuais do Business", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyOn(realTools);
  run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.ok((calls.getBusiness ?? 0) >= 1);
});

test("CONFIRM_ORDER volta para COLLECTING_PAYMENT quando o método deixou de estar disponível", () => {
  const { tools: realTools } = makeTools({ business: { ...makeDomainStore().business, paymentMethods: ["DINHEIRO"] } });
  const { tools, calls } = spyOn(realTools);
  const result = run(readySession({ paymentMethod: "PIX" }), { type: "CONFIRM_ORDER" }, tools);
  assert.equal(result.messageKey, "PAYMENT_METHOD_UNAVAILABLE");
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
  assert.equal(result.session.paymentMethod, undefined);
  assert.deepEqual(result.data?.options, ["DINHEIRO"]);
  assert.equal(calls.createOrder, undefined);
});

// --- revalidação de produtos e horário antes de criar o pedido -------------

test("CONFIRM_ORDER revalida produtos: rejeita se um item ficou indisponível", () => {
  const { tools: realTools } = makeTools({ products: [product({ id: "p1", isAvailable: false })] });
  const { tools, calls } = spyOn(realTools);
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools);
  assert.equal(result.messageKey, "INVALID_PRODUCT");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
  assert.equal(calls.createOrder, undefined);
});

test("CONFIRM_ORDER revalida horário: rejeita se o horário salvo saiu da lista de slots", () => {
  const { tools: realTools } = makeTools({ business: { ...makeDomainStore().business, pickupSlots: ["19:00"] } });
  const { tools, calls } = spyOn(realTools);
  const result = run(readySession({ pickupTime: "18:00" }), { type: "CONFIRM_ORDER" }, tools);
  assert.equal(result.messageKey, "INVALID_PICKUP_TIME");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
  assert.equal(calls.createOrder, undefined);
});

// --- bloqueio de horário comercial ------------------------------------------

// Terça-feira 07:05 em America/Fortaleza (UTC-3) — antes da abertura das 14h
// do INITIAL_OPERATING_HOURS (seg-sex 14h-22h, sáb/dom fechado).
const OUTSIDE_HOURS_NOW = () => new Date("2026-07-28T10:05:00.000Z");
// Mesma terça-feira, 19:05 em America/Fortaleza — dentro do expediente.
const WITHIN_HOURS_NOW = () => new Date("2026-07-28T22:05:00.000Z");

test("CONFIRM_ORDER bloqueia fora do horário de funcionamento quando operatingHours está cadastrado", () => {
  const { tools: realTools } = makeTools(
    { business: { ...makeDomainStore().business, operatingHours: INITIAL_OPERATING_HOURS } },
    OUTSIDE_HOURS_NOW,
  );
  const { tools, calls } = spyOn(realTools);
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, OUTSIDE_HOURS_NOW);
  assert.equal(result.messageKey, "STORE_CLOSED");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
  assert.equal(result.session.items.length, 1);
  assert.equal(calls.createOrder, undefined);
});

test("CONFIRM_ORDER cria o pedido normalmente dentro do horário de funcionamento cadastrado", () => {
  const { tools: realTools } = makeTools(
    { business: { ...makeDomainStore().business, operatingHours: INITIAL_OPERATING_HOURS } },
    WITHIN_HOURS_NOW,
  );
  const { tools } = spyOn(realTools);
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, WITHIN_HOURS_NOW, () => "agent-order:test-0001");
  assert.equal(result.messageKey, "ORDER_CREATED");
  assert.equal(result.currentStep, "ORDER_CREATED");
});

test("CONFIRM_ORDER é fail-open quando operatingHours não está cadastrado (comportamento pré-existente)", () => {
  const { tools: realTools } = makeTools();
  const { tools } = spyOn(realTools);
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0002");
  assert.equal(result.messageKey, "ORDER_CREATED");
  assert.equal(result.currentStep, "ORDER_CREATED");
});

// --- payload e idempotência -------------------------------------------------

test("CONFIRM_ORDER chama tools.createOrder uma única vez", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(calls.length, 1);
});

test("payload enviado contém somente os campos oficiais do pedido", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  run(
    readySession({ customerNotes: "sem nozes" }),
    { type: "CONFIRM_ORDER" },
    tools,
    fixedNow(),
    () => "agent-order:test-0001",
  );
  assert.deepEqual(Object.keys(calls[0]!.payload).sort(), [
    "customerName",
    "customerNotes",
    "customerPhone",
    "fulfillmentType",
    "items",
    "paymentMethod",
    "pickupTime",
  ]);
  assert.deepEqual(calls[0]!.payload.items, [{ productId: "p1", quantity: 2 }]);
  assert.equal(calls[0]!.payload.customerName, "Maria Silva");
  assert.equal(calls[0]!.payload.customerPhone, "85999998888");
  assert.equal(calls[0]!.payload.fulfillmentType, "RETIRADA");
  assert.equal(calls[0]!.payload.pickupTime, "18:00");
  assert.equal(calls[0]!.payload.paymentMethod, "PIX");
});

test("preços não são enviados no payload", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  const payload = calls[0]!.payload as Record<string, unknown>;
  for (const forbidden of ["basePrice", "promotionalPrice", "subtotal", "discount", "total", "productName", "description"]) {
    assert.equal(forbidden in payload, false);
  }
  const items = payload.items as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(items[0]!).sort(), ["productId", "quantity"]);
});

test("idempotencyKey é enviada para tools.createOrder", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(calls[0]!.idempotencyKey, "agent-order:test-0001");
});

test("chave gerada é salva na sessão", () => {
  const { tools } = makeTools();
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.session.orderIdempotencyKey, "agent-order:test-0001");
});

test("chave existente na sessão é reutilizada em vez de gerar outra", () => {
  const { tools } = makeTools();
  let generatorCalls = 0;
  const generateOrderIdempotencyKey = () => {
    generatorCalls += 1;
    return "agent-order:should-not-be-used";
  };
  const result = run(
    readySession({ orderIdempotencyKey: "agent-order:already-set-0001" }),
    { type: "CONFIRM_ORDER" },
    tools,
    fixedNow(),
    generateOrderIdempotencyKey,
  );
  assert.equal(generatorCalls, 0);
  assert.equal(result.session.orderIdempotencyKey, "agent-order:already-set-0001");
});

test("gerador injetado é usado para produzir a chave", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:injected-0001");
  assert.equal(result.session.orderIdempotencyKey, "agent-order:injected-0001");
  assert.equal(calls[0]!.idempotencyKey, "agent-order:injected-0001");
});

test("chave inválida do gerador lança erro técnico e não chama createOrder", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  const session = readySession();
  assert.throws(
    () => run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "chave com espaço"),
    AgentConversationError,
  );
  assert.equal(calls.length, 0);
});

test("chave inválida do gerador não altera a sessão original", () => {
  const { tools } = makeTools();
  const session = readySession();
  const snapshotBefore = JSON.parse(JSON.stringify(session));
  assert.throws(() => run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => ""));
  assert.deepEqual(session, snapshotBefore);
});

// --- sucesso -----------------------------------------------------------------

test("sucesso avança para ORDER_CREATED e salva os identificadores do pedido", () => {
  const { tools } = makeTools();
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.event, "ORDER_CREATED");
  assert.equal(result.messageKey, "ORDER_CREATED");
  assert.equal(result.currentStep, "ORDER_CREATED");
  assert.equal(result.session.step, "ORDER_CREATED");
  assert.ok(result.session.createdOrderId);
  assert.ok(result.session.createdOrderPublicCode);
  assert.equal(result.data?.orderId, result.session.createdOrderId);
  assert.equal(result.data?.publicCode, result.session.createdOrderPublicCode);
  assert.equal(result.data?.replayed, false);
});

test("sucesso não expõe store completo, fingerprint nem detalhes internos no resultado", () => {
  const { tools } = makeTools();
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.deepEqual(Object.keys(result.data ?? {}).sort(), ["orderId", "publicCode", "replayed"]);
});

test("sucesso cria exatamente um pedido no domain store, calculado pelo serviço oficial", () => {
  const { tools, store } = makeTools();
  run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(store.orders.length, 1);
  const order = store.orders[0]!;
  assert.equal(order.paymentMethod, "PIX");
  assert.equal(order.fulfillmentType, "RETIRADA");
  assert.ok(order.total > 0);
});

test("sessão original não é mutada em uma confirmação bem-sucedida", () => {
  const { tools } = makeTools();
  const session = readySession();
  const snapshotBefore = JSON.parse(JSON.stringify(session));
  run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.deepEqual(session, snapshotBefore);
});

test("createdAt, sessionKey e processedMessageIds são preservados após CONFIRM_ORDER", () => {
  const { tools } = makeTools();
  const session = readySession({ processedMessageIds: ["m1", "m2"] });
  const result = run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.session.createdAt, session.createdAt);
  assert.equal(result.session.sessionKey, session.sessionKey);
  assert.deepEqual(result.session.processedMessageIds, ["m1", "m2"]);
});

test("expiresAt não é alterado pelo motor em CONFIRM_ORDER", () => {
  const { tools } = makeTools();
  const session = readySession();
  const result = run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.session.expiresAt, session.expiresAt);
});

// --- replay na mesma sessão --------------------------------------------------

test("replay: duas confirmações com a mesma sessão original e mesma chave criam apenas um pedido", () => {
  const { tools, store } = makeTools();
  const session = readySession({ orderIdempotencyKey: "agent-order:replay-0001" });
  const first = run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow());
  const second = run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow());
  assert.equal(first.data?.replayed, false);
  assert.equal(second.data?.replayed, true);
  assert.equal(first.data?.orderId, second.data?.orderId);
  assert.equal(first.data?.publicCode, second.data?.publicCode);
  assert.equal(store.orders.length, 1);
});

// --- sessão já com pedido criado ---------------------------------------------

test("sessão já com createdOrderId não cria um novo pedido", () => {
  const { tools: realTools, store } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  const result = run(
    readySession({ createdOrderId: "already-id", createdOrderPublicCode: "BF-ALREADY" }),
    { type: "CONFIRM_ORDER" },
    tools,
  );
  assert.equal(result.event, "ORDER_ALREADY_CREATED");
  assert.equal(result.messageKey, "ORDER_ALREADY_CREATED");
  assert.equal(result.currentStep, "ORDER_CREATED");
  assert.equal(calls.length, 0);
  assert.equal(store.orders.length, 0);
});

test("sessão já com apenas createdOrderPublicCode também é corrigida sem criar pedido", () => {
  const { tools: realTools } = makeTools();
  const { tools, calls } = spyCreateOrder(realTools);
  const result = run(readySession({ createdOrderPublicCode: "BF-ALREADY" }), { type: "CONFIRM_ORDER" }, tools);
  assert.equal(result.event, "ORDER_ALREADY_CREATED");
  assert.equal(result.currentStep, "ORDER_CREATED");
  assert.equal(result.data?.publicCode, "BF-ALREADY");
  assert.equal(calls.length, 0);
});

// --- falha do serviço oficial -------------------------------------------------

test("falha oficial mantém AWAITING_CONFIRMATION e não marca o pedido como criado", () => {
  const { tools: realTools } = makeTools();
  const tools: AgentTools = {
    ...realTools,
    createOrder: () => {
      throw new OrderCreationError(400, "invalid_item", "Há um produto indisponível ou uma quantidade inválida.");
    },
  };
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
  assert.equal(result.session.createdOrderId, undefined);
  assert.equal(result.session.createdOrderPublicCode, undefined);
});

test("falha oficial preserva orderIdempotencyKey para nova tentativa", () => {
  const { tools: realTools } = makeTools();
  const tools: AgentTools = {
    ...realTools,
    createOrder: () => {
      throw new OrderCreationError(400, "invalid_item", "Há um produto indisponível ou uma quantidade inválida.");
    },
  };
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.session.orderIdempotencyKey, "agent-order:test-0001");
});

test("falha oficial vira um resultado estruturado, não uma exceção", () => {
  const { tools: realTools } = makeTools();
  const tools: AgentTools = {
    ...realTools,
    createOrder: () => {
      throw new OrderCreationError(400, "invalid_item", "Há um produto indisponível ou uma quantidade inválida.");
    },
  };
  const result = run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(result.event, "ORDER_CREATION_FAILED");
  assert.equal(result.data?.code, "invalid_item");
});

test("falha não muta a sessão original", () => {
  const { tools: realTools } = makeTools();
  const tools: AgentTools = {
    ...realTools,
    createOrder: () => {
      throw new OrderCreationError(400, "invalid_item", "Há um produto indisponível ou uma quantidade inválida.");
    },
  };
  const session = readySession();
  const snapshotBefore = JSON.parse(JSON.stringify(session));
  run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.deepEqual(session, snapshotBefore);
});

test("IDEMPOTENCY_KEY_REUSED não gera chave nova nem tenta de novo automaticamente", () => {
  const { tools, store } = makeTools();
  const conflictingKey = "agent-order:conflict-0001";
  store.orders.push(fakeOrder({ idempotencyKey: conflictingKey, idempotencyFingerprint: "fingerprint-de-outro-pedido" }));
  let generatorCalls = 0;
  const result = run(
    readySession({ orderIdempotencyKey: conflictingKey }),
    { type: "CONFIRM_ORDER" },
    tools,
    fixedNow(),
    () => {
      generatorCalls += 1;
      return "agent-order:should-not-be-generated";
    },
  );
  assert.equal(generatorCalls, 0);
  assert.equal(result.event, "ORDER_CREATION_FAILED");
  assert.equal(result.data?.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(result.currentStep, "AWAITING_CONFIRMATION");
  assert.equal(result.session.orderIdempotencyKey, conflictingKey);
  assert.equal(store.orders.length, 1);
});

test("erro inesperado (não OrderCreationError) vira AgentConversationError com cause", () => {
  const { tools: realTools } = makeTools();
  const original = new Error("falha técnica inesperada");
  const tools: AgentTools = {
    ...realTools,
    createOrder: () => {
      throw original;
    },
  };
  assert.throws(
    () => run(readySession(), { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001"),
    (error: unknown) => error instanceof AgentConversationError && error.cause === original,
  );
});

// --- RESET_CONVERSATION em ORDER_CREATED -------------------------------------

test("RESET_CONVERSATION em ORDER_CREATED limpa referências do pedido na sessão", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "ORDER_CREATED",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria",
    paymentMethod: "PIX",
    createdOrderId: "order-1",
    createdOrderPublicCode: "BF-0001",
    orderIdempotencyKey: "agent-order:0001",
  });
  const result = run(session, { type: "RESET_CONVERSATION" }, tools);
  assert.equal(result.currentStep, "START");
  assert.equal(result.session.createdOrderId, undefined);
  assert.equal(result.session.createdOrderPublicCode, undefined);
  assert.equal(result.session.orderIdempotencyKey, undefined);
});

test("RESET_CONVERSATION em ORDER_CREATED não apaga o pedido real do domain store", () => {
  const { tools, store } = makeTools();
  const session = readySession();
  const confirmResult = run(session, { type: "CONFIRM_ORDER" }, tools, fixedNow(), () => "agent-order:test-0001");
  assert.equal(store.orders.length, 1);
  run(confirmResult.session, { type: "RESET_CONVERSATION" }, tools);
  assert.equal(store.orders.length, 1);
});

// --- 34: GO_BACK -----------------------------------------------------------

const GO_BACK_CASES: Array<[AgentConversationStep, AgentConversationStep]> = [
  ["BROWSING_MENU", "START"],
  ["BUILDING_ORDER", "BROWSING_MENU"],
  ["COLLECTING_NAME", "BUILDING_ORDER"],
  ["COLLECTING_FULFILLMENT", "COLLECTING_NAME"],
  ["COLLECTING_PICKUP_TIME", "COLLECTING_FULFILLMENT"],
  ["COLLECTING_PAYMENT", "COLLECTING_NOTES"],
  ["AWAITING_CONFIRMATION", "COLLECTING_PAYMENT"],
];

for (const [from, to] of GO_BACK_CASES) {
  test(`GO_BACK de ${from} volta para ${to}`, () => {
    const { tools } = makeTools();
    const result = run(makeSession({ step: from }), { type: "GO_BACK" }, tools);
    assert.equal(result.currentStep, to);
  });
}

test("GO_BACK de COLLECTING_NOTES com slots configurados volta para horário", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "COLLECTING_NOTES" }), { type: "GO_BACK" }, tools);
  assert.equal(result.currentStep, "COLLECTING_PICKUP_TIME");
});

test("GO_BACK de COLLECTING_NOTES sem slots configurados volta para recebimento", () => {
  const { tools } = makeTools({ business: { ...makeDomainStore().business, pickupSlots: [] } });
  const result = run(makeSession({ step: "COLLECTING_NOTES" }), { type: "GO_BACK" }, tools);
  assert.equal(result.currentStep, "COLLECTING_FULFILLMENT");
});

test("GO_BACK não apaga paymentMethod já coletado", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "AWAITING_CONFIRMATION", paymentMethod: "PIX" });
  const result = run(session, { type: "GO_BACK" }, tools);
  assert.equal(result.currentStep, "COLLECTING_PAYMENT");
  assert.equal(result.session.paymentMethod, "PIX");
});

test("GO_BACK não é permitido em ORDER_CREATED nem HUMAN_HANDOFF", () => {
  const { tools } = makeTools();
  const a = run(makeSession({ step: "ORDER_CREATED" }), { type: "GO_BACK" }, tools);
  const b = run(makeSession({ step: "HUMAN_HANDOFF" }), { type: "GO_BACK" }, tools);
  assert.equal(a.messageKey, "INVALID_ACTION");
  assert.equal(b.messageKey, "INVALID_ACTION");
});

// --- 35: CANCEL_CONVERSATION ------------------------------------------------

test("CANCEL_CONVERSATION limpa pedido e preserva identificação", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "COLLECTING_NOTES",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria",
    paymentMethod: "PIX",
    processedMessageIds: ["m1"],
  });
  const result = run(session, { type: "CANCEL_CONVERSATION" }, tools);
  assert.equal(result.currentStep, "START");
  assert.deepEqual(result.session.items, []);
  assert.equal(result.session.customerName, undefined);
  assert.equal(result.session.paymentMethod, undefined);
  assert.equal(result.session.sessionKey, session.sessionKey);
  assert.equal(result.session.channel, session.channel);
  assert.equal(result.session.contactId, session.contactId);
  assert.deepEqual(result.session.processedMessageIds, ["m1"]);
  assert.equal(result.messageKey, "CONVERSATION_CANCELLED");
});

test("CANCEL_CONVERSATION não é permitido após ORDER_CREATED", () => {
  const { tools } = makeTools();
  const result = run(makeSession({ step: "ORDER_CREATED" }), { type: "CANCEL_CONVERSATION" }, tools);
  assert.equal(result.messageKey, "INVALID_ACTION");
});

// --- 36: REQUEST_HUMAN ------------------------------------------------------

test("REQUEST_HUMAN preserva carrinho e dados coletados", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "COLLECTING_PICKUP_TIME",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria",
  });
  const result = run(session, { type: "REQUEST_HUMAN" }, tools);
  assert.equal(result.currentStep, "HUMAN_HANDOFF");
  assert.equal(result.session.underHumanHandoff, true);
  assert.deepEqual(result.session.items, [{ productId: "p1", quantity: 2 }]);
  assert.equal(result.session.customerName, "Maria");
  assert.equal(result.messageKey, "HUMAN_HANDOFF_STARTED");
});

// --- 37: RESET_CONVERSATION --------------------------------------------------

test("RESET_CONVERSATION limpa estado e preserva processedMessageIds e createdAt", () => {
  const { tools } = makeTools();
  const session = makeSession({
    step: "AWAITING_CONFIRMATION",
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria",
    paymentMethod: "PIX",
    underHumanHandoff: true,
    processedMessageIds: ["m1", "m2"],
  });
  const result = run(session, { type: "RESET_CONVERSATION" }, tools);
  assert.equal(result.currentStep, "START");
  assert.deepEqual(result.session.items, []);
  assert.equal(result.session.customerName, undefined);
  assert.equal(result.session.paymentMethod, undefined);
  assert.equal(result.session.underHumanHandoff, false);
  assert.deepEqual(result.session.processedMessageIds, ["m1", "m2"]);
  assert.equal(result.session.createdAt, session.createdAt);
});

// --- 38: ações inválidas ---------------------------------------------------

test("ação inválida não altera a sessão", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "START" });
  const result = run(session, { type: "SET_CUSTOMER_NAME", customerName: "Maria" }, tools);
  assert.equal(result.messageKey, "INVALID_ACTION");
  assert.deepEqual(result.session, session);
  assert.equal(result.data?.currentStep, "START");
  assert.equal(result.data?.actionType, "SET_CUSTOMER_NAME");
});

// --- 39: imutabilidade da sessão original -----------------------------------

test("sessão original não é mutada", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BROWSING_MENU" });
  const snapshotBefore = JSON.parse(JSON.stringify(session));
  run(session, { type: "ADD_ITEM", productId: "p1", quantity: 2 }, tools);
  assert.deepEqual(session, snapshotBefore);
});

// --- 40: arrays das Tools não são mutados -----------------------------------

test("arrays retornados pelas Tools não são mutados pelo motor", () => {
  const { tools, store } = makeTools();
  run(makeSession({ step: "BROWSING_MENU" }), { type: "SHOW_MENU" }, tools);
  assert.equal(store.products.length, 1);
  const productsBefore = tools.listProducts();
  productsBefore.push({ ...product(), id: "injetado" } as never);
  assert.equal(tools.listProducts().length, 1);
});

// --- 41-42: identidade imutável ----------------------------------------------

test("createdAt permanece imutável após uma transição", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BROWSING_MENU" });
  const result = run(session, { type: "ADD_ITEM", productId: "p1", quantity: 1 }, tools);
  assert.equal(result.session.createdAt, session.createdAt);
});

test("sessionKey, channel e contactId permanecem imutáveis após uma transição", () => {
  const { tools } = makeTools();
  const session = makeSession({ step: "BROWSING_MENU" });
  const result = run(session, { type: "ADD_ITEM", productId: "p1", quantity: 1 }, tools);
  assert.equal(result.session.sessionKey, session.sessionKey);
  assert.equal(result.session.channel, session.channel);
  assert.equal(result.session.contactId, session.contactId);
});
