import assert from "node:assert/strict";
import test from "node:test";
import { calculateLinePrice } from "../src/lib/pricing.ts";

const brownie = { name: "Brownie demonstrativo", basePrice: 500, promotionalPrice: 300, minimumPromotionalQuantity: 20 };

test("preço promocional só é aplicado na quantidade mínima", () => {
  assert.deepEqual(calculateLinePrice(brownie, 19), { unitPrice: 500, total: 9500, discount: 0 });
  assert.deepEqual(calculateLinePrice(brownie, 20), { unitPrice: 300, total: 6000, discount: 4000 });
});

test("produto sem promoção mantém preço base", () => {
  assert.deepEqual(calculateLinePrice({ name: "Brownie", basePrice: 700, promotionalPrice: null, minimumPromotionalQuantity: null }, 2), { unitPrice: 700, total: 1400, discount: 0 });
});
