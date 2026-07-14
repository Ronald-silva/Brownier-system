export function productImageSrc(product: { imageUrl?: string }): string {
  return product.imageUrl || "/images/brownie-hero-demo.png";
}
