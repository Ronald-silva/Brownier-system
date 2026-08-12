import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationPresentation } from "../src/agent/presentation.ts";
import type { AgentConversationResult } from "../src/agent/conversation.types.ts";
import type { AgentSession } from "../src/agent/session.types.ts";
import type { AgentTools, AgentPublicProduct, AgentPublicBusiness } from "../src/agent/tools.ts";

const FIXED_ISO = "2026-01-01T00:00:00.000Z";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionKey: "simulator:c1",
    channel: "simulator",
    contactId: "c1",
    step: "START",
    items: [],
    processedMessageIds: [],
    underHumanHandoff: false,
    misunderstandingCount: 0,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    expiresAt: FIXED_ISO,
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<AgentConversationResult> & { messageKey: string; session?: AgentSession },
): AgentConversationResult {
  const session = overrides.session ?? makeSession();
  return {
    previousStep: "START",
    currentStep: "START",
    event: overrides.messageKey,
    ...overrides,
    session,
  };
}

const FIXTURE_PRODUCTS: AgentPublicProduct[] = [
  {
    id: "p1",
    slug: "brigadeiro",
    name: "Brownie de Brigadeiro",
    description: "Brownie com brigadeiro",
    category: "Brownies",
    basePrice: 12,
    promotionalPrice: null,
    minimumPromotionalQuantity: null,
    ingredients: "chocolate",
    allergens: "glúten",
  },
];

const FIXTURE_BUSINESS: AgentPublicBusiness = {
  name: "Brownieria Fortal",
  phone: "8500000000",
  whatsapp: "8500000000",
  pickupEnabled: true,
  pickupSlots: ["19:00", "18:00", "18:00"],
  availabilityNotice: "",
  paymentMethods: ["PIX", " DINHEIRO ", "PIX", "", "CARTÃO"],
};

type SpyCalls = {
  listProducts: number;
  getProduct: number;
  getBusiness: number;
  getPickupSlots: number;
  createOrder: number;
  getOrder: number;
  validatePickupTime: number;
};

function createSpyTools(): { tools: AgentTools; calls: SpyCalls } {
  const calls: SpyCalls = {
    listProducts: 0,
    getProduct: 0,
    getBusiness: 0,
    getPickupSlots: 0,
    createOrder: 0,
    getOrder: 0,
    validatePickupTime: 0,
  };
  const tools: AgentTools = {
    listProducts() {
      calls.listProducts++;
      return FIXTURE_PRODUCTS.map(p => ({ ...p }));
    },
    getProduct(productId) {
      calls.getProduct++;
      const found = FIXTURE_PRODUCTS.find(p => p.id === productId);
      return found ? { ...found } : null;
    },
    getBusiness() {
      calls.getBusiness++;
      return {
        ...FIXTURE_BUSINESS,
        pickupSlots: [...FIXTURE_BUSINESS.pickupSlots],
        paymentMethods: [...FIXTURE_BUSINESS.paymentMethods],
      };
    },
    getPickupSlots() {
      calls.getPickupSlots++;
      return [...new Set(FIXTURE_BUSINESS.pickupSlots)].sort();
    },
    validatePickupTime(time) {
      calls.validatePickupTime++;
      return FIXTURE_BUSINESS.pickupSlots.includes(time);
    },
    createOrder() {
      calls.createOrder++;
      throw new Error("createOrder não deveria ser chamado pela camada de apresentação");
    },
    getOrder() {
      calls.getOrder++;
      return null;
    },
  };
  return { tools, calls };
}

// --- WELCOME ---------------------------------------------------------------

test("WELCOME resolve businessName a partir de tools.getBusiness()", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "WELCOME" }), tools });
  assert.equal(presentation.context.business?.name, "Brownieria Fortal");
});

test("WELCOME funciona sem businessName configurado", () => {
  const { tools } = createSpyTools();
  const noNameTools: AgentTools = { ...tools, getBusiness: () => ({ ...FIXTURE_BUSINESS, name: "", pickupSlots: [], paymentMethods: [] }) };
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "WELCOME" }), tools: noNameTools });
  assert.equal(presentation.context.business?.name, undefined);
});

// --- MENU_READY --------------------------------------------------------------

test("MENU_READY obtém produtos de tools.listProducts()", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "MENU_READY" }), tools });
  assert.equal(presentation.context.products?.length, 1);
  assert.equal(presentation.context.products?.[0].name, "Brownie de Brigadeiro");
});

test("MENU_READY não expõe campos administrativos", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "MENU_READY" }), tools });
  const product = presentation.context.products?.[0] as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(product, "category"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(product, "ingredients"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(product, "allergens"), false);
});

// --- ITEM_ADDED / ITEM_REMOVED / ITEM_QUANTITY_UPDATED ----------------------

test("ITEM_ADDED resolve o nome do produto pelo productId", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ITEM_ADDED", data: { productId: "p1", quantity: 2 } }),
    tools,
  });
  assert.equal(presentation.context.currentProduct?.name, "Brownie de Brigadeiro");
});

test("ITEM_ADDED sem produto resolvido permanece seguro", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ITEM_ADDED", data: { productId: "inexistente", quantity: 2 } }),
    tools,
  });
  assert.equal(presentation.context.currentProduct, undefined);
});

test("ITEMS_ADDED_BATCH resolve nome e quantidade de cada item do lote", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({
      messageKey: "ITEMS_ADDED_BATCH",
      data: { items: [{ productId: "p1", quantity: 2 }, { productId: "outro-produto", quantity: 1 }] },
    }),
    tools,
  });
  assert.deepEqual(
    presentation.context.cartItems?.map(item => ({ productId: item.productId, name: item.name, quantity: item.quantity })),
    [
      { productId: "p1", name: "Brownie de Brigadeiro", quantity: 2 },
      { productId: "outro-produto", name: "Produto indisponível", quantity: 1 },
    ],
  );
});

test("ITEMS_ADDED_BATCH com produto inexistente permanece seguro", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ITEMS_ADDED_BATCH", data: { items: [{ productId: "inexistente", quantity: 1 }] } }),
    tools,
  });
  assert.equal(presentation.context.cartItems?.[0]?.name, "Produto indisponível");
});

test("ITEM_REMOVED resolve nome quando possível", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ITEM_REMOVED", data: { productId: "p1" } }),
    tools,
  });
  assert.equal(presentation.context.currentProduct?.name, "Brownie de Brigadeiro");
});

test("ITEM_QUANTITY_UPDATED resolve nome quando possível", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ITEM_QUANTITY_UPDATED", data: { productId: "p1", quantity: 5 } }),
    tools,
  });
  assert.equal(presentation.context.currentProduct?.name, "Brownie de Brigadeiro");
});

// --- ASK_PAYMENT_METHOD ------------------------------------------------------

test("ASK_PAYMENT_METHOD obtém opções de tools.getBusiness().paymentMethods", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ASK_PAYMENT_METHOD" }), tools });
  assert.deepEqual(presentation.context.paymentOptions, ["PIX", "DINHEIRO", "CARTÃO"]);
});

test("opções vazias não recebem fallback inventado", () => {
  const { tools } = createSpyTools();
  const emptyTools: AgentTools = { ...tools, getBusiness: () => ({ ...FIXTURE_BUSINESS, paymentMethods: [] }) };
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ASK_PAYMENT_METHOD" }), tools: emptyTools });
  assert.deepEqual(presentation.context.paymentOptions, []);
});

test("opções duplicadas são removidas", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "PAYMENT_METHOD_INVALID" }), tools });
  assert.equal(presentation.context.paymentOptions?.filter(o => o === "PIX").length, 1);
});

test("ordem das opções configuradas pelo Business é preservada", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "PAYMENT_METHOD_UNAVAILABLE" }), tools });
  assert.deepEqual(presentation.context.paymentOptions, ["PIX", "DINHEIRO", "CARTÃO"]);
});

// --- ASK_PICKUP_TIME ----------------------------------------------------------

test("ASK_PICKUP_TIME obtém horários de tools.getPickupSlots()", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ASK_PICKUP_TIME" }), tools });
  assert.deepEqual(presentation.context.pickupSlots, ["18:00", "19:00"]);
});

test("slots vazios são tratados sem inventar horário", () => {
  const { tools } = createSpyTools();
  const emptyTools: AgentTools = { ...tools, getPickupSlots: () => [] };
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ASK_PICKUP_TIME" }), tools: emptyTools });
  assert.deepEqual(presentation.context.pickupSlots, []);
});

// --- ORDER_REVIEW --------------------------------------------------------------

test("ORDER_REVIEW monta cartItems a partir da sessão e do catálogo", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ items: [{ productId: "p1", quantity: 2 }] });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW", session }), session, tools });
  assert.deepEqual(presentation.context.cartItems, [{ productId: "p1", name: "Brownie de Brigadeiro", quantity: 2, unitPrice: 12 }]);
});

test("ORDER_REVIEW usa os nomes atuais dos produtos", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ items: [{ productId: "p1", quantity: 1 }] });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(presentation.context.cartItems?.[0].name, "Brownie de Brigadeiro");
});

test("ORDER_REVIEW inclui customerName da sessão", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ customerName: "José" });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(presentation.context.customerName, "José");
});

test("ORDER_REVIEW inclui pickupTime da sessão", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ pickupTime: "19:00" });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(presentation.context.pickupTime, "19:00");
});

test("ORDER_REVIEW inclui paymentMethod da sessão", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ paymentMethod: "PIX" });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(presentation.context.paymentMethod, "PIX");
});

test("ORDER_REVIEW trata produto indisponível com nome genérico, sem apagar o item", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ items: [{ productId: "removido-do-catalogo", quantity: 3 }] });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.deepEqual(presentation.context.cartItems, [
    { productId: "removido-do-catalogo", name: "Produto indisponível", quantity: 3, unitPrice: undefined },
  ]);
});

// --- ORDER_CREATED / ORDER_ALREADY_CREATED -----------------------------------

test("ORDER_CREATED não expõe orderId interno", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ORDER_CREATED", data: { orderId: "uuid-interno", publicCode: "ABC123" } }),
    tools,
  });
  assert.equal(JSON.stringify(presentation.context).includes("uuid-interno"), false);
});

test("ORDER_CREATED inclui publicCode", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({ messageKey: "ORDER_CREATED", data: { publicCode: "ABC123" } }),
    tools,
  });
  assert.equal(presentation.context.order?.publicCode, "ABC123");
});

// --- ORDER_CREATION_FAILED -----------------------------------------------------

test("ORDER_CREATION_FAILED transporta somente o código seguro", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({
    result: makeResult({
      messageKey: "ORDER_CREATION_FAILED",
      data: { code: "invalid_pickup_time", cause: new Error("interno") },
    }),
    tools,
  });
  assert.equal(presentation.context.reasonCode, "invalid_pickup_time");
  assert.equal(JSON.stringify(presentation.context).includes("interno"), false);
});

// --- MESSAGE_ALREADY_PROCESSED -------------------------------------------------

test("MESSAGE_ALREADY_PROCESSED não chama nenhuma Tool", () => {
  const { tools, calls } = createSpyTools();
  buildConversationPresentation({
    result: makeResult({ messageKey: "MESSAGE_ALREADY_PROCESSED", data: { messageId: "m1" } }),
    tools,
  });
  assert.deepEqual(calls, {
    listProducts: 0,
    getProduct: 0,
    getBusiness: 0,
    getPickupSlots: 0,
    createOrder: 0,
    getOrder: 0,
    validatePickupTime: 0,
  });
});

test("MESSAGE_ALREADY_PROCESSED devolve contexto vazio", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "MESSAGE_ALREADY_PROCESSED" }), tools });
  assert.deepEqual(presentation.context, {});
});

// --- imutabilidade --------------------------------------------------------------

test("buildConversationPresentation não muta o result original", () => {
  const { tools } = createSpyTools();
  const result = makeResult({ messageKey: "MENU_READY" });
  const snapshot = JSON.stringify(result);
  buildConversationPresentation({ result, tools });
  assert.equal(JSON.stringify(result), snapshot);
});

test("buildConversationPresentation não muta a session original", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ items: [{ productId: "p1", quantity: 1 }] });
  const snapshot = JSON.stringify(session);
  buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(JSON.stringify(session), snapshot);
});

test("arrays devolvidos pelas Tools não são mutados pela apresentação", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "MENU_READY" }), tools });
  presentation.context.products?.push({ id: "fake", name: "Fake" });
  const again = buildConversationPresentation({ result: makeResult({ messageKey: "MENU_READY" }), tools });
  assert.equal(again.context.products?.length, 1);
});

test("contexto retornado usa cópias defensivas", () => {
  const { tools } = createSpyTools();
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ASK_PAYMENT_METHOD" }), tools });
  presentation.context.paymentOptions?.push("FIADO");
  const again = buildConversationPresentation({ result: makeResult({ messageKey: "ASK_PAYMENT_METHOD" }), tools });
  assert.deepEqual(again.context.paymentOptions, ["PIX", "DINHEIRO", "CARTÃO"]);
});

// --- não cria pedido / não calcula preços --------------------------------------

test("tools.createOrder nunca é chamada pela apresentação", () => {
  const { tools, calls } = createSpyTools();
  const session = makeSession({ items: [{ productId: "p1", quantity: 2 }] });
  for (const messageKey of [
    "WELCOME", "MENU_READY", "ITEM_ADDED", "ITEMS_ADDED_BATCH", "ASK_PAYMENT_METHOD", "ASK_PICKUP_TIME", "ORDER_REVIEW", "ORDER_CREATED",
  ]) {
    buildConversationPresentation({
      result: makeResult({ messageKey, session, data: { productId: "p1", quantity: 1, publicCode: "X", items: [{ productId: "p1", quantity: 1 }] } }),
      session,
      tools,
    });
  }
  assert.equal(calls.createOrder, 0);
});

test("nenhum cálculo de preço é feito — unitPrice apenas transportado do catálogo", () => {
  const { tools } = createSpyTools();
  const session = makeSession({ items: [{ productId: "p1", quantity: 3 }] });
  const presentation = buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(presentation.context.cartItems?.[0].unitPrice, 12);
});

// --- contagem de chamadas de Tools ----------------------------------------------

test("ORDER_REVIEW chama listProducts uma única vez", () => {
  const { tools, calls } = createSpyTools();
  const session = makeSession({
    items: [
      { productId: "p1", quantity: 1 },
      { productId: "p1", quantity: 1 },
    ],
  });
  buildConversationPresentation({ result: makeResult({ messageKey: "ORDER_REVIEW" }), session, tools });
  assert.equal(calls.listProducts, 1);
});
