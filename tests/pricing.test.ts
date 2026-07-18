import assert from "node:assert/strict";
import test from "node:test";
import { calculateLinePrice } from "../src/lib/pricing.ts";

const brownie = { name: "Brownie demonstrativo", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20 };

test("preço promocional é aplicado quando o total do pedido atinge o mínimo, mesmo com poucas unidades desta linha", () => {
  assert.deepEqual(calculateLinePrice(brownie, 5, 20), { unitPrice: 3, total: 15, discount: 10 });
});

test("sem desconto quando o total do pedido não atinge o mínimo, mesmo que a linha isolada seja grande", () => {
  assert.deepEqual(calculateLinePrice(brownie, 19, 19), { unitPrice: 5, total: 95, discount: 0 });
});

test("produto sem promoção mantém preço base independente do total do pedido", () => {
  assert.deepEqual(calculateLinePrice({ name: "Brownie", basePrice: 7, promotionalPrice: null, minimumPromotionalQuantity: null }, 2, 50), { unitPrice: 7, total: 14, discount: 0 });
});
