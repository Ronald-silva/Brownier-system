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
