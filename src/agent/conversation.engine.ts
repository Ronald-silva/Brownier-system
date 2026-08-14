// Conversation Engine — motor determinístico de estados do atendimento.
// Recebe ações estruturadas (nunca texto livre), consulta as Agent Tools já
// existentes e devolve uma nova sessão + resultado estruturado. Não conhece
// HTTP, IA, WhatsApp, store de persistência nem cria pedidos.
import type { AgentConversationStep, AgentSession } from "./session.types.ts";
import type { AgentTools } from "./tools.ts";
import { AgentConversationError } from "./conversation.types.ts";
import type {
  AgentConversationAction,
  AgentConversationResult,
  HandleConversationActionInput,
} from "./conversation.types.ts";
import { OrderCreationError } from "../lib/orders.ts";
import {
  generateOrderIdempotencyKey as defaultGenerateOrderIdempotencyKey,
  isValidOrderIdempotencyKey,
} from "./order-idempotency.ts";

const MAX_CUSTOMER_NAME_LENGTH = 100;
const MAX_CUSTOMER_PHONE_LENGTH = 30;
const MAX_CUSTOMER_NOTES_LENGTH = 500;
const MAX_ITEM_QUANTITY = 100;

type StepResult = {
  patch: Partial<AgentSession>;
  event: string;
  messageKey: string;
  data?: Record<string, unknown>;
};

function noChange(event: string, messageKey: string, data?: Record<string, unknown>): StepResult {
  return { patch: {}, event, messageKey, data };
}

function invalidAction(session: AgentSession, action: AgentConversationAction): StepResult {
  return noChange("INVALID_ACTION", "INVALID_ACTION", { currentStep: session.step, actionType: action.type });
}

// Chave de leitura para o passo em que a sessão fica logo após uma transição
// bem-sucedida — usada tanto pelos fluxos normais quanto por GO_BACK, para
// que "voltar" para um passo produza a mesma messageKey de quem chega nele
// pela primeira vez.
function messageKeyForStep(step: AgentConversationStep): string {
  switch (step) {
    case "START":
      return "WELCOME";
    case "BROWSING_MENU":
      return "MENU_READY";
    case "BUILDING_ORDER":
      return "CART_READY";
    case "COLLECTING_NAME":
      return "ASK_CUSTOMER_NAME";
    case "COLLECTING_FULFILLMENT":
      return "ASK_FULFILLMENT";
    case "COLLECTING_PICKUP_TIME":
      return "ASK_PICKUP_TIME";
    case "COLLECTING_NOTES":
      return "ASK_NOTES";
    case "COLLECTING_PAYMENT":
      return "ASK_PAYMENT_METHOD";
    case "AWAITING_CONFIRMATION":
      return "ORDER_REVIEW";
    case "ORDER_CREATED":
      return "ORDER_CREATED";
    case "HUMAN_HANDOFF":
      return "HUMAN_HANDOFF_STARTED";
  }
}

function isValidText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function isProductAvailable(tools: AgentTools, productId: string): boolean {
  return tools.listProducts().some(p => p.id === productId);
}

const CLEAR_ORDER_DATA_PATCH: Partial<AgentSession> = {
  items: [],
  customerName: undefined,
  customerPhone: undefined,
  fulfillmentType: undefined,
  pickupTime: undefined,
  customerNotes: undefined,
  paymentMethod: undefined,
  createdOrderId: undefined,
  createdOrderPublicCode: undefined,
  orderIdempotencyKey: undefined,
};

// --- handlers por ação -------------------------------------------------

function handleStartConversation(session: AgentSession, tools: AgentTools, action: Extract<AgentConversationAction, { type: "START_CONVERSATION" }>): StepResult {
  if (session.step !== "START") return invalidAction(session, { type: "START_CONVERSATION" });
  const business = tools.getBusiness();
  const products = tools.listProducts();
  return {
    patch: { step: "BROWSING_MENU" },
    event: "WELCOME",
    messageKey: "WELCOME",
    data: { business, products, ...(action.greeting ? { greeting: action.greeting } : {}) },
  };
}

function handleAddItem(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "ADD_ITEM" }>,
  tools: AgentTools,
): StepResult {
  const allowed: AgentConversationStep[] = ["BROWSING_MENU", "BUILDING_ORDER"];
  if (!allowed.includes(session.step)) return invalidAction(session, action);

  const { productId, quantity } = action;
  if (typeof productId !== "string" || productId.trim().length === 0) {
    return noChange("INVALID_PRODUCT", "INVALID_PRODUCT", { productId });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
    return noChange("INVALID_QUANTITY", "INVALID_QUANTITY", { quantity });
  }
  const product = tools.getProduct(productId);
  if (!product || !isProductAvailable(tools, productId)) {
    return noChange("INVALID_PRODUCT", "INVALID_PRODUCT", { productId });
  }

  const existing = session.items.find(i => i.productId === productId);
  const newQuantity = (existing?.quantity ?? 0) + quantity;
  if (newQuantity > MAX_ITEM_QUANTITY) {
    return noChange("INVALID_QUANTITY", "INVALID_QUANTITY", { productId, quantity: newQuantity });
  }

  const items = existing
    ? session.items.map(i => (i.productId === productId ? { ...i, quantity: newQuantity } : i))
    : [...session.items, { productId, quantity }];

  return {
    patch: { items, step: "BUILDING_ORDER" },
    event: "ITEM_ADDED",
    messageKey: "ITEM_ADDED",
    data: { productId, quantity: newQuantity },
  };
}

function handleUpdateItemQuantity(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "UPDATE_ITEM_QUANTITY" }>,
): StepResult {
  if (session.step !== "BUILDING_ORDER") return invalidAction(session, action);
  const { productId, quantity } = action;

  const existing = session.items.find(i => i.productId === productId);
  if (!existing) {
    return noChange("INVALID_PRODUCT", "INVALID_PRODUCT", { productId });
  }
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_ITEM_QUANTITY) {
    return noChange("INVALID_QUANTITY", "INVALID_QUANTITY", { productId, quantity });
  }

  if (quantity === 0) {
    const items = session.items.filter(i => i.productId !== productId);
    return { patch: { items }, event: "ITEM_REMOVED", messageKey: "ITEM_REMOVED", data: { productId } };
  }

  const items = session.items.map(i => (i.productId === productId ? { ...i, quantity } : i));
  return {
    patch: { items },
    event: "ITEM_QUANTITY_UPDATED",
    messageKey: "ITEM_QUANTITY_UPDATED",
    data: { productId, quantity },
  };
}

function handleRemoveItem(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "REMOVE_ITEM" }>,
): StepResult {
  if (session.step !== "BUILDING_ORDER") return invalidAction(session, action);
  const { productId } = action;
  const existed = session.items.some(i => i.productId === productId);
  const items = session.items.filter(i => i.productId !== productId);
  return {
    patch: { items },
    event: "ITEM_REMOVED",
    messageKey: "ITEM_REMOVED",
    data: { productId, removed: existed },
  };
}

function handleClearCart(session: AgentSession, action: AgentConversationAction): StepResult {
  const allowed: AgentConversationStep[] = [
    "BROWSING_MENU",
    "BUILDING_ORDER",
    "COLLECTING_NAME",
    "COLLECTING_FULFILLMENT",
    "COLLECTING_PICKUP_TIME",
    "COLLECTING_NOTES",
    "COLLECTING_PAYMENT",
    "AWAITING_CONFIRMATION",
  ];
  if (!allowed.includes(session.step)) return invalidAction(session, action);
  return {
    patch: { ...CLEAR_ORDER_DATA_PATCH, step: "BROWSING_MENU" },
    event: "CART_CLEARED",
    messageKey: "MENU_READY",
  };
}

function handleFinishCart(session: AgentSession, action: AgentConversationAction, tools: AgentTools): StepResult {
  if (session.step !== "BUILDING_ORDER") return invalidAction(session, action);
  if (session.items.length === 0) {
    return noChange("CART_EMPTY", "CART_EMPTY");
  }
  for (const item of session.items) {
    const product = tools.getProduct(item.productId);
    if (!product || !isProductAvailable(tools, item.productId)) {
      return noChange("INVALID_PRODUCT", "INVALID_PRODUCT", { productId: item.productId });
    }
  }
  return { patch: { step: "COLLECTING_NAME" }, event: "ASK_CUSTOMER_NAME", messageKey: "ASK_CUSTOMER_NAME" };
}

function handleSetCustomerName(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "SET_CUSTOMER_NAME" }>,
): StepResult {
  if (session.step !== "COLLECTING_NAME") return invalidAction(session, action);
  if (!isValidText(action.customerName, MAX_CUSTOMER_NAME_LENGTH)) {
    return noChange("INVALID_CUSTOMER_NAME", "INVALID_CUSTOMER_NAME");
  }
  return {
    patch: { customerName: action.customerName.trim(), step: "COLLECTING_FULFILLMENT" },
    event: "ASK_FULFILLMENT",
    messageKey: "ASK_FULFILLMENT",
  };
}

function handleSetCustomerPhone(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "SET_CUSTOMER_PHONE" }>,
): StepResult {
  const allowed: AgentConversationStep[] = [
    "COLLECTING_NAME",
    "COLLECTING_FULFILLMENT",
    "COLLECTING_PICKUP_TIME",
    "COLLECTING_NOTES",
  ];
  if (!allowed.includes(session.step)) return invalidAction(session, action);
  if (!isValidText(action.customerPhone, MAX_CUSTOMER_PHONE_LENGTH)) {
    return noChange("INVALID_CUSTOMER_PHONE", "INVALID_CUSTOMER_PHONE");
  }
  const customerPhone = action.customerPhone.trim();
  return {
    patch: { customerPhone },
    event: "CUSTOMER_PHONE_SET",
    messageKey: "CUSTOMER_PHONE_SET",
    data: { customerPhone },
  };
}

function handleSetFulfillment(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "SET_FULFILLMENT" }>,
  tools: AgentTools,
): StepResult {
  if (session.step !== "COLLECTING_FULFILLMENT") return invalidAction(session, action);
  if (action.fulfillmentType !== "RETIRADA") {
    return noChange("INVALID_ACTION", "INVALID_ACTION", {
      currentStep: session.step,
      actionType: action.type,
      fulfillmentType: action.fulfillmentType,
    });
  }
  const hasSlots = tools.getPickupSlots().length > 0;
  const nextStep = hasSlots ? "COLLECTING_PICKUP_TIME" : "COLLECTING_NOTES";
  const messageKey = hasSlots ? "ASK_PICKUP_TIME" : "ASK_NOTES";
  return {
    patch: { fulfillmentType: "RETIRADA", step: nextStep },
    event: messageKey,
    messageKey,
  };
}

function handleSetPickupTime(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "SET_PICKUP_TIME" }>,
  tools: AgentTools,
): StepResult {
  if (session.step !== "COLLECTING_PICKUP_TIME") return invalidAction(session, action);
  if (!tools.validatePickupTime(action.pickupTime)) {
    return noChange("INVALID_PICKUP_TIME", "INVALID_PICKUP_TIME");
  }
  return {
    patch: { pickupTime: action.pickupTime, step: "COLLECTING_NOTES" },
    event: "ASK_NOTES",
    messageKey: "ASK_NOTES",
  };
}

function handleSetCustomerNotes(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "SET_CUSTOMER_NOTES" }>,
): StepResult {
  if (session.step !== "COLLECTING_NOTES") return invalidAction(session, action);
  const trimmed = typeof action.customerNotes === "string" ? action.customerNotes.trim() : "";
  if (trimmed.length > MAX_CUSTOMER_NOTES_LENGTH) {
    return noChange("INVALID_CUSTOMER_NOTES", "INVALID_CUSTOMER_NOTES");
  }
  return {
    patch: { customerNotes: trimmed || undefined, step: "COLLECTING_PAYMENT" },
    event: "ASK_PAYMENT_METHOD",
    messageKey: "ASK_PAYMENT_METHOD",
  };
}

function handleSkipCustomerNotes(session: AgentSession, action: AgentConversationAction): StepResult {
  if (session.step !== "COLLECTING_NOTES") return invalidAction(session, action);
  return {
    patch: { customerNotes: undefined, step: "COLLECTING_PAYMENT" },
    event: "ASK_PAYMENT_METHOD",
    messageKey: "ASK_PAYMENT_METHOD",
  };
}

function handleSetPaymentMethod(
  session: AgentSession,
  action: Extract<AgentConversationAction, { type: "SET_PAYMENT_METHOD" }>,
  tools: AgentTools,
): StepResult {
  if (session.step !== "COLLECTING_PAYMENT") return invalidAction(session, action);

  const options = tools.getBusiness().paymentMethods;
  if (!Array.isArray(options) || options.length === 0) {
    return noChange("PAYMENT_METHOD_UNAVAILABLE", "PAYMENT_METHOD_UNAVAILABLE", { options: [] });
  }

  const normalized = typeof action.paymentMethod === "string" ? action.paymentMethod.trim().toUpperCase() : "";
  if (!normalized || !options.includes(normalized)) {
    return noChange("PAYMENT_METHOD_INVALID", "PAYMENT_METHOD_INVALID", { options });
  }

  return {
    patch: { paymentMethod: normalized, step: "AWAITING_CONFIRMATION" },
    event: "PAYMENT_METHOD_ACCEPTED",
    messageKey: "PAYMENT_METHOD_ACCEPTED",
    data: { paymentMethod: normalized },
  };
}

function handleReviewOrder(session: AgentSession, action: AgentConversationAction, tools: AgentTools): StepResult {
  const allowed: AgentConversationStep[] = ["COLLECTING_NOTES", "COLLECTING_PAYMENT", "AWAITING_CONFIRMATION"];
  if (!allowed.includes(session.step)) return invalidAction(session, action);

  const items = session.items.map(item => ({
    productId: item.productId,
    quantity: item.quantity,
    product: tools.getProduct(item.productId),
  }));

  // REVIEW_ORDER é apenas uma prévia: nunca avança a etapa por conta própria,
  // para não pular a coleta de pagamento (ou de notas) ainda pendente.
  return {
    patch: {},
    event: "ORDER_REVIEW",
    messageKey: "ORDER_REVIEW",
    data: {
      items,
      customerName: session.customerName,
      customerPhone: session.customerPhone,
      fulfillmentType: session.fulfillmentType,
      pickupTime: session.pickupTime,
      customerNotes: session.customerNotes,
      paymentMethod: session.paymentMethod,
      paymentPending: !session.paymentMethod,
      limitations: ["no_price_preview"],
    },
  };
}

function handleConfirmOrder(
  session: AgentSession,
  action: AgentConversationAction,
  tools: AgentTools,
  generateOrderIdempotencyKey: () => string,
): StepResult {
  if (session.step !== "AWAITING_CONFIRMATION") return invalidAction(session, action);

  // A sessão já tem um pedido real associado (ex.: sessão atualizada não foi
  // persistida a tempo de uma nova tentativa de CONFIRM_ORDER chegar) — não
  // cria um segundo pedido, apenas corrige a etapa e devolve as referências
  // já existentes.
  if (session.createdOrderId || session.createdOrderPublicCode) {
    return {
      patch: { step: "ORDER_CREATED" },
      event: "ORDER_ALREADY_CREATED",
      messageKey: "ORDER_ALREADY_CREATED",
      data: { orderId: session.createdOrderId, publicCode: session.createdOrderPublicCode },
    };
  }

  const missingFields: string[] = [];
  if (session.items.length === 0) missingFields.push("items");
  if (!session.customerName) missingFields.push("customerName");
  if (!session.customerPhone) missingFields.push("customerPhone");
  if (session.fulfillmentType !== "RETIRADA") missingFields.push("fulfillmentType");
  if (tools.getPickupSlots().length > 0 && !session.pickupTime) missingFields.push("pickupTime");

  if (missingFields.length > 0) {
    return noChange("INCOMPLETE_ORDER_DATA", "INCOMPLETE_ORDER_DATA", { missingFields });
  }

  // Bloqueia a confirmação fora do horário de funcionamento — só quando
  // operatingHours está cadastrado (known: true). Sem cadastro (known: false)
  // ou sem a Tool disponível (getOperatingStatus é opcional em AgentTools,
  // mesmo padrão de allowed-facts.ts e text-conversation.service.ts), o
  // comportamento é fail-open, coerente com response-text-validator.ts:
  // "não sei se está fechado" é tratado igual a "sabemos que está aberto".
  const operatingStatus = tools.getOperatingStatus?.();
  if (operatingStatus?.known && !operatingStatus.isOpenNow) {
    return noChange("STORE_CLOSED", "STORE_CLOSED", { nextOpen: operatingStatus.nextOpen });
  }

  // Revalida carrinho e produtos contra o catálogo atual — o mesmo critério
  // já usado em FINISH_CART — para não confirmar um item que ficou
  // indisponível ou com quantidade inválida enquanto a sessão aguardava.
  for (const item of session.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) {
      return noChange("INVALID_QUANTITY", "INVALID_QUANTITY", { productId: item.productId, quantity: item.quantity });
    }
    if (!tools.getProduct(item.productId) || !isProductAvailable(tools, item.productId)) {
      return noChange("INVALID_PRODUCT", "INVALID_PRODUCT", { productId: item.productId });
    }
  }

  if (tools.getPickupSlots().length > 0 && !tools.validatePickupTime(session.pickupTime as string)) {
    return noChange("INVALID_PICKUP_TIME", "INVALID_PICKUP_TIME");
  }

  if (!session.paymentMethod) {
    return noChange("PAYMENT_METHOD_REQUIRED", "PAYMENT_METHOD_REQUIRED");
  }

  // Revalida a opção salva contra o Business atual — evita confirmar uma
  // forma de pagamento que o administrador removeu durante a conversa.
  const options = tools.getBusiness().paymentMethods;
  if (!Array.isArray(options) || !options.includes(session.paymentMethod)) {
    return {
      patch: { paymentMethod: undefined, step: "COLLECTING_PAYMENT" },
      event: "PAYMENT_METHOD_UNAVAILABLE",
      messageKey: "PAYMENT_METHOD_UNAVAILABLE",
      data: { options: Array.isArray(options) ? options : [] },
    };
  }

  // A chave é gerada uma única vez por intenção de confirmação e salva na
  // sessão para ser reutilizada em qualquer nova tentativa (retry, réplica
  // da mensagem, etc.) em vez de gerar uma chave nova a cada chamada.
  let idempotencyKey = session.orderIdempotencyKey;
  if (!idempotencyKey) {
    const generated = generateOrderIdempotencyKey();
    if (!isValidOrderIdempotencyKey(generated)) {
      throw new AgentConversationError(
        "invalid_generated_idempotency_key",
        "generateOrderIdempotencyKey devolveu uma chave fora do formato permitido.",
      );
    }
    idempotencyKey = generated;
  }

  const payload = {
    items: session.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
    customerName: session.customerName,
    customerPhone: session.customerPhone,
    fulfillmentType: session.fulfillmentType,
    pickupTime: session.pickupTime,
    customerNotes: session.customerNotes,
    paymentMethod: session.paymentMethod,
  };

  let created;
  try {
    created = tools.createOrder({ payload, idempotencyKey });
  } catch (err) {
    if (err instanceof OrderCreationError) {
      // Erro esperado do serviço oficial (produto indisponível, chave de
      // idempotência reaproveitada com dados diferentes, etc.) — resultado
      // estruturado, sessão permanece em AWAITING_CONFIRMATION e a chave é
      // preservada para uma nova tentativa (nunca gerar outra automaticamente).
      return {
        patch: { orderIdempotencyKey: idempotencyKey },
        event: "ORDER_CREATION_FAILED",
        messageKey: "ORDER_CREATION_FAILED",
        data: { code: err.code },
      };
    }
    throw new AgentConversationError("order_creation_failed", "Falha inesperada ao criar o pedido.", { cause: err });
  }

  return {
    patch: {
      step: "ORDER_CREATED",
      createdOrderId: created.order.id,
      createdOrderPublicCode: created.order.publicCode,
      orderIdempotencyKey: idempotencyKey,
    },
    event: "ORDER_CREATED",
    messageKey: "ORDER_CREATED",
    data: {
      orderId: created.order.id,
      publicCode: created.order.publicCode,
      replayed: created.replayed,
    },
  };
}

const GO_BACK_MAP: Partial<Record<AgentConversationStep, (tools: AgentTools) => AgentConversationStep>> = {
  BROWSING_MENU: () => "START",
  BUILDING_ORDER: () => "BROWSING_MENU",
  COLLECTING_NAME: () => "BUILDING_ORDER",
  COLLECTING_FULFILLMENT: () => "COLLECTING_NAME",
  COLLECTING_PICKUP_TIME: () => "COLLECTING_FULFILLMENT",
  COLLECTING_NOTES: tools => (tools.getPickupSlots().length > 0 ? "COLLECTING_PICKUP_TIME" : "COLLECTING_FULFILLMENT"),
  COLLECTING_PAYMENT: () => "COLLECTING_NOTES",
  AWAITING_CONFIRMATION: () => "COLLECTING_PAYMENT",
};

function handleGoBack(session: AgentSession, action: AgentConversationAction, tools: AgentTools): StepResult {
  const resolve = GO_BACK_MAP[session.step];
  if (!resolve) return invalidAction(session, action);
  const nextStep = resolve(tools);
  return {
    patch: { step: nextStep },
    event: "WENT_BACK",
    messageKey: messageKeyForStep(nextStep),
    data: { previousStep: session.step, currentStep: nextStep },
  };
}

function handleCancelConversation(session: AgentSession, action: AgentConversationAction): StepResult {
  if (session.step === "ORDER_CREATED") return invalidAction(session, action);
  return {
    patch: { ...CLEAR_ORDER_DATA_PATCH, step: "START", underHumanHandoff: false },
    event: "CONVERSATION_CANCELLED",
    messageKey: "CONVERSATION_CANCELLED",
  };
}

function handleRequestHuman(session: AgentSession): StepResult {
  return {
    patch: { step: "HUMAN_HANDOFF", underHumanHandoff: true },
    event: "HUMAN_HANDOFF_STARTED",
    messageKey: "HUMAN_HANDOFF_STARTED",
  };
}

function handleResetConversation(): StepResult {
  return {
    patch: { ...CLEAR_ORDER_DATA_PATCH, step: "START", underHumanHandoff: false },
    event: "CONVERSATION_RESET",
    messageKey: "CONVERSATION_RESET",
  };
}

function sameSession(a: AgentSession, b: AgentSession): boolean {
  const { updatedAt: _a, ...restA } = a;
  const { updatedAt: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

export function handleConversationAction(input: HandleConversationActionInput): AgentConversationResult {
  const { action, tools } = input;
  const now = input.now ?? (() => new Date());
  const generateOrderIdempotencyKey = input.generateOrderIdempotencyKey ?? defaultGenerateOrderIdempotencyKey;
  const original: AgentSession = structuredClone(input.session);
  const previousStep = original.step;

  let result: StepResult;
  switch (action.type) {
    case "START_CONVERSATION":
      result = handleStartConversation(original, tools, action);
      break;
    case "SHOW_MENU": {
      const allowed: AgentConversationStep[] = ["START", "BROWSING_MENU", "BUILDING_ORDER"];
      if (!allowed.includes(original.step)) {
        result = invalidAction(original, action);
      } else {
        const products = tools.listProducts();
        const nextStep = original.step === "START" ? "BROWSING_MENU" : original.step;
        result = { patch: { step: nextStep }, event: "MENU_READY", messageKey: "MENU_READY", data: { products } };
      }
      break;
    }
    case "ADD_ITEM":
      result = handleAddItem(original, action, tools);
      break;
    case "UPDATE_ITEM_QUANTITY":
      result = handleUpdateItemQuantity(original, action);
      break;
    case "REMOVE_ITEM":
      result = handleRemoveItem(original, action);
      break;
    case "CLEAR_CART":
      result = handleClearCart(original, action);
      break;
    case "FINISH_CART":
      result = handleFinishCart(original, action, tools);
      break;
    case "SET_CUSTOMER_NAME":
      result = handleSetCustomerName(original, action);
      break;
    case "SET_CUSTOMER_PHONE":
      result = handleSetCustomerPhone(original, action);
      break;
    case "SET_FULFILLMENT":
      result = handleSetFulfillment(original, action, tools);
      break;
    case "SET_PICKUP_TIME":
      result = handleSetPickupTime(original, action, tools);
      break;
    case "SET_CUSTOMER_NOTES":
      result = handleSetCustomerNotes(original, action);
      break;
    case "SKIP_CUSTOMER_NOTES":
      result = handleSkipCustomerNotes(original, action);
      break;
    case "SET_PAYMENT_METHOD":
      result = handleSetPaymentMethod(original, action, tools);
      break;
    case "REVIEW_ORDER":
      result = handleReviewOrder(original, action, tools);
      break;
    case "CONFIRM_ORDER":
      result = handleConfirmOrder(original, action, tools, generateOrderIdempotencyKey);
      break;
    case "GO_BACK":
      result = handleGoBack(original, action, tools);
      break;
    case "CANCEL_CONVERSATION":
      result = handleCancelConversation(original, action);
      break;
    case "REQUEST_HUMAN":
      result = handleRequestHuman(original);
      break;
    case "RESET_CONVERSATION":
      result = handleResetConversation();
      break;
    default:
      result = invalidAction(original, action);
  }

  const candidate: AgentSession = { ...original, ...result.patch };
  const session = sameSession(original, candidate) ? original : { ...candidate, updatedAt: now().toISOString() };

  return {
    session,
    previousStep,
    currentStep: session.step,
    event: result.event,
    messageKey: result.messageKey,
    data: result.data,
  };
}
