// Tipos do Deterministic Message Interpreter — converte texto simples e
// inequívoco em uma AgentConversationAction estruturada, sem IA e sem fuzzy
// matching. Nenhuma lógica de conversa mora aqui, apenas a forma dos dados
// de entrada e do resultado da interpretação.
import type { AgentConversationAction } from "./conversation.types.ts";
import type { AgentSession } from "./session.types.ts";
import type { AgentPresentationContext } from "./presentation.ts";

// Só os campos públicos de catálogo que o interpretador pode usar para
// resolver posição/nome de produto, opções de pagamento e horários de
// retirada. Nunca inclui dados de pedido já criado.
export type DeterministicInterpreterContext = Pick<
  AgentPresentationContext,
  "products" | "paymentOptions" | "pickupSlots"
>;

export type InterpretDeterministicMessageInput = {
  text: string;
  session: AgentSession;
  context?: DeterministicInterpreterContext;
};

export type DeterministicInterpretationMatched = {
  status: "MATCHED";
  action: AgentConversationAction;
  confidence: 1;
  source: string;
  normalizedText: string;
};

export type DeterministicInterpretationNotUnderstood = {
  status: "NOT_UNDERSTOOD";
  reason: string;
  normalizedText: string;
  suggestions?: string[];
};

export type DeterministicInterpretationCandidate = {
  action: AgentConversationAction;
  label?: string;
};

export type DeterministicInterpretationAmbiguous = {
  status: "AMBIGUOUS";
  reason: string;
  normalizedText: string;
  candidates?: DeterministicInterpretationCandidate[];
};

export type DeterministicInterpretationResult =
  | DeterministicInterpretationMatched
  | DeterministicInterpretationNotUnderstood
  | DeterministicInterpretationAmbiguous;
