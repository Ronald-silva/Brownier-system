import assert from "node:assert/strict";
import test from "node:test";
import { BROWNIER_PICKUP_ADDRESS, ensureBrownierPickupAddress } from "../src/lib/business-defaults.ts";

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
