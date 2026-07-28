import assert from "node:assert/strict";
import test from "node:test";
import { createOrder, OrderCreationError, type ProductForOrderCreation, type StoreLike } from "../src/lib/orders.ts";

function product(overrides: Partial<ProductForOrderCreation> = {}): ProductForOrderCreation {
  return {
    id: "p1", name: "Brownie de Brigadeiro", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20,
    isActive: true, isAvailable: true,
    ...overrides,
  };
}

function makeStore(overrides: Partial<StoreLike> = {}): StoreLike {
  return {
    business: { pickupEnabled: true, deliveryEnabled: true, deliveryFee: 5, pickupSlots: [] },
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
    pickupTime: "",
    ...overrides,
  };
}

test("cria um pedido válido calculando subtotal e total a partir do produto", () => {
  const store = makeStore();
  const { order, replayed } = createOrder({ store, payload: basePayload() });
  assert.equal(order.subtotal, 10);
  assert.equal(order.discount, 0);
  assert.equal(order.deliveryFee, 0);
  assert.equal(order.total, 10);
  assert.equal(order.items.length, 1);
  assert.equal(replayed, false);
});

test("aceita dois produtos diferentes no mesmo pedido", () => {
  const store = makeStore({ products: [product({ id: "p1" }), product({ id: "p2", name: "Brownie de Ninho" })] });
  const { order } = createOrder({
    store,
    payload: basePayload({ items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 3 }] }),
  });
  assert.equal(order.items.length, 2);
  assert.equal(order.subtotal, 2 * 5 + 3 * 5);
});

test("aplica desconto agregado quando a soma de sabores diferentes atinge o mínimo promocional", () => {
  const store = makeStore({ products: [product({ id: "p1" }), product({ id: "p2", name: "Brownie de Ninho" })] });
  const { order } = createOrder({
    store,
    payload: basePayload({ items: [{ productId: "p1", quantity: 10 }, { productId: "p2", quantity: 10 }] }),
  });
  assert.equal(order.subtotal, 60);
  assert.equal(order.discount, 40);
  assert.equal(order.total, 60);
});

test("rejeita item com produto inexistente", () => {
  const store = makeStore();
  assert.throws(
    () => createOrder({ store, payload: basePayload({ items: [{ productId: "nao-existe", quantity: 1 }] }) }),
    OrderCreationError,
  );
});

test("rejeita item de produto inativo", () => {
  const store = makeStore({ products: [product({ isActive: false })] });
  assert.throws(() => createOrder({ store, payload: basePayload() }), OrderCreationError);
});

test("rejeita item de produto indisponível", () => {
  const store = makeStore({ products: [product({ isAvailable: false })] });
  assert.throws(() => createOrder({ store, payload: basePayload() }), OrderCreationError);
});

test("rejeita quantidade zero", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ items: [{ productId: "p1", quantity: 0 }] }) }), OrderCreationError);
});

test("rejeita quantidade decimal", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ items: [{ productId: "p1", quantity: 1.5 }] }) }), OrderCreationError);
});

test("rejeita quantidade acima do limite permitido", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ items: [{ productId: "p1", quantity: 101 }] }) }), OrderCreationError);
});

test("rejeita nome do cliente inválido", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ customerName: "" }) }), OrderCreationError);
});

test("rejeita telefone do cliente inválido", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ customerPhone: "" }) }), OrderCreationError);
});

test("rejeita fulfillmentType inválido", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ fulfillmentType: "TELEPORTE" }) }), OrderCreationError);
});

test("rejeita paymentMethod inválido", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ paymentMethod: "BITCOIN" }) }), OrderCreationError);
});

test("rejeita retirada quando pickupEnabled está desabilitado", () => {
  const store = makeStore({ business: { pickupEnabled: false, deliveryEnabled: true, deliveryFee: 5, pickupSlots: [] } });
  assert.throws(() => createOrder({ store, payload: basePayload() }), OrderCreationError);
});

test("aceita horário de retirada presente na lista de horários configurados", () => {
  const store = makeStore({ business: { pickupEnabled: true, deliveryEnabled: true, deliveryFee: 5, pickupSlots: ["18:00", "19:00"] } });
  const { order } = createOrder({ store, payload: basePayload({ pickupTime: "18:00" }) });
  assert.equal(order.pickupTime, "18:00");
});

test("rejeita horário de retirada fora da lista de horários configurados", () => {
  const store = makeStore({ business: { pickupEnabled: true, deliveryEnabled: true, deliveryFee: 5, pickupSlots: ["18:00", "19:00"] } });
  assert.throws(() => createOrder({ store, payload: basePayload({ pickupTime: "20:00" }) }), OrderCreationError);
});

test("exige endereço de entrega quando fulfillmentType é ENTREGA", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload({ fulfillmentType: "ENTREGA", deliveryAddress: "" }) }), OrderCreationError);
});

test("aceita ENTREGA quando o endereço é informado e a modalidade está habilitada", () => {
  const store = makeStore();
  const { order } = createOrder({ store, payload: basePayload({ fulfillmentType: "ENTREGA", deliveryAddress: "Rua das Flores, 123" }) });
  assert.equal(order.deliveryAddress, "Rua das Flores, 123");
  assert.equal(order.deliveryFee, 5);
});

test("ignora subtotal, desconto e total falsos enviados no payload e recalcula no servidor", () => {
  const store = makeStore();
  const { order } = createOrder({
    store,
    payload: basePayload({ subtotal: 1, discount: 999, total: 1, items: [{ productId: "p1", quantity: 2, unitPrice: 0.01 }] }),
  });
  assert.equal(order.subtotal, 10);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 10);
});

test("usa now, generateId e generatePublicCode injetados para permitir testes determinísticos", () => {
  const store = makeStore();
  const fixedDate = new Date("2026-07-28T12:00:00.000Z");
  const { order } = createOrder({
    store,
    payload: basePayload(),
    now: () => fixedDate,
    generateId: () => "id-fixo",
    generatePublicCode: () => "BF-FIXO",
  });
  assert.equal(order.id, "id-fixo");
  assert.equal(order.publicCode, "BF-FIXO");
  assert.equal(order.createdAt, fixedDate.toISOString());
  assert.equal(order.updatedAt, fixedDate.toISOString());
});

test("insere o pedido uma única vez em store.orders", () => {
  const store = makeStore();
  createOrder({ store, payload: basePayload() });
  assert.equal(store.orders.length, 1);
});

// --- Idempotência (Idempotency-Key) ---

const KEY_A = "order-key-0001";
const KEY_B = "order-key-0002";

test("[idempotência] pedido sem chave continua criando normalmente, sem deduplicar", () => {
  const store = makeStore();
  createOrder({ store, payload: basePayload() });
  createOrder({ store, payload: basePayload() });
  assert.equal(store.orders.length, 2);
  assert.notEqual(store.orders[0].id, store.orders[1].id);
});

test("[idempotência] primeira chamada com chave válida cria um pedido novo", () => {
  const store = makeStore();
  const { order, replayed } = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(replayed, false);
  assert.equal(store.orders.length, 1);
  assert.equal(order.idempotencyKey, KEY_A);
});

test("[idempotência] segunda chamada idêntica com a mesma chave retorna o mesmo pedido", () => {
  const store = makeStore();
  const first = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(second.order.id, first.order.id);
});

test("[idempotência] repetição com a mesma chave não insere um segundo pedido", () => {
  const store = makeStore();
  createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(store.orders.length, 1);
});

test("[idempotência] resultado indica replayed:false na primeira chamada e replayed:true na repetição", () => {
  const store = makeStore();
  const first = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
});

test("[idempotência] id permanece igual entre a chamada original e a repetição", () => {
  const store = makeStore();
  const first = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(second.order.id, first.order.id);
});

test("[idempotência] publicCode permanece igual entre a chamada original e a repetição", () => {
  const store = makeStore();
  const first = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(second.order.publicCode, first.order.publicCode);
});

test("[idempotência] createdAt permanece igual entre a chamada original e a repetição", () => {
  const store = makeStore();
  const first = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A, now: () => new Date("2026-07-28T10:00:00.000Z") });
  const second = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A, now: () => new Date("2026-07-28T10:05:00.000Z") });
  assert.equal(second.order.createdAt, first.order.createdAt);
});

test("[idempotência] mesma chave com payload de outro produto retorna 409", () => {
  const store = makeStore({ products: [product({ id: "p1" }), product({ id: "p2", name: "Brownie de Ninho" })] });
  createOrder({ store, payload: basePayload({ items: [{ productId: "p1", quantity: 2 }] }), idempotencyKey: KEY_A });
  assert.throws(
    () => createOrder({ store, payload: basePayload({ items: [{ productId: "p2", quantity: 2 }] }), idempotencyKey: KEY_A }),
    (error: unknown) => error instanceof OrderCreationError && error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("[idempotência] mesma chave com quantidade diferente retorna 409", () => {
  const store = makeStore();
  createOrder({ store, payload: basePayload({ items: [{ productId: "p1", quantity: 2 }] }), idempotencyKey: KEY_A });
  assert.throws(
    () => createOrder({ store, payload: basePayload({ items: [{ productId: "p1", quantity: 3 }] }), idempotencyKey: KEY_A }),
    (error: unknown) => error instanceof OrderCreationError && error.status === 409,
  );
});

test("[idempotência] mesma chave com cliente diferente retorna 409", () => {
  const store = makeStore();
  createOrder({ store, payload: basePayload({ customerName: "Maria Silva" }), idempotencyKey: KEY_A });
  assert.throws(
    () => createOrder({ store, payload: basePayload({ customerName: "Outra Pessoa" }), idempotencyKey: KEY_A }),
    (error: unknown) => error instanceof OrderCreationError && error.status === 409,
  );
});

test("[idempotência] chaves diferentes criam pedidos diferentes mesmo com o mesmo payload", () => {
  const store = makeStore();
  const first = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_B });
  assert.notEqual(second.order.id, first.order.id);
  assert.equal(store.orders.length, 2);
});

test("[idempotência] chave vazia enviada é rejeitada", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload(), idempotencyKey: "" }), OrderCreationError);
});

test("[idempotência] chave maior que 128 caracteres é rejeitada", () => {
  const store = makeStore();
  const longKey = "a".repeat(129);
  assert.throws(() => createOrder({ store, payload: basePayload(), idempotencyKey: longKey }), OrderCreationError);
});

test("[idempotência] chave com caracteres inválidos é rejeitada", () => {
  const store = makeStore();
  assert.throws(() => createOrder({ store, payload: basePayload(), idempotencyKey: "chave com espaço e *" }), OrderCreationError);
});

test("[idempotência] pedido antigo sem idempotencyKey continua compatível e não conflita com uma nova chave", () => {
  const store = makeStore();
  const legacyOrder = createOrder({ store, payload: basePayload() }).order;
  assert.equal(legacyOrder.idempotencyKey, undefined);
  const { order, replayed } = createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A });
  assert.equal(replayed, false);
  assert.equal(store.orders.length, 2);
  assert.notEqual(order.id, legacyOrder.id);
});

test("[idempotência] ordem diferente das propriedades do payload não gera conflito", () => {
  const store = makeStore();
  const payloadA = basePayload();
  const payloadB = JSON.parse(JSON.stringify({
    paymentMethod: payloadA.paymentMethod,
    pickupTime: payloadA.pickupTime,
    fulfillmentType: payloadA.fulfillmentType,
    customerPhone: payloadA.customerPhone,
    customerName: payloadA.customerName,
    items: payloadA.items,
  }));
  createOrder({ store, payload: payloadA, idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: payloadB, idempotencyKey: KEY_A });
  assert.equal(second.replayed, true);
  assert.equal(store.orders.length, 1);
});

test("[idempotência] campos de preço falsos enviados pelo cliente não afetam o fingerprint", () => {
  const store = makeStore();
  createOrder({ store, payload: basePayload({ subtotal: 1, total: 1, discount: 0 }), idempotencyKey: KEY_A });
  const second = createOrder({ store, payload: basePayload({ subtotal: 999, total: 999, discount: 500 }), idempotencyKey: KEY_A });
  assert.equal(second.replayed, true);
  assert.equal(store.orders.length, 1);
});

test("[idempotência] repetição não chama generateId novamente", () => {
  const store = makeStore();
  let calls = 0;
  const generateId = () => { calls += 1; return `id-${calls}`; };
  createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A, generateId });
  createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A, generateId });
  assert.equal(calls, 1);
});

test("[idempotência] repetição não chama generatePublicCode novamente", () => {
  const store = makeStore();
  let calls = 0;
  const generatePublicCode = () => { calls += 1; return `BF-${calls}`; };
  createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A, generatePublicCode });
  createOrder({ store, payload: basePayload(), idempotencyKey: KEY_A, generatePublicCode });
  assert.equal(calls, 1);
});
