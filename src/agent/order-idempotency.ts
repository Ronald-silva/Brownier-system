// Geração e validação da chave de idempotência usada por CONFIRM_ORDER ao
// criar o pedido real. A chave é decidida pelo domínio do agente — nunca pelo
// modelo de IA — e reaproveitada em toda nova tentativa da mesma intenção de
// confirmação dentro da sessão. A regra de formato espelha a validação
// oficial em src/lib/orders.ts (normalizeIdempotencyKey).
import crypto from "node:crypto";

const ORDER_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const ORDER_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const ORDER_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function isValidOrderIdempotencyKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length >= ORDER_IDEMPOTENCY_KEY_MIN_LENGTH &&
    key.length <= ORDER_IDEMPOTENCY_KEY_MAX_LENGTH &&
    ORDER_IDEMPOTENCY_KEY_PATTERN.test(key)
  );
}

export function generateOrderIdempotencyKey(): string {
  return `agent-order:${crypto.randomUUID()}`;
}
