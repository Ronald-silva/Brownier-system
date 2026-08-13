// Presentation Context Builder — combina AgentConversationResult, AgentSession
// e Agent Tools para produzir o contexto público de apresentação que o
// Renderer consome. É a única camada que consulta Agent Tools para fins de
// apresentação: o Engine não deve carregar dados exclusivamente visuais em
// toda transição, e o Renderer não pode consultar Tools. Não cria pedido,
// não persiste sessão e não calcula preço.
import type { AgentConversationResult } from "./conversation.types.ts";
import type { AgentSession } from "./session.types.ts";
import type { AgentCartQuote, AgentTools, AgentPublicProduct } from "./tools.ts";

export type AgentPresentationProduct = {
  id: string;
  name: string;
  description?: string;
  price?: number;
  promotionalPrice?: number;
};

export type AgentPresentationCartItem = {
  productId: string;
  name: string;
  quantity: number;
  unitPrice?: number;
};

export type AgentPresentationContext = {
  business?: { name?: string; phone?: string; whatsapp?: string; greeting?: string };
  products?: AgentPresentationProduct[];
  currentProduct?: AgentPresentationProduct;
  cartItems?: AgentPresentationCartItem[];
  cartQuote?: AgentCartQuote;
  paymentOptions?: string[];
  pickupSlots?: string[];
  customerName?: string;
  customerPhone?: string;
  fulfillmentType?: string;
  pickupTime?: string;
  customerNotes?: string;
  paymentMethod?: string;
  order?: { publicCode?: string; replayed?: boolean };
  missingFields?: string[];
  reasonCode?: string;
};

export type AgentConversationPresentation = {
  result: AgentConversationResult;
  session: AgentSession;
  context: AgentPresentationContext;
};

export type BuildConversationPresentationInput = {
  result: AgentConversationResult;
  session?: AgentSession;
  tools: AgentTools;
};

function toPresentationProduct(product: AgentPublicProduct): AgentPresentationProduct {
  return {
    id: product.id,
    name: product.name,
    description: product.description || undefined,
    price: product.basePrice,
    promotionalPrice: product.promotionalPrice ?? undefined,
  };
}

// Normalização apenas de apresentação: trim, remove vazios e duplicados,
// preserva a ordem configurada no Business. Nunca inventa opção.
function normalizePaymentOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of options) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function extractProductId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  if (typeof data.productId === "string") return data.productId;
  const item = data.item as { productId?: unknown } | undefined;
  if (item && typeof item.productId === "string") return item.productId;
  return undefined;
}

const PRODUCT_RESOLUTION_KEYS = new Set(["ITEM_ADDED", "ITEM_REMOVED", "ITEM_QUANTITY_UPDATED"]);
const PAYMENT_OPTIONS_KEYS = new Set([
  "ASK_PAYMENT_METHOD",
  "PAYMENT_METHOD_INVALID",
  "PAYMENT_METHOD_UNAVAILABLE",
  "PAYMENT_METHOD_REQUIRED",
]);
const PICKUP_SLOTS_KEYS = new Set(["ASK_PICKUP_TIME", "INVALID_PICKUP_TIME"]);

export function buildConversationPresentation(
  input: BuildConversationPresentationInput,
): AgentConversationPresentation {
  const { tools } = input;
  const result = structuredClone(input.result);
  const session = structuredClone(input.session ?? input.result.session);
  const messageKey = result.messageKey;
  const data = result.data;
  const context: AgentPresentationContext = {};

  // Mensagem duplicada: nenhuma consulta às Tools é necessária.
  if (messageKey === "MESSAGE_ALREADY_PROCESSED") {
    return { result, session, context };
  }

  // Cache local por construção — evita repetir a mesma consulta de Tools
  // quando mais de um trecho do contexto precisa do mesmo dado.
  let productsCache: AgentPublicProduct[] | undefined;
  const getProducts = (): AgentPublicProduct[] => {
    if (!productsCache) productsCache = structuredClone(tools.listProducts());
    return productsCache;
  };
  let businessCache: ReturnType<AgentTools["getBusiness"]> | undefined;
  const getBusiness = () => {
    if (!businessCache) businessCache = structuredClone(tools.getBusiness());
    return businessCache;
  };
  let pickupSlotsCache: string[] | undefined;
  const getPickupSlots = (): string[] => {
    if (!pickupSlotsCache) pickupSlotsCache = structuredClone(tools.getPickupSlots());
    return pickupSlotsCache;
  };

  if (messageKey === "WELCOME" || messageKey === "HUMAN_HANDOFF_STARTED") {
    const business = getBusiness();
    context.business = {
      name: business.name || undefined,
      phone: business.phone || undefined,
      whatsapp: business.whatsapp || undefined,
      greeting: typeof data?.greeting === "string" ? data.greeting : undefined,
    };
  }

  if (messageKey === "MENU_READY") {
    context.products = getProducts().map(toPresentationProduct);
  }

  if (PRODUCT_RESOLUTION_KEYS.has(messageKey)) {
    const productId = extractProductId(data);
    if (productId) {
      const product = tools.getProduct(productId);
      if (product) context.currentProduct = toPresentationProduct(structuredClone(product));
    }
  }

  // Mostra o valor atualizado logo após cada alteração do carrinho e na
  // revisão. A cotação vem da Tool, que reutiliza a regra oficial de preços
  // (inclusive promoções por quantidade), nunca de conta feita no Renderer.
  if (messageKey === "ITEM_ADDED" || messageKey === "ITEMS_ADDED_BATCH" || messageKey === "ITEM_QUANTITY_UPDATED" || messageKey === "ITEM_REMOVED" || messageKey === "CART_READY" || messageKey === "ORDER_REVIEW") {
    const quote = tools.quoteCart?.(session.items);
    if (quote) context.cartQuote = structuredClone(quote);
  }

  // Lote de múltiplos ADD_ITEM: o Text Conversation Service monta um
  // messageKey sintético com todos os produtos/quantidades finais do lote em
  // `data.items` — nunca inventado aqui, só resolvido pelo productId real.
  if (messageKey === "ITEMS_ADDED_BATCH") {
    const productMap = new Map(getProducts().map(product => [product.id, product]));
    const rawItems = Array.isArray(data?.items) ? (data.items as unknown[]) : [];
    context.cartItems = rawItems
      .filter((item): item is { productId: string; quantity: number } => {
        const candidate = item as { productId?: unknown; quantity?: unknown } | null;
        return !!candidate && typeof candidate.productId === "string" && typeof candidate.quantity === "number";
      })
      .map(item => {
        const product = productMap.get(item.productId);
        return {
          productId: item.productId,
          name: product?.name ?? "Produto indisponível",
          quantity: item.quantity,
          unitPrice: product?.basePrice,
        };
      });
  }

  if (PAYMENT_OPTIONS_KEYS.has(messageKey) || messageKey === "ORDER_REVIEW") {
    context.paymentOptions = normalizePaymentOptions(getBusiness().paymentMethods);
  }

  if (PICKUP_SLOTS_KEYS.has(messageKey) || messageKey === "ORDER_REVIEW") {
    context.pickupSlots = getPickupSlots();
  }

  if (messageKey === "ORDER_REVIEW") {
    const productMap = new Map(getProducts().map(product => [product.id, product]));
    context.cartItems = session.items.map(item => {
      const product = productMap.get(item.productId);
      return {
        productId: item.productId,
        name: product?.name ?? "Produto indisponível",
        quantity: item.quantity,
        unitPrice: product?.basePrice,
      };
    });
    context.customerName = session.customerName;
    context.customerPhone = session.customerPhone;
    context.fulfillmentType = session.fulfillmentType;
    context.pickupTime = session.pickupTime;
    context.customerNotes = session.customerNotes;
    context.paymentMethod = session.paymentMethod;
  }

  if (messageKey === "ORDER_CREATED" || messageKey === "ORDER_ALREADY_CREATED") {
    context.order = {
      publicCode: typeof data?.publicCode === "string" ? data.publicCode : undefined,
      replayed: typeof data?.replayed === "boolean" ? data.replayed : undefined,
    };
  }

  if (messageKey === "ORDER_CREATION_FAILED") {
    context.reasonCode = typeof data?.code === "string" ? data.code : undefined;
  }

  if (messageKey === "INCOMPLETE_ORDER_DATA") {
    context.missingFields = Array.isArray(data?.missingFields)
      ? data.missingFields.filter((field): field is string => typeof field === "string")
      : undefined;
  }

  return { result, session, context };
}
