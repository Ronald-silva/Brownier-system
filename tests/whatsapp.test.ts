import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWhatsappNumber, buildWhatsappLink } from "../src/lib/whatsapp.ts";

test("normaliza número com máscara brasileira, adicionando o código do país", () => {
  assert.equal(normalizeWhatsappNumber("(85) 99123-4567"), "5585991234567");
});

test("mantém o número quando o código do país já está presente com +55", () => {
  assert.equal(normalizeWhatsappNumber("+55 85 99123-4567"), "5585991234567");
});

test("mantém o número quando já vem somente com dígitos e código do país", () => {
  assert.equal(normalizeWhatsappNumber("5585991234567"), "5585991234567");
});

test("adiciona o código do país quando vem somente com dígitos e DDD (sem 55)", () => {
  assert.equal(normalizeWhatsappNumber("85991234567"), "5585991234567");
});

test("retorna string vazia quando o valor é vazio, nulo ou indefinido", () => {
  assert.equal(normalizeWhatsappNumber(""), "");
  assert.equal(normalizeWhatsappNumber(null), "");
  assert.equal(normalizeWhatsappNumber(undefined), "");
});

test("buildWhatsappLink retorna null quando não há número configurado", () => {
  assert.equal(buildWhatsappLink(""), null);
  assert.equal(buildWhatsappLink(null), null);
});

test("buildWhatsappLink gera URL wa.me com apenas dígitos e mensagem codificada", () => {
  const link = buildWhatsappLink("(85) 99123-4567", "Olá!");
  assert.equal(link, "https://wa.me/5585991234567?text=Ol%C3%A1!");
});

test("buildWhatsappLink usa a mensagem padrão quando nenhuma é informada", () => {
  const link = buildWhatsappLink("85991234567");
  assert.ok(link?.startsWith("https://wa.me/5585991234567?text="));
  assert.ok(link?.includes(encodeURIComponent("Brownieria Fortal")));
});
