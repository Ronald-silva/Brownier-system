import assert from "node:assert/strict";
import test from "node:test";
import { productImageSrc } from "../src/lib/media.ts";

test("retorna a imagem enviada quando imageUrl está preenchida", () => {
  assert.equal(productImageSrc({ imageUrl: "data:image/png;base64,AAAA" }), "data:image/png;base64,AAAA");
});

test("retorna a imagem demonstrativa quando imageUrl está ausente", () => {
  assert.equal(productImageSrc({}), "/images/brownie-hero-demo.png");
});

test("retorna a imagem demonstrativa quando imageUrl é string vazia", () => {
  assert.equal(productImageSrc({ imageUrl: "" }), "/images/brownie-hero-demo.png");
});
