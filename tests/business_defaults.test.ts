import assert from "node:assert/strict";
import test from "node:test";
import { BROWNIER_DELIVERY_ENABLED, BROWNIER_HOURS_VERSION, BROWNIER_PAYMENT_METHODS, BROWNIER_PICKUP_ADDRESS, BROWNIER_PIX_KEY, BROWNIER_RESPONSIBLE_NAME, BROWNIER_WHATSAPP, ensureBrownierDeliveryEnabled, ensureBrownierPaymentMethods, ensureBrownierPickupAddress, ensureBrownierOperatingHours, ensureBrownierPixKey, ensureBrownierResponsible, ensureBrownierWhatsapp } from "../src/lib/business-defaults.ts";
import { INITIAL_OPERATING_HOURS } from "../src/lib/business-hours.ts";

test("a semente comercial usa o endereço oficial de retirada", () => {
  assert.equal(BROWNIER_PICKUP_ADDRESS, "Rua Professor Leite Gondim, 896, Antônio Bezerra, Fortaleza – CE, CEP 60360-332");
});

test("backfill persiste o endereço oficial sem alterar os demais dados comerciais", () => {
  const store = {
    business: { name: "Brownieria Fortal", address: "", phone: "", hours: "", paymentMethods: ["PIX"] },
    products: [],
    orders: [],
  };
  const result = ensureBrownierPickupAddress(store);
  assert.equal(result.business.address, BROWNIER_PICKUP_ADDRESS);
  assert.equal(result.business.phone, "");
  assert.equal(result.business.hours, "");
  assert.deepEqual(result.business.paymentMethods, ["PIX"]);
  assert.equal(store.business.address, "");
});

test("backfill é idempotente quando o endereço já está correto", () => {
  const store = { business: { address: BROWNIER_PICKUP_ADDRESS }, products: [], orders: [] };
  assert.equal(ensureBrownierPickupAddress(store), store);
});

test("backfill cadastra Mateus como responsável comercial", () => {
  const store: { business: Record<string, unknown>; products: unknown[]; orders: unknown[] } = { business: { name: "Brownieria Fortal" }, products: [], orders: [] };
  const result = ensureBrownierResponsible(store);
  assert.equal(BROWNIER_RESPONSIBLE_NAME, "Mateus");
  assert.equal(result.business.responsibleName, "Mateus");
  assert.equal(store.business.responsibleName, undefined);
});

test("backfill cadastra a chave PIX comercial oficial", () => {
  const store: { business: Record<string, unknown>; products: unknown[]; orders: unknown[] } = { business: {}, products: [], orders: [] };
  const result = ensureBrownierPixKey(store);
  assert.equal(BROWNIER_PIX_KEY, "38.011.069/0001-93");
  assert.equal(result.business.pixKey, BROWNIER_PIX_KEY);
  assert.equal(store.business.pixKey, undefined);
});

test("backfill cadastra o WhatsApp oficial", () => {
  const store: { business: Record<string, unknown>; products: unknown[]; orders: unknown[] } = { business: { whatsapp: "" }, products: [], orders: [] };
  const result = ensureBrownierWhatsapp(store);
  assert.equal(result.business.whatsapp, BROWNIER_WHATSAPP);
  assert.equal(ensureBrownierWhatsapp(result), result);
});

test("backfill mantém somente PIX e dinheiro como formas aceitas", () => {
  const store: { business: Record<string, unknown>; products: unknown[]; orders: unknown[] } = { business: { paymentMethods: ["PIX", "DINHEIRO", "A_COMBINAR"] }, products: [], orders: [] };
  const result = ensureBrownierPaymentMethods(store);
  assert.deepEqual(BROWNIER_PAYMENT_METHODS, ["PIX", "DINHEIRO"]);
  assert.deepEqual(result.business.paymentMethods, ["PIX", "DINHEIRO"]);
});

test("backfill mantém entregas desabilitadas conforme a informação comercial oficial", () => {
  const store: { business: Record<string, unknown>; products: unknown[]; orders: unknown[] } = { business: { deliveryEnabled: false }, products: [], orders: [] };
  assert.equal(ensureBrownierDeliveryEnabled(store).business.deliveryEnabled, BROWNIER_DELIVERY_ENABLED);
});

test("backfill de horário: preenche o horário inicial quando não há operatingHours cadastrado", () => {
  const store: { business: Record<string, unknown>; products: unknown[]; orders: unknown[] } = {
    business: { name: "Brownieria Fortal", hours: "" }, products: [], orders: [],
  };
  const result = ensureBrownierOperatingHours(store);
  assert.deepEqual(result.business.operatingHours, INITIAL_OPERATING_HOURS);
  assert.equal(result.business.operatingHoursVersion, BROWNIER_HOURS_VERSION);
  assert.equal(result.business.name, "Brownieria Fortal");
  // Store original não é mutado.
  assert.equal(store.business.operatingHours, undefined);
});

test("backfill de horário é idempotente: nunca sobrescreve um horário já cadastrado pelo painel", () => {
  const customHours = { ...INITIAL_OPERATING_HOURS, SUN: [{ open: "10:00", close: "14:00" }] };
  const store = { business: { operatingHours: customHours, operatingHoursVersion: BROWNIER_HOURS_VERSION }, products: [], orders: [] };
  assert.equal(ensureBrownierOperatingHours(store), store);
  assert.deepEqual(store.business.operatingHours, customHours);
});

test("backfill de horário trata operatingHours malformado como ausente e recadastra o inicial", () => {
  const store = { business: { operatingHours: { MON: "não é uma lista" } }, products: [], orders: [] };
  const result = ensureBrownierOperatingHours(store);
  assert.deepEqual(result.business.operatingHours, INITIAL_OPERATING_HOURS);
});
