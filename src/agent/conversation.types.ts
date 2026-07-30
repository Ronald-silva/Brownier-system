// Tipos do motor determinístico de conversa (Conversation Engine). Define as
// ações estruturadas aceitas e o formato do resultado devolvido — nenhuma
// interpretação de linguagem natural, nenhum texto final em português aqui.
import type { AgentConversationStep, AgentSession } from "./session.types.ts";
import type { AgentTools } from "./tools.ts";

export type AgentConversationAction =
  | { type: "START_CONVERSATION"; greeting?: "Olá" | "Bom dia" | "Boa tarde" | "Boa noite" }
  | { type: "SHOW_MENU" }
  | { type: "ADD_ITEM"; productId: string; quantity: number }
  | { type: "UPDATE_ITEM_QUANTITY"; productId: string; quantity: number }
  | { type: "REMOVE_ITEM"; productId: string }
  | { type: "CLEAR_CART" }
  | { type: "FINISH_CART" }
  | { type: "SET_CUSTOMER_NAME"; customerName: string }
  | { type: "SET_CUSTOMER_PHONE"; customerPhone: string }
  | { type: "SET_FULFILLMENT"; fulfillmentType: string }
  | { type: "SET_PICKUP_TIME"; pickupTime: string }
  | { type: "SET_CUSTOMER_NOTES"; customerNotes: string }
  | { type: "SKIP_CUSTOMER_NOTES" }
  | { type: "SET_PAYMENT_METHOD"; paymentMethod: string }
  | { type: "REVIEW_ORDER" }
  | { type: "CONFIRM_ORDER" }
  | { type: "GO_BACK" }
  | { type: "CANCEL_CONVERSATION" }
  | { type: "REQUEST_HUMAN" }
  | { type: "RESET_CONVERSATION" };

export type AgentConversationResult = {
  session: AgentSession;
  previousStep: AgentConversationStep;
  currentStep: AgentConversationStep;
  event: string;
  messageKey: string;
  data?: Record<string, unknown>;
};

// Erro técnico do motor (dependência ausente, etc.) — nunca usado para
// representar um fluxo de conversa normal, que deve sempre virar um
// AgentConversationResult (ex.: INVALID_ACTION), nunca uma exceção.
export class AgentConversationError extends Error {
  code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export type HandleConversationActionInput = {
  session: AgentSession;
  action: AgentConversationAction;
  tools: AgentTools;
  now?: () => Date;
  // Gerador da chave de idempotência usada por CONFIRM_ORDER ao criar o
  // pedido real. Produção usa a implementação padrão segura; testes injetam
  // uma chave determinística.
  generateOrderIdempotencyKey?: () => string;
};
