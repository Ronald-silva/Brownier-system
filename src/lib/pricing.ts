export type PricingProduct = { name: string; basePrice: number; promotionalPrice: number | null; minimumPromotionalQuantity: number | null };

export function calculateLinePrice(product: PricingProduct, quantity: number, totalQuantity: number) {
  const promotional = product.promotionalPrice !== null && product.minimumPromotionalQuantity !== null && totalQuantity >= product.minimumPromotionalQuantity;
  const unitPrice = promotional ? product.promotionalPrice! : product.basePrice;
  return { unitPrice, total: unitPrice * quantity, discount: promotional ? (product.basePrice - unitPrice) * quantity : 0 };
}
