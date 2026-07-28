import crypto from "node:crypto";
import { calculateLinePrice, type PricingProduct } from "./pricing.ts";
import { sanitizeOptionalText } from "./sanitize.ts";

export type OrderItemInput = { productId?: unknown; quantity?: unknown };

export type CreateOrderPayload = {
  items?: unknown;
  customerName?: unknown;
  customerPhone?: unknown;
  fulfillmentType?: unknown;
  deliveryAddress?: unknown;
  reference?: unknown;
  customerNotes?: unknown;
  paymentMethod?: unknown;
  changeFor?: unknown;
  pickupTime?: unknown;
};

export type ProductForOrderCreation = PricingProduct & {
  id: string;
  isActive: boolean;
  isAvailable: boolean;
};

export type BusinessForOrderCreation = {
  pickupEnabled?: boolean;
  deliveryEnabled?: boolean;
  deliveryFee?: number;
  pickupSlots?: unknown;
};

export type OrderLine = {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  totalPrice: number;
};

export type Order = {
  id: string;
  publicCode: string;
  status: string;
  fulfillmentType: string;
  paymentMethod: string;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  total: number;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  reference: string;
  customerNotes: string;
  internalNotes: string;
  changeFor: string;
  pickupTime: string;
  items: OrderLine[];
  createdAt: string;
  updatedAt: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
};

export type StoreLike = {
  business: Record<string, unknown>;
  products: ProductForOrderCreation[];
  orders: Order[];
};

export class OrderCreationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function defaultPublicCode(): string {
  return `BF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

// Regra oficial de horário de retirada: sem horários configurados, qualquer
// valor é aceito; com horários configurados, o valor precisa estar na lista.
// Extraída para ser reutilizada fora da criação de pedido (ex.: Agent Tools)
// sem duplicar a regra.
export function isPickupTimeAllowed(pickupTime: unknown, pickupSlots: unknown): boolean {
  const slots = Array.isArray(pickupSlots) ? pickupSlots : [];
  return slots.length === 0 || slots.includes(pickupTime);
}

const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

function normalizeIdempotencyKey(rawKey: string | undefined): string | undefined {
  if (rawKey === undefined) return undefined;
  if (
    typeof rawKey !== "string" ||
    rawKey.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    rawKey.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(rawKey)
  ) {
    throw new OrderCreationError(400, "invalid_idempotency_key", "Chave de idempotência inválida.");
  }
  return rawKey;
}

// Representação canônica do conteúdo lógico do pedido — só os campos que a
// própria requisição controla, com as mesmas normalizações aplicadas na
// criação (trim, sanitizeOptionalText). A ordem das chaves no payload
// recebido não importa: construímos o objeto com chaves fixas aqui, então
// JSON.stringify sempre produz a mesma string para o mesmo conteúdo lógico.
// Preço, subtotal, total, id e timestamps ficam de fora de propósito.
function canonicalizeOrderRequest(payload: CreateOrderPayload) {
  const items = Array.isArray(payload?.items)
    ? (payload.items as OrderItemInput[]).map(item => ({
        productId: typeof item?.productId === "string" ? item.productId : String(item?.productId ?? ""),
        quantity: Number(item?.quantity),
      }))
    : [];
  return {
    items,
    customerName: typeof payload?.customerName === "string" ? payload.customerName.trim() : "",
    customerPhone: typeof payload?.customerPhone === "string" ? payload.customerPhone.trim() : "",
    fulfillmentType: typeof payload?.fulfillmentType === "string" ? payload.fulfillmentType : "",
    paymentMethod: typeof payload?.paymentMethod === "string" ? payload.paymentMethod : "",
    deliveryAddress: sanitizeOptionalText(payload?.deliveryAddress),
    reference: sanitizeOptionalText(payload?.reference),
    customerNotes: sanitizeOptionalText(payload?.customerNotes),
    changeFor: sanitizeOptionalText(payload?.changeFor),
    pickupTime: sanitizeOptionalText(payload?.pickupTime),
  };
}

function computeIdempotencyFingerprint(payload: CreateOrderPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeOrderRequest(payload))).digest("hex");
}

export type CreateOrderInput = {
  store: StoreLike;
  payload: CreateOrderPayload;
  idempotencyKey?: string;
  now?: () => Date;
  generateId?: () => string;
  generatePublicCode?: () => string;
};

export type CreateOrderResult = {
  order: Order;
  replayed: boolean;
};

export function createOrder({
  store,
  payload,
  idempotencyKey,
  now = () => new Date(),
  generateId = () => crypto.randomUUID(),
  generatePublicCode = defaultPublicCode,
}: CreateOrderInput): CreateOrderResult {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);

  if (normalizedKey) {
    const existing = store.orders.find(o => o.idempotencyKey === normalizedKey);
    if (existing) {
      if (existing.idempotencyFingerprint !== computeIdempotencyFingerprint(payload)) {
        throw new OrderCreationError(409, "IDEMPOTENCY_KEY_REUSED", "Esta chave de operação já foi utilizada com dados diferentes.");
      }
      return { order: existing, replayed: true };
    }
  }

  const { items, customerName, customerPhone, fulfillmentType, deliveryAddress, reference, customerNotes, paymentMethod, changeFor, pickupTime } = payload ?? {};

  if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
    throw new OrderCreationError(400, "invalid_items", "O pedido precisa ter pelo menos um item.");
  }
  if (!validText(customerName, 100) || !validText(customerPhone, 30)) {
    throw new OrderCreationError(400, "invalid_customer", "Informe nome e telefone.");
  }
  if (!["RETIRADA", "ENTREGA"].includes(fulfillmentType as string) || !["PIX", "DINHEIRO", "A_COMBINAR"].includes(paymentMethod as string)) {
    throw new OrderCreationError(400, "invalid_fulfillment_or_payment", "Recebimento ou pagamento inválido.");
  }

  const business = store.business as BusinessForOrderCreation;
  if (fulfillmentType === "ENTREGA" && (!business.deliveryEnabled || !validText(deliveryAddress, 300))) {
    throw new OrderCreationError(400, "invalid_delivery_address", "Informe o endereço de entrega.");
  }
  if (fulfillmentType === "RETIRADA" && !business.pickupEnabled) {
    throw new OrderCreationError(400, "pickup_disabled", "Retirada indisponível no momento.");
  }
  if (fulfillmentType === "RETIRADA" && !isPickupTimeAllowed(pickupTime, business.pickupSlots)) {
    throw new OrderCreationError(400, "invalid_pickup_time", "Escolha um horário para retirar seu pedido.");
  }

  const orderItems: OrderLine[] = [];
  let subtotal = 0;
  let discount = 0;
  const totalQuantity = (items as OrderItemInput[]).reduce((sum: number, item) => sum + Number(item?.quantity || 0), 0);
  for (const item of items as OrderItemInput[]) {
    const quantity = Number(item?.quantity);
    const product = store.products.find(p => p.id === item?.productId && p.isActive && p.isAvailable);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new OrderCreationError(400, "invalid_item", "Há um produto indisponível ou uma quantidade inválida.");
    }
    const price = calculateLinePrice(product, quantity, totalQuantity);
    subtotal += price.total;
    discount += price.discount;
    orderItems.push({ productId: product.id, productName: product.name, unitPrice: price.unitPrice, quantity, totalPrice: price.total });
  }

  const deliveryFee = fulfillmentType === "ENTREGA" ? Number(business.deliveryFee || 0) : 0;
  const timestamp = now().toISOString();
  const order: Order = {
    id: generateId(),
    publicCode: generatePublicCode(),
    status: "NOVO",
    fulfillmentType: fulfillmentType as string,
    paymentMethod: paymentMethod as string,
    subtotal,
    discount,
    deliveryFee,
    total: subtotal + deliveryFee,
    customerName: (customerName as string).trim(),
    customerPhone: (customerPhone as string).trim(),
    deliveryAddress: sanitizeOptionalText(deliveryAddress),
    reference: sanitizeOptionalText(reference),
    customerNotes: sanitizeOptionalText(customerNotes),
    internalNotes: "",
    changeFor: sanitizeOptionalText(changeFor),
    pickupTime: sanitizeOptionalText(pickupTime),
    items: orderItems,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(normalizedKey ? { idempotencyKey: normalizedKey, idempotencyFingerprint: computeIdempotencyFingerprint(payload) } : {}),
  };

  store.orders.unshift(order);
  return { order, replayed: false };
}
