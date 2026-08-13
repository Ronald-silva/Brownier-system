import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentTools,
  AgentToolError,
  type AgentDomainStore,
} from "../src/agent/tools.ts";
import { createOrder as officialCreateOrder, type CreateOrderInput, type CreateOrderResult } from "../src/lib/orders.ts";
import { INITIAL_OPERATING_HOURS } from "../src/lib/business-hours.ts";

function product(overrides: Partial<AgentDomainStore["products"][number]> = {}) {
  return {
    id: "p1", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "Descrição do brigadeiro",
    category: "Brownies", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20,
    isActive: true, isAvailable: true, displayOrder: 1, ingredients: "Chocolate", allergens: "Glúten",
    ...overrides,
  };
}

function makeStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
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

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ productId: "p1", quantity: 2 }],
    customerName: "Maria Silva",
    customerPhone: "85999998888",
    fulfillmentType: "RETIRADA",
    paymentMethod: "PIX",
    pickupTime: "18:00",
    ...overrides,
  };
}

// --- listProducts ---

test("listProducts retorna apenas produtos ativos e disponíveis", () => {
  const store = makeStore({
    products: [
      product({ id: "ativo-disponivel", displayOrder: 1 }),
      product({ id: "inativo", isActive: false, displayOrder: 2 }),
      product({ id: "indisponivel", isAvailable: false, displayOrder: 3 }),
    ],
  });
  const tools = createAgentTools({ store });
  const products = tools.listProducts();
  assert.deepEqual(products.map(p => p.id), ["ativo-disponivel"]);
});

test("listProducts ordena por displayOrder", () => {
  const store = makeStore({
    products: [
      product({ id: "segundo", displayOrder: 2 }),
      product({ id: "primeiro", displayOrder: 1 }),
      product({ id: "terceiro", displayOrder: 3 }),
    ],
  });
  const tools = createAgentTools({ store });
  const products = tools.listProducts();
  assert.deepEqual(products.map(p => p.id), ["primeiro", "segundo", "terceiro"]);
});

test("listProducts não devolve campos administrativos", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const [product] = tools.listProducts();
  assert.equal((product as Record<string, unknown>).isActive, undefined);
  assert.equal((product as Record<string, unknown>).isAvailable, undefined);
  assert.equal((product as Record<string, unknown>).displayOrder, undefined);
});

// --- getProduct ---

test("getProduct retorna o produto quando o id existe", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const found = tools.getProduct("p1");
  assert.equal(found?.id, "p1");
  assert.equal(found?.name, "Brownie de Brigadeiro");
});

test("getProduct retorna null quando o id não existe, sem lançar erro", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  assert.equal(tools.getProduct("nao-existe"), null);
});

// --- getBusiness ---

test("getBusiness retorna apenas os campos úteis ao atendimento", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const business = tools.getBusiness();
  assert.deepEqual(business, {
    name: "Brownieria Fortal",
    phone: "8530000000",
    whatsapp: "85999998888",
    pickupEnabled: true,
    pickupSlots: ["18:00", "19:00"],
    availabilityNotice: "Sabores podem variar.",
    paymentMethods: ["PIX", "DINHEIRO"],
  });
});

// --- getPickupSlots ---

test("getPickupSlots retorna os horários ordenados", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  assert.deepEqual(tools.getPickupSlots(), ["18:00", "19:00"]);
});

test("getPickupSlots nunca modifica o Business original", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const slots = tools.getPickupSlots();
  slots.push("20:00");
  assert.deepEqual(store.business.pickupSlots, ["19:00", "18:00"]);
});

// --- validatePickupTime ---

test("validatePickupTime retorna true para um horário configurado", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  assert.equal(tools.validatePickupTime("18:00"), true);
});

test("validatePickupTime retorna false para um horário não configurado", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  assert.equal(tools.validatePickupTime("23:00"), false);
});

test("validatePickupTime não lança exceção mesmo com entrada inesperada", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  assert.doesNotThrow(() => tools.validatePickupTime(undefined as unknown as string));
});

// --- createOrder ---

test("createOrder delega para a função oficial de orders.ts e retorna exatamente o resultado dela", () => {
  const store = makeStore();
  let receivedInput: CreateOrderInput | undefined;
  const spyResult: CreateOrderResult = { order: { id: "spy-id" } as CreateOrderResult["order"], replayed: false };
  const createOrderFn = (input: CreateOrderInput) => {
    receivedInput = input;
    return spyResult;
  };
  const tools = createAgentTools({ store, createOrderFn });
  const result = tools.createOrder({ payload: basePayload() });
  assert.equal(result, spyResult);
  assert.equal(receivedInput?.store, store);
  assert.deepEqual(receivedInput?.payload, basePayload());
});

test("createOrder sem spy realmente cria o pedido usando a regra oficial de preços", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const { order } = tools.createOrder({ payload: basePayload() });
  assert.equal(order.subtotal, 10);
  assert.equal(order.total, 10);
  assert.equal(store.orders.length, 1);
});

test("quoteCart usa a mesma regra oficial de promoção por quantidade do pedido final", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const quote = tools.quoteCart!([{ productId: "p1", quantity: 20 }]);
  assert.deepEqual(quote, {
    items: [{ productId: "p1", name: "Brownie de Brigadeiro", quantity: 20, unitPrice: 3, totalPrice: 60 }],
    subtotal: 60,
    discount: 40,
    total: 60,
  });
});

test("quoteCart falha de forma segura para item indisponível", () => {
  const tools = createAgentTools({ store: makeStore() });
  assert.equal(tools.quoteCart!([{ productId: "nao-existe", quantity: 1 }]), null);
});

// --- getOrder ---

test("getOrder retorna o pedido quando o publicCode existe", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  const { order } = tools.createOrder({ payload: basePayload() });
  const found = tools.getOrder(order.publicCode);
  assert.equal(found?.id, order.id);
});

test("getOrder retorna null quando o publicCode não existe, sem lançar erro", () => {
  const store = makeStore();
  const tools = createAgentTools({ store });
  assert.equal(tools.getOrder("BF-INEXISTENTE"), null);
});

// --- dependências ---

test("createAgentTools rejeita a criação sem um store injetado", () => {
  assert.throws(() => createAgentTools({} as never), AgentToolError);
});

// --- integração: nenhuma regra duplicada ---

test("[integração] listProducts reflete exatamente basePrice/promotionalPrice do produto, sem recalcular preço", () => {
  const store = makeStore({ products: [product({ id: "p1", basePrice: 7, promotionalPrice: 4, minimumPromotionalQuantity: 15 })] });
  const tools = createAgentTools({ store });
  const [listed] = tools.listProducts();
  assert.equal(listed.basePrice, 7);
  assert.equal(listed.promotionalPrice, 4);
  assert.equal(listed.minimumPromotionalQuantity, 15);
});

test("[integração] validatePickupTime usa a mesma função isPickupTimeAllowed injetável de orders.ts", () => {
  const store = makeStore();
  let calledWith: [unknown, unknown] | undefined;
  const isPickupTimeAllowedFn = (time: unknown, slots: unknown) => {
    calledWith = [time, slots];
    return true;
  };
  const tools = createAgentTools({ store, isPickupTimeAllowedFn });
  const result = tools.validatePickupTime("qualquer-coisa");
  assert.equal(result, true);
  assert.deepEqual(calledWith, ["qualquer-coisa", store.business.pickupSlots]);
});

test("[integração] tools.createOrder e orders.ts oficial calculam o mesmo total para o mesmo payload", () => {
  const storeForTools = makeStore();
  const storeForOfficial = makeStore();
  const tools = createAgentTools({ store: storeForTools });
  const fromTools = tools.createOrder({ payload: basePayload() });
  const fromOfficial = officialCreateOrder({ store: storeForOfficial, payload: basePayload() });
  assert.equal(fromTools.order.subtotal, fromOfficial.order.subtotal);
  assert.equal(fromTools.order.discount, fromOfficial.order.discount);
  assert.equal(fromTools.order.total, fromOfficial.order.total);
});

// --- getOperatingStatus ---

test("getOperatingStatus delega para operating-status.ts usando o relógio injetado e o horário cadastrado", () => {
  const store = makeStore({ business: { ...makeStore().business, operatingHours: INITIAL_OPERATING_HOURS } });
  const tools = createAgentTools({ store, now: () => new Date("2026-08-03T10:00:00-03:00") }); // segunda, 10h
  const status = tools.getOperatingStatus!();
  assert.equal(status.known, true);
  if (status.known) { assert.equal(status.isOpenNow, true); assert.equal(status.currentClose, "18:00"); }
});

test("getTomorrowPickupSchedule retorna o horário real do próximo dia no fuso da loja", () => {
  const store = makeStore({ business: { ...makeStore().business, operatingHours: INITIAL_OPERATING_HOURS } });
  const tools = createAgentTools({ store, now: () => new Date("2026-08-03T10:00:00-03:00") }); // segunda; amanhã é terça
  assert.deepEqual(tools.getTomorrowPickupSchedule!(), { weekday: "terça-feira", hours: "8h às 18h", open: true });
});

test("getOperatingStatus nunca lança quando operatingHours está ausente ou malformado — vira known:false", () => {
  const missing = createAgentTools({ store: makeStore() });
  assert.deepEqual(missing.getOperatingStatus!(), { known: false });

  const malformed = createAgentTools({ store: makeStore({ business: { ...makeStore().business, operatingHours: "seg a sex" } }) });
  assert.deepEqual(malformed.getOperatingStatus!(), { known: false });
});
