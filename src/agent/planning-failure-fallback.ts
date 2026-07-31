// Planning Failure Fallback — calculado sempre que a chamada de planejamento
// (NVIDIA #1) falha (PROVIDER_ERROR) ou é rejeitada pelo validador
// (REJECTED_BY_VALIDATOR). Nunca o texto genérico de indisponibilidade por
// padrão: primeiro tenta responder a pergunta factual real (mesma lógica
// determinística de factual-intent.ts, que nunca depende do LLM), depois
// reapresenta o que a etapa atual já pede, e só na ausência total dos dois
// usa o texto genérico — mesmo assim rotulado, nunca silencioso.
import { resolveFactualIntent } from "./factual-intent.ts";
import { formatTimeBR, WEEKDAY_LABELS_PT_BR } from "../lib/business-hours.ts";
import type { AgentConversationStep, AgentSession } from "./session.types.ts";
import type { OperatingStatus } from "./operating-status.ts";
import type { PlanningFailureFallback } from "./conversation-intelligence.types.ts";

// Espelha messageKeyForStep (conversation.engine.ts) para as etapas em que
// faz sentido reapresentar o pedido de dado — conversation.engine.ts não é
// alterado por esta especificação, por isso a tabela é duplicada aqui (11
// entradas, estável). ORDER_CREATED usa ORDER_ALREADY_CREATED em vez de
// ORDER_CREATED puro, porque não há execução nova para popular publicCode
// via `data` — o valor real vem de session.createdOrderPublicCode.
const STEP_FALLBACK_MESSAGE_KEY: Record<AgentConversationStep, string> = {
  START: "WELCOME",
  BROWSING_MENU: "MENU_READY",
  BUILDING_ORDER: "CART_READY",
  COLLECTING_NAME: "ASK_CUSTOMER_NAME",
  COLLECTING_FULFILLMENT: "ASK_FULFILLMENT",
  COLLECTING_PICKUP_TIME: "ASK_PICKUP_TIME",
  COLLECTING_NOTES: "ASK_NOTES",
  COLLECTING_PAYMENT: "ASK_PAYMENT_METHOD",
  AWAITING_CONFIRMATION: "ORDER_REVIEW",
  ORDER_CREATED: "ORDER_ALREADY_CREATED",
  HUMAN_HANDOFF: "HUMAN_HANDOFF_STARTED",
};

// Mesma tradução de OperatingStatus -> messageKey/data usada no caminho
// determinístico principal (text-conversation.service.ts) — duplicada aqui
// (pura, pequena) para que este módulo continue testável isoladamente, sem
// importar a camada de orquestração.
function pickupAvailabilityFallback(status: OperatingStatus, reason: PlanningFailureFallback["reason"]): PlanningFailureFallback {
  if (!status.known) return { messageKey: "BUSINESS_PICKUP_HOURS_UNAVAILABLE", reason };
  if (status.isOpenNow) return { messageKey: "BUSINESS_OPEN_NOW", reason, data: { closeTime: formatTimeBR(status.currentClose!) } };
  if (!status.nextOpen) return { messageKey: "BUSINESS_CLOSED_NO_NEXT_OPEN", reason };
  if (status.nextOpen.sameDay) return { messageKey: "BUSINESS_CLOSED_TODAY", reason, data: { nextOpenTime: formatTimeBR(status.nextOpen.time) } };
  return {
    messageKey: "BUSINESS_CLOSED_OTHER_DAY",
    reason,
    data: { weekday: WEEKDAY_LABELS_PT_BR[status.nextOpen.weekday], nextOpenTime: formatTimeBR(status.nextOpen.time) },
  };
}

export type ComputePlanningFailureFallbackInput = {
  currentMessage: string;
  session: AgentSession;
  address?: string;
  operatingStatus?: OperatingStatus;
  reason: "PROVIDER_ERROR" | "REJECTED_BY_VALIDATOR";
};

export function computePlanningFailureFallback(input: ComputePlanningFailureFallbackInput): PlanningFailureFallback {
  const { currentMessage, session, address, operatingStatus, reason } = input;

  // Passo 1: a mesma checagem factual determinística de sempre — se o
  // cliente perguntou endereço/horário/menu, o servidor ainda sabe responder,
  // porque essa lógica nunca dependeu do LLM.
  const factual = resolveFactualIntent({ text: currentMessage, address, operatingStatus });
  if (factual?.kind === "ADDRESS") {
    return { messageKey: factual.address ? "BUSINESS_ADDRESS" : "BUSINESS_ADDRESS_UNAVAILABLE", reason, ...(factual.address ? { data: { address: factual.address } } : {}) };
  }
  if (factual?.kind === "PICKUP_AVAILABILITY") {
    return pickupAvailabilityFallback(factual.status, reason);
  }
  if (factual?.kind === "MENU") {
    return { messageKey: "MENU_READY", reason };
  }

  // Passo 2: sem sinal factual — reapresenta o que a etapa atual já pede.
  // Único caso sem uma etapa útil para reapresentar é START (nada foi pedido
  // ainda), que cai no passo 3.
  if (session.step !== "START") {
    return { messageKey: STEP_FALLBACK_MESSAGE_KEY[session.step], reason };
  }

  // Passo 3: último recurso explícito — nunca comportamento padrão silencioso.
  return { messageKey: "POLICY_LLM_TEMPORARILY_UNAVAILABLE", reason };
}
