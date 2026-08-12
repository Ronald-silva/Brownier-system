import assert from "node:assert/strict";
import test from "node:test";
import {
  interpolate,
  formatCurrency,
  formatList,
  formatOptions,
  formatProducts,
  friendlyOrderCreationFailedReason,
  friendlyMissingFieldLabel,
  MESSAGE_CATALOG,
  ALL_MESSAGE_KEYS,
} from "../src/agent/messages.ts";

test("interpolate substitui placeholders conhecidos", () => {
  const result = interpolate("Olá {name}!", { name: "Maria" });
  assert.equal(result, "Olá Maria!");
});

test("interpolate deixa placeholders desconhecidos vazios sem lançar erro", () => {
  const result = interpolate("Olá {name}, código {publicCode}!", { name: "Maria" });
  assert.equal(result, "Olá Maria, código !");
});

test("interpolate não lança erro quando não há placeholders no template", () => {
  assert.doesNotThrow(() => interpolate("Texto fixo", {}));
});

test("formatCurrency formata valor em reais", () => {
  assert.equal(formatCurrency(12), "R$ 12,00");
});

test("formatCurrency não lança erro para valor ausente", () => {
  assert.doesNotThrow(() => formatCurrency(undefined));
});

test("formatList junta itens com marcador", () => {
  assert.equal(formatList(["um", "dois"]), "- um\n- dois");
});

test("formatList devolve string vazia para lista vazia", () => {
  assert.equal(formatList([]), "");
});

test("formatOptions junta opções com marcador de lista", () => {
  assert.equal(formatOptions(["PIX", "DINHEIRO"]), "• PIX\n• DINHEIRO");
});

test("formatOptions devolve string vazia para opções vazias ou ausentes", () => {
  assert.equal(formatOptions([]), "");
  assert.equal(formatOptions(undefined), "");
});

test("formatProducts monta cardápio numerado a partir dos produtos", () => {
  const text = formatProducts([{ name: "Brownie Tradicional", basePrice: 12 }]);
  assert.match(text, /1\.\nBrownie Tradicional\n\nR\$ 12,00/);
});

test("formatProducts devolve string vazia para lista de produtos vazia", () => {
  assert.equal(formatProducts([]), "");
});

test("friendlyOrderCreationFailedReason mapeia código conhecido", () => {
  assert.equal(friendlyOrderCreationFailedReason("invalid_pickup_time"), "Escolha um horário de retirada válido.");
});

test("friendlyOrderCreationFailedReason devolve mensagem genérica para código desconhecido", () => {
  const reason = friendlyOrderCreationFailedReason("codigo_nunca_visto");
  assert.ok(reason.length > 0);
  assert.doesNotMatch(reason, /codigo_nunca_visto/);
});

test("friendlyMissingFieldLabel traduz campo conhecido", () => {
  assert.equal(friendlyMissingFieldLabel("customerName"), "nome");
});

test("friendlyMissingFieldLabel devolve o próprio campo quando desconhecido", () => {
  assert.equal(friendlyMissingFieldLabel("campoNuncaVisto"), "campoNuncaVisto");
});

test("POLICY_LLM_TEMPORARILY_UNAVAILABLE não menciona IA, modelo, provider, timeout ou API", () => {
  const text = MESSAGE_CATALOG.POLICY_LLM_TEMPORARILY_UNAVAILABLE;
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /intelig[êe]ncia artificial|modelo|provider|timeout|api/i);
});

test("catálogo possui um template para todos os messageKeys conhecidos", () => {
  const knownKeys = [
    "WELCOME", "MENU_READY", "CART_READY", "ITEM_ADDED", "ITEMS_ADDED_BATCH", "ITEM_QUANTITY_UPDATED", "ITEM_REMOVED",
    "CART_EMPTY", "INVALID_PRODUCT", "INVALID_QUANTITY", "ASK_CUSTOMER_NAME", "INVALID_CUSTOMER_NAME",
    "CUSTOMER_PHONE_SET", "INVALID_CUSTOMER_PHONE", "ASK_FULFILLMENT", "ASK_PICKUP_TIME", "INVALID_PICKUP_TIME",
    "ASK_NOTES", "INVALID_CUSTOMER_NOTES", "ASK_PAYMENT_METHOD", "PAYMENT_METHOD_ACCEPTED", "PAYMENT_METHOD_INVALID",
    "PAYMENT_METHOD_UNAVAILABLE", "PAYMENT_METHOD_REQUIRED", "ORDER_REVIEW", "INCOMPLETE_ORDER_DATA",
    "ORDER_CREATED", "ORDER_ALREADY_CREATED", "ORDER_CREATION_FAILED", "INVALID_ACTION",
    "CONVERSATION_CANCELLED", "CONVERSATION_RESET", "HUMAN_HANDOFF_STARTED",
  ];
  for (const key of knownKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(MESSAGE_CATALOG, key), `esperava template para ${key}`);
    assert.equal(typeof MESSAGE_CATALOG[key], "string");
  }
  for (const key of knownKeys) {
    assert.ok(ALL_MESSAGE_KEYS.includes(key));
  }
});
