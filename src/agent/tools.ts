// Agent Tools — a ÚNICA interface que o futuro agente de IA usará para tocar
// o domínio. Nenhum modelo de IA deve importar store, server.ts, pricing.ts
// ou orders.ts diretamente: tudo passa por aqui. As Tools não implementam
// regra própria — apenas adaptam e reexpõem as funções oficiais já
// existentes, com os campos administrativos removidos.
import {
  createOrder as officialCreateOrder,
  isPickupTimeAllowed as officialIsPickupTimeAllowed,
  type CreateOrderPayload,
  type CreateOrderResult,
  type Order,
  type ProductForOrderCreation,
  type BusinessForOrderCreation,
  type StoreLike,
} from "../lib/orders.ts";
import { isStructuredWeeklyHours } from "../lib/business-hours.ts";
import { calculateLinePrice } from "../lib/pricing.ts";
import { getOperatingStatus, type OperatingStatus } from "./operating-status.ts";

export class AgentToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type AgentDomainProduct = ProductForOrderCreation & {
  slug?: string;
  description?: string;
  category?: string;
  ingredients?: string;
  allergens?: string;
  displayOrder?: number;
};

export type AgentDomainBusiness = BusinessForOrderCreation & {
  name?: string;
  phone?: string;
  whatsapp?: string;
  availabilityNotice?: string;
  paymentMethods?: string[];
  // Campos administrativos (endereço, notas internas, etc.) podem existir no
  // Business real — as Tools simplesmente os ignoram ao montar a resposta.
  [key: string]: unknown;
};

export type AgentDomainStore = {
  business: AgentDomainBusiness;
  products: AgentDomainProduct[];
  orders: Order[];
};

export type AgentPublicProduct = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  basePrice: number;
  promotionalPrice: number | null;
  minimumPromotionalQuantity: number | null;
  ingredients: string;
  allergens: string;
};

export type AgentPublicBusiness = {
  name: string;
  phone: string;
  whatsapp: string;
  pickupEnabled: boolean;
  pickupSlots: string[];
  availabilityNotice: string;
  paymentMethods: string[];
};

// Orçamento público calculado pela mesma regra usada na criação definitiva
// do pedido. O modelo nunca calcula nem recebe autorização para alterar
// valores; ele só pode verbalizar este resultado já apurado pelo servidor.
export type AgentCartQuote = {
  items: Array<{ productId: string; name: string; quantity: number; unitPrice: number; totalPrice: number }>;
  subtotal: number;
  discount: number;
  total: number;
};

export type AgentToolsDependencies = {
  store: AgentDomainStore;
  now?: () => Date;
  generateId?: () => string;
  generatePublicCode?: () => string;
  // Funções oficiais injetáveis — o padrão aponta para a implementação real
  // em orders.ts. Existir como dependência permite provar em teste que as
  // Tools delegam para elas em vez de duplicar a regra.
  createOrderFn?: typeof officialCreateOrder;
  isPickupTimeAllowedFn?: typeof officialIsPickupTimeAllowed;
};

export type AgentTools = {
  listProducts(): AgentPublicProduct[];
  getProduct(productId: string): AgentPublicProduct | null;
  getBusiness(): AgentPublicBusiness;
  // Informação comercial pública, mantida separada do resumo de pedido para
  // não ser enviada ao LLM por padrão.
  getBusinessAddress?(): string;
  getBusinessHours?(): string;
  // Fato determinístico de "está aberto agora" — calculado no servidor a
  // partir do relógio real, nunca pelo modelo. Ver operating-status.ts.
  getOperatingStatus?(): OperatingStatus;
  quoteCart?(items: Array<{ productId: string; quantity: number }>): AgentCartQuote | null;
  getPickupSlots(): string[];
  validatePickupTime(time: string): boolean;
  createOrder(input: { payload: CreateOrderPayload; idempotencyKey?: string }): CreateOrderResult;
  getOrder(publicCode: string): Order | null;
};

function toPublicProduct(product: AgentDomainProduct): AgentPublicProduct {
  return {
    id: product.id,
    slug: product.slug ?? "",
    name: product.name,
    description: product.description ?? "",
    category: product.category ?? "",
    basePrice: product.basePrice,
    promotionalPrice: product.promotionalPrice,
    minimumPromotionalQuantity: product.minimumPromotionalQuantity,
    ingredients: product.ingredients ?? "",
    allergens: product.allergens ?? "",
  };
}

function sortedPickupSlots(business: AgentDomainBusiness): string[] {
  return Array.isArray(business.pickupSlots) ? [...business.pickupSlots].sort() : [];
}

export function createAgentTools(deps: AgentToolsDependencies): AgentTools {
  if (!deps || !deps.store) {
    throw new AgentToolError("missing_store", "AgentToolsDependencies precisa de um store.");
  }
  const { store } = deps;
  const createOrderFn = deps.createOrderFn ?? officialCreateOrder;
  const isPickupTimeAllowedFn = deps.isPickupTimeAllowedFn ?? officialIsPickupTimeAllowed;
  const now = deps.now ?? (() => new Date());

  return {
    listProducts() {
      return [...store.products]
        .filter(p => p.isActive && p.isAvailable)
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map(toPublicProduct);
    },

    getProduct(productId) {
      const product = store.products.find(p => p.id === productId);
      return product ? toPublicProduct(product) : null;
    },

    getBusiness() {
      const business = store.business;
      return {
        name: typeof business.name === "string" ? business.name : "",
        phone: typeof business.phone === "string" ? business.phone : "",
        whatsapp: typeof business.whatsapp === "string" ? business.whatsapp : "",
        pickupEnabled: Boolean(business.pickupEnabled),
        pickupSlots: sortedPickupSlots(business),
        availabilityNotice: typeof business.availabilityNotice === "string" ? business.availabilityNotice : "",
        paymentMethods: Array.isArray(business.paymentMethods) ? [...business.paymentMethods] : [],
      };
    },

    getBusinessAddress() {
      return typeof store.business.address === "string" ? store.business.address.trim() : "";
    },

    getBusinessHours() {
      return typeof store.business.hours === "string" ? store.business.hours.trim() : "";
    },

    getOperatingStatus() {
      const structured = store.business.operatingHours;
      return getOperatingStatus({ now: now(), hours: isStructuredWeeklyHours(structured) ? structured : undefined });
    },

    quoteCart(items) {
      if (!Array.isArray(items) || items.length === 0) return null;
      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      if (!Number.isInteger(totalQuantity) || totalQuantity < 1) return null;

      const quotedItems: AgentCartQuote["items"] = [];
      let subtotal = 0;
      let discount = 0;
      for (const item of items) {
        if (!item || typeof item.productId !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1) return null;
        const product = store.products.find(product => product.id === item.productId && product.isActive && product.isAvailable);
        if (!product) return null;
        const price = calculateLinePrice(product, item.quantity, totalQuantity);
        quotedItems.push({ productId: product.id, name: product.name, quantity: item.quantity, unitPrice: price.unitPrice, totalPrice: price.total });
        subtotal += price.total;
        discount += price.discount;
      }
      return { items: quotedItems, subtotal, discount, total: subtotal };
    },

    getPickupSlots() {
      return sortedPickupSlots(store.business);
    },

    validatePickupTime(time) {
      return isPickupTimeAllowedFn(time, store.business.pickupSlots);
    },

    createOrder(input) {
      return createOrderFn({
        store: store as unknown as StoreLike,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        now: deps.now,
        generateId: deps.generateId,
        generatePublicCode: deps.generatePublicCode,
      });
    },

    getOrder(publicCode) {
      return store.orders.find(o => o.publicCode === publicCode) ?? null;
    },
  };
}
