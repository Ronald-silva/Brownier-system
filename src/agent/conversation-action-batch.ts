// Conversation Action Batch — preflight + execução sequencial de um lote de
// AgentConversationAction[] já validado pelo llm-output-validator.ts. O
// Session Store atual não tem transação real, então esta camada NUNCA finge
// atomicidade: primeiro simula o lote inteiro numa sessão/loja descartáveis
// (sem tocar o store real, sem registrar messageId, sem chamar createOrder)
// e só executa oficialmente pelo Conversation Service depois que o preflight
// inteiro passa. Se a execução oficial falhar tecnicamente no meio (o que o
// preflight já deveria ter pego), devolve FAILED sem tentar rollback falso.
import type { AgentConversationAction, AgentConversationResult } from "./conversation.types.ts";
import type { AgentSession } from "./session.types.ts";
import type { AgentTools } from "./tools.ts";
import { InMemoryAgentSessionStore } from "./session.store.ts";
import {
  createAgentConversationService,
  type AgentConversationService,
  type AgentConversationServiceResult,
} from "./conversation.service.ts";

export const MAX_BATCH_ACTIONS = 12;

// Ações que só fazem sentido sozinhas numa mensagem: confirmar pedido,
// pedir humano, resetar ou cancelar a conversa. O llm-output-validator.ts já
// bloqueia CONFIRM_ORDER combinado (regra de schema); as outras três não
// aparecem nessa regra porque coexistem com ações normais no mesmo
// STEP_ALLOWED_ACTIONS — o bloqueio delas é responsabilidade desta camada.
const SOLO_ONLY_ACTION_TYPES: ReadonlySet<AgentConversationAction["type"]> = new Set([
  "CONFIRM_ORDER",
  "REQUEST_HUMAN",
  "RESET_CONVERSATION",
  "CANCEL_CONVERSATION",
]);

// messageKeys que o Conversation Engine devolve quando uma ação foi
// recusada por regra de domínio (produto indisponível, quantidade inválida,
// carrinho vazio, forma de pagamento indisponível etc.) — nenhum desses
// lança exceção, então o preflight/execução precisa reconhecer a falha pelo
// messageKey, não por try/catch.
//
// Exportado porque esta é a definição autoritativa de "o Engine recusou a
// ação" no sistema inteiro: o Text Conversation Service usa o mesmo predicado
// para decidir se uma ação única (determinística ou vinda do LLM) pode zerar o
// misunderstandingCount. Duas listas paralelas divergiriam com o tempo e
// reabririam o buraco na rede de segurança do handoff automático.
export const FAILURE_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  "INVALID_ACTION",
  "INVALID_PRODUCT",
  "INVALID_QUANTITY",
  "INVALID_CUSTOMER_NAME",
  "INVALID_CUSTOMER_PHONE",
  "INVALID_CUSTOMER_NOTES",
  "INVALID_PICKUP_TIME",
  "CART_EMPTY",
  "PAYMENT_METHOD_INVALID",
  "PAYMENT_METHOD_UNAVAILABLE",
  "PAYMENT_METHOD_REQUIRED",
  "INCOMPLETE_ORDER_DATA",
  "ORDER_CREATION_FAILED",
  "STORE_CLOSED",
]);

export function isFailureResult(result: AgentConversationResult): boolean {
  return FAILURE_MESSAGE_KEYS.has(result.messageKey);
}

export type BatchStructureCheckResult = { ok: true } | { ok: false; reason: string };

export function checkBatchStructure(actions: AgentConversationAction[]): BatchStructureCheckResult {
  if (actions.length === 0) return { ok: false, reason: "EMPTY_BATCH" };
  if (actions.length > MAX_BATCH_ACTIONS) return { ok: false, reason: "TOO_MANY_ACTIONS" };
  if (actions.length === 1) return { ok: true };
  if (actions.some(action => SOLO_ONLY_ACTION_TYPES.has(action.type))) {
    return { ok: false, reason: "SOLO_ONLY_ACTION_COMBINED" };
  }
  return { ok: true };
}

export type PreflightConversationActionsInput = {
  session: AgentSession;
  actions: AgentConversationAction[];
  tools: AgentTools;
};

export type PreflightConversationActionsResult = { ok: true } | { ok: false; reason: string; failedActionIndex: number };

// CONFIRM_ORDER nunca chega até aqui sozinho o suficiente para acionar
// createOrder (checkBatchStructure barra qualquer combinação, e o chamador
// — Task 6/7 — só invoca este módulo para lotes com mais de uma ação).
// Bloquear createOrder aqui é defesa em profundidade, não a única barreira.
function createBlockedCreateOrderTools(tools: AgentTools): AgentTools {
  return {
    ...tools,
    createOrder() {
      throw new Error("createOrder não pode ser chamado durante o preflight de lote do LLM.");
    },
  };
}

export function preflightConversationActions(input: PreflightConversationActionsInput): PreflightConversationActionsResult {
  const { actions, tools } = input;
  const structure = checkBatchStructure(actions);
  if (structure.ok === false) return { ok: false, reason: structure.reason, failedActionIndex: 0 };

  const seeded: AgentSession = structuredClone(input.session);
  const shadowStore = new InMemoryAgentSessionStore();
  shadowStore.create({ channel: seeded.channel, contactId: seeded.contactId, step: seeded.step });
  shadowStore.update(seeded.sessionKey, () => seeded);
  const shadowTools = createBlockedCreateOrderTools(tools);
  const shadowService = createAgentConversationService({ sessionStore: shadowStore, tools: shadowTools });

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]!;
    let stepResult: AgentConversationServiceResult;
    try {
      stepResult = shadowService.processAction({ channel: seeded.channel, contactId: seeded.contactId, action });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "PREFLIGHT_TECHNICAL_ERROR", failedActionIndex: i };
    }
    if (isFailureResult(stepResult.result)) {
      return { ok: false, reason: stepResult.result.messageKey, failedActionIndex: i };
    }
  }
  return { ok: true };
}

export type ExecuteConversationActionBatchInput = {
  conversationService: AgentConversationService;
  channel: string;
  contactId: string;
  session: AgentSession;
  actions: AgentConversationAction[];
  tools: AgentTools;
};

export type ExecuteConversationActionBatchResult = {
  status: "COMPLETED" | "REJECTED" | "FAILED";
  results: AgentConversationServiceResult[];
  sessionBefore: AgentSession;
  sessionAfter: AgentSession;
  failedActionIndex?: number;
  reason?: string;
};

// Nenhuma ação do lote usa o messageId do usuário — cabe ao chamador (Text
// Conversation Service) marcar o messageId original como processado uma
// única vez, depois que este executor devolver COMPLETED.
export function executeConversationActionBatch(input: ExecuteConversationActionBatchInput): ExecuteConversationActionBatchResult {
  const { conversationService, channel, contactId, tools, actions } = input;
  const sessionBefore = structuredClone(input.session);

  const structure = checkBatchStructure(actions);
  if (structure.ok === false) {
    return { status: "REJECTED", results: [], sessionBefore, sessionAfter: sessionBefore, failedActionIndex: 0, reason: structure.reason };
  }

  const preflight = preflightConversationActions({ session: sessionBefore, actions, tools });
  if (preflight.ok === false) {
    return {
      status: "REJECTED",
      results: [],
      sessionBefore,
      sessionAfter: sessionBefore,
      failedActionIndex: preflight.failedActionIndex,
      reason: preflight.reason,
    };
  }

  const results: AgentConversationServiceResult[] = [];
  let sessionAfter = sessionBefore;
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]!;
    const stepResult = conversationService.processAction({ channel, contactId, action });
    results.push(stepResult);
    sessionAfter = stepResult.sessionAfter;
    if (isFailureResult(stepResult.result)) {
      return { status: "FAILED", results, sessionBefore, sessionAfter, failedActionIndex: i, reason: stepResult.result.messageKey };
    }
  }

  return { status: "COMPLETED", results, sessionBefore, sessionAfter };
}
