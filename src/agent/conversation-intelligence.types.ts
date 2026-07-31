// Tipos do fluxo híbrido de conversação (planejamento -> execução -> fatos ->
// verbalização -> validação). Nenhuma lógica mora aqui, apenas o contrato
// entre as camadas. Aditivo em relação aos tipos existentes do LLM
// Interpreter (llm-interpreter.types.ts) — nunca substitui o status
// MATCHED/NOT_UNDERSTOOD/AMBIGUOUS/REJECTED/PROVIDER_ERROR já validado.
import type { AgentConversationResult } from "./conversation.types.ts";
import type { AgentSession } from "./session.types.ts";
import type { OperatingStatus } from "./operating-status.ts";

// Classificação de alto nível da mensagem, produzida pelo planejamento
// (chamada NVIDIA #1). Não é a ação de negócio (isso continua sendo
// AgentConversationAction) — é o "tipo comunicativo" da mensagem.
export type ConversationIntent =
  | "BUSINESS_ACTION"
  | "SOCIAL"
  | "FACTUAL_QUESTION"
  | "CLARIFICATION_NEEDED"
  | "OBJECTION"
  | "OUT_OF_SCOPE"
  | "REQUEST_HUMAN"
  | "UNRECOGNIZED";

export type AllowedFactKey =
  | "PRODUCT"
  | "CART_SUMMARY"
  | "ORDER_CONFIRMATION"
  | "BUSINESS_ADDRESS"
  | "OPERATING_STATUS"
  | "PICKUP_SLOTS"
  | "PAYMENT_OPTIONS"
  | "MISSING_FIELDS"
  | "ORDER_FAILURE_REASON";

// Objetivo comunicativo do turno de resposta. Nunca escolhe canal de saída
// (isso é response-strategy-policy.ts, sempre determinístico e do servidor).
export type ResponseIntent =
  | { kind: "SOCIAL_ACK" }
  | { kind: "ANSWER_FACTUAL"; factKeys: AllowedFactKey[] }
  | { kind: "CONFIRM_ACTION_RESULT" }
  | { kind: "ASK_CLARIFICATION"; ambiguityReason: string }
  | { kind: "OFFER_SUGGESTION"; productIds: string[] }
  | { kind: "ACKNOWLEDGE_OBJECTION" }
  | { kind: "DECLINE_OUT_OF_SCOPE" }
  | { kind: "REQUEST_HUMAN_ACK" };

// Única peça do pipeline que decide "template ou verbalizar". Nunca vem do
// NVIDIA — sempre calculada por response-strategy-policy.ts.
export type RenderStrategy = "TEMPLATE" | "VERBALIZE";

// A ÚNICA fonte de verdade factual que a verbalização pode citar. factId é
// único por instância dentro de um mesmo AllowedFact[] (não só por key).
export type AllowedFact =
  | { factId: string; key: "PRODUCT"; id: string; name: string; price: number; promotionalPrice: number | null }
  | { factId: string; key: "CART_SUMMARY"; items: Array<{ productId: string; name: string; quantity: number }> }
  | { factId: string; key: "ORDER_CONFIRMATION"; publicCode: string; replayed: boolean }
  | { factId: string; key: "BUSINESS_ADDRESS"; address: string }
  | { factId: string; key: "OPERATING_STATUS"; status: OperatingStatus }
  | { factId: string; key: "PICKUP_SLOTS"; slots: string[] }
  | { factId: string; key: "PAYMENT_OPTIONS"; options: string[] }
  | { factId: string; key: "MISSING_FIELDS"; fields: string[] }
  | { factId: string; key: "ORDER_FAILURE_REASON"; reasonCode: string };

// Ponte entre a execução real (Engine/Tools, inalterados) e a verbalização.
export type TurnOutcome = {
  engineResult?: AgentConversationResult;
  session: AgentSession;
  facts: AllowedFact[];
  responseIntent: ResponseIntent;
  renderStrategy: RenderStrategy;
  fallbackMessageKey: string;
  fallbackData?: Record<string, unknown>;
};

// Memória conversacional de curto prazo — nunca fonte de fato (preço,
// produto, endereço, horário só vêm de AllowedFact). Só serve para resolver
// referências, correções e continuidade.
export type ShortHistoryEntry = {
  role: "customer" | "agent";
  text: string;
  at: string;
  messageId?: string;
};

export type VerbalizationRequest = {
  currentCustomerMessage: string;
  shortHistory: ShortHistoryEntry[];
  responseIntent: ResponseIntent;
  facts: AllowedFact[];
  businessName: string;
  promptVersion: string;
};

export type VerbalizationResult =
  | { status: "VERBALIZED"; text: string; usedFactIds: string[]; durationMs: number }
  | { status: "REJECTED"; reason: string; durationMs: number }
  | { status: "PROVIDER_ERROR"; reason: string; retryable: boolean; durationMs: number };

// Calculado sempre que a chamada de planejamento (NVIDIA #1) falha ou é
// rejeitada — nunca o texto genérico incondicional de indisponibilidade,
// exceto como último recurso explícito (ver planning-failure-fallback.ts).
export type PlanningFailureFallback = {
  messageKey: string;
  reason: "PROVIDER_ERROR" | "REJECTED_BY_VALIDATOR";
  data?: Record<string, unknown>;
};
