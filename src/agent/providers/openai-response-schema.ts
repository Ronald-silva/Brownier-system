// JSON Schema completo da saída aceita pelo LLM Interpreter, usado pelo
// provider OpenAI em Structured Outputs (text.format.json_schema). Espelha
// os 20 tipos reais de AgentConversationAction (conversation.types.ts) e o
// formato já aceito por llm-output-validator.ts. Este schema só restringe
// forma e tipos — o validator local continua sendo a autoridade final para
// compatibilidade com a etapa da sessão, produtos/horários/pagamentos
// realmente existentes, combinação de ações e confirmação segura. Nenhuma
// dessa lógica semântica é duplicada aqui.

// Limites espelhados de llm-output-validator.ts (não exportados de lá, por
// isso repetidos aqui — mantenha em sincronia se um dos dois lados mudar):
// MAX_CUSTOMER_NAME_LENGTH, MAX_CUSTOMER_NOTES_LENGTH, MAX_PHONE_LENGTH,
// MAX_ITEM_QUANTITY e MAX_ACTIONS_PER_MESSAGE.
const CUSTOMER_NAME_MAX_LENGTH = 120;
const CUSTOMER_PHONE_MAX_LENGTH = 30;
const CUSTOMER_NOTES_MAX_LENGTH = 500;
const ITEM_QUANTITY_MAX = 100;
const MAX_ACTIONS = 5;

// Limites sem contraparte numérica no validator (que só compara contra
// listas de valores existentes) — escolhidos como um teto de formato
// razoável, não como regra de negócio.
const PRODUCT_ID_MAX_LENGTH = 200;
const PICKUP_TIME_MAX_LENGTH = 20;
const PAYMENT_METHOD_MAX_LENGTH = 100;
const REASON_MAX_LENGTH = 1000;
const SUGGESTION_MAX_LENGTH = 200;
const MAX_SUGGESTIONS = 5;

function actionTypeOnly<T extends string>(type: T) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: { const: type },
    },
  } as const;
}

const START_CONVERSATION = actionTypeOnly("START_CONVERSATION");
const SHOW_MENU = actionTypeOnly("SHOW_MENU");
const CLEAR_CART = actionTypeOnly("CLEAR_CART");
const FINISH_CART = actionTypeOnly("FINISH_CART");
const SKIP_CUSTOMER_NOTES = actionTypeOnly("SKIP_CUSTOMER_NOTES");
const REVIEW_ORDER = actionTypeOnly("REVIEW_ORDER");
const CONFIRM_ORDER = actionTypeOnly("CONFIRM_ORDER");
const GO_BACK = actionTypeOnly("GO_BACK");
const CANCEL_CONVERSATION = actionTypeOnly("CANCEL_CONVERSATION");
const REQUEST_HUMAN = actionTypeOnly("REQUEST_HUMAN");
const RESET_CONVERSATION = actionTypeOnly("RESET_CONVERSATION");

const ADD_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["type", "productId", "quantity"],
  properties: {
    type: { const: "ADD_ITEM" },
    productId: { type: "string", minLength: 1, maxLength: PRODUCT_ID_MAX_LENGTH },
    quantity: { type: "integer", minimum: 1, maximum: ITEM_QUANTITY_MAX },
  },
} as const;

const UPDATE_ITEM_QUANTITY = {
  type: "object",
  additionalProperties: false,
  required: ["type", "productId", "quantity"],
  properties: {
    type: { const: "UPDATE_ITEM_QUANTITY" },
    productId: { type: "string", minLength: 1, maxLength: PRODUCT_ID_MAX_LENGTH },
    quantity: { type: "integer", minimum: 1, maximum: ITEM_QUANTITY_MAX },
  },
} as const;

const REMOVE_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["type", "productId"],
  properties: {
    type: { const: "REMOVE_ITEM" },
    productId: { type: "string", minLength: 1, maxLength: PRODUCT_ID_MAX_LENGTH },
  },
} as const;

const SET_CUSTOMER_NAME = {
  type: "object",
  additionalProperties: false,
  required: ["type", "customerName"],
  properties: {
    type: { const: "SET_CUSTOMER_NAME" },
    customerName: { type: "string", minLength: 1, maxLength: CUSTOMER_NAME_MAX_LENGTH },
  },
} as const;

const SET_CUSTOMER_PHONE = {
  type: "object",
  additionalProperties: false,
  required: ["type", "customerPhone"],
  properties: {
    type: { const: "SET_CUSTOMER_PHONE" },
    customerPhone: { type: "string", minLength: 1, maxLength: CUSTOMER_PHONE_MAX_LENGTH },
  },
} as const;

// Único valor aceito é "RETIRADA" — ENTREGA nunca é uma opção representável
// no schema, mesmo que o modelo tente descrevê-la de outra forma.
const SET_FULFILLMENT = {
  type: "object",
  additionalProperties: false,
  required: ["type", "fulfillmentType"],
  properties: {
    type: { const: "SET_FULFILLMENT" },
    fulfillmentType: { const: "RETIRADA" },
  },
} as const;

// Validação contra os slots reais da sessão continua no validator local.
const SET_PICKUP_TIME = {
  type: "object",
  additionalProperties: false,
  required: ["type", "pickupTime"],
  properties: {
    type: { const: "SET_PICKUP_TIME" },
    pickupTime: { type: "string", minLength: 1, maxLength: PICKUP_TIME_MAX_LENGTH },
  },
} as const;

// Validação contra as opções reais continua no validator local.
const SET_PAYMENT_METHOD = {
  type: "object",
  additionalProperties: false,
  required: ["type", "paymentMethod"],
  properties: {
    type: { const: "SET_PAYMENT_METHOD" },
    paymentMethod: { type: "string", minLength: 1, maxLength: PAYMENT_METHOD_MAX_LENGTH },
  },
} as const;

const SET_CUSTOMER_NOTES = {
  type: "object",
  additionalProperties: false,
  required: ["type", "customerNotes"],
  properties: {
    type: { const: "SET_CUSTOMER_NOTES" },
    customerNotes: { type: "string", minLength: 1, maxLength: CUSTOMER_NOTES_MAX_LENGTH },
  },
} as const;

const ACTION_SCHEMAS = [
  START_CONVERSATION,
  SHOW_MENU,
  ADD_ITEM,
  UPDATE_ITEM_QUANTITY,
  REMOVE_ITEM,
  CLEAR_CART,
  FINISH_CART,
  SET_CUSTOMER_NAME,
  SET_CUSTOMER_PHONE,
  SET_FULFILLMENT,
  SET_PICKUP_TIME,
  SET_CUSTOMER_NOTES,
  SKIP_CUSTOMER_NOTES,
  SET_PAYMENT_METHOD,
  REVIEW_ORDER,
  CONFIRM_ORDER,
  GO_BACK,
  CANCEL_CONVERSATION,
  REQUEST_HUMAN,
  RESET_CONVERSATION,
] as const;

// Saída completa aceita do LLM Interpreter. MATCHED exige actions
// não-vazio e NOT_UNDERSTOOD/AMBIGUOUS exigem actions vazio na prática —
// essa regra condicional por status permanece no validator local
// (llm-output-validator.ts) para não duplicar lógica semântica aqui.
export const OPENAI_LLM_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "actions", "reason", "suggestions"],
  properties: {
    status: { type: "string", enum: ["MATCHED", "NOT_UNDERSTOOD", "AMBIGUOUS"] },
    actions: {
      type: "array",
      minItems: 0,
      maxItems: MAX_ACTIONS,
      items: {
        oneOf: ACTION_SCHEMAS,
      },
    },
    reason: { type: ["string", "null"], maxLength: REASON_MAX_LENGTH },
    suggestions: {
      type: "array",
      maxItems: MAX_SUGGESTIONS,
      items: { type: "string", minLength: 1, maxLength: SUGGESTION_MAX_LENGTH },
    },
  },
} as const;
