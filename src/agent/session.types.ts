// Tipos do estado de sessão do agente de conversa. Nenhuma lógica de
// transição de etapas é implementada aqui — apenas a forma dos dados.

// Memória conversacional de curto prazo (últimas trocas, incluindo a
// mensagem atual do cliente como última entrada quando aplicável). Usada
// somente como contexto linguístico para o planejamento/verbalização NVIDIA
// (referências, correções, continuidade) — nunca como fonte de preço,
// produto, endereço ou horário. Ver src/agent/short-history.ts.
export type AgentShortHistoryEntry = {
  role: "customer" | "agent";
  text: string;
  at: string;
  messageId?: string;
};

export type AgentConversationStep =
  | "START"
  | "BROWSING_MENU"
  | "BUILDING_ORDER"
  | "COLLECTING_NAME"
  | "COLLECTING_FULFILLMENT"
  | "COLLECTING_PICKUP_TIME"
  | "COLLECTING_NOTES"
  | "COLLECTING_PAYMENT"
  | "AWAITING_CONFIRMATION"
  | "ORDER_CREATED"
  | "HUMAN_HANDOFF";

// Apenas a referência ao produto e a quantidade. Preço, nome e descrição
// são consultados na fonte oficial (produtos) quando necessário, nunca
// duplicados aqui.
export type AgentCartItem = {
  productId: string;
  quantity: number;
};

export type AgentSession = {
  sessionKey: string;
  channel: string;
  contactId: string;
  step: AgentConversationStep;
  items: AgentCartItem[];
  customerName?: string;
  customerPhone?: string;
  fulfillmentType?: string;
  pickupTime?: string;
  customerNotes?: string;
  paymentMethod?: string;
  createdOrderId?: string;
  createdOrderPublicCode?: string;
  orderIdempotencyKey?: string;
  processedMessageIds: string[];
  underHumanHandoff: boolean;
  misunderstandingCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  // Opcional por compatibilidade: sessões persistidas antes desta mudança
  // não têm o campo. Sempre tratado como [] quando ausente.
  shortHistory?: AgentShortHistoryEntry[];
};
