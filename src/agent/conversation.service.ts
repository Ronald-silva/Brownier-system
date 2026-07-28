// Agent Conversation Service — camada fina entre um futuro canal (WhatsApp,
// simulador, etc.) e o Conversation Engine. Monta a sessionKey, carrega ou
// cria a sessão pelo Session Store, evita reprocessar mensagens repetidas,
// delega toda a lógica de conversa para handleConversationAction() e
// persiste o resultado — sem conhecer Express, WhatsApp ou linguagem
// natural, e sem acessar o armazenamento interno do Session Store.
import type { AgentSession } from "./session.types.ts";
import { buildAgentSessionKey, type AgentSessionStore } from "./session.store.ts";
import { handleConversationAction } from "./conversation.engine.ts";
import type { AgentConversationAction, AgentConversationResult } from "./conversation.types.ts";
import type { AgentTools } from "./tools.ts";

export class AgentConversationServiceError extends Error {
  code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export type AgentConversationServiceDependencies = {
  sessionStore: AgentSessionStore;
  tools: AgentTools;
  now?: () => Date;
  generateOrderIdempotencyKey?: () => string;
};

export type ProcessActionInput = {
  channel: string;
  contactId: string;
  messageId?: string;
  action: AgentConversationAction;
};

export type AgentConversationServiceResult = {
  sessionKey: string;
  sessionBefore: AgentSession;
  result: AgentConversationResult;
  sessionAfter: AgentSession;
  duplicateMessage: boolean;
};

export type AgentConversationService = {
  processAction(input: ProcessActionInput): AgentConversationServiceResult;
};

function validateMessageId(messageId: string | undefined): void {
  if (messageId === undefined) return;
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw new AgentConversationServiceError(
      "invalid_message_id",
      "messageId deve ser uma string não vazia quando informado.",
    );
  }
}

export function createAgentConversationService(
  deps: AgentConversationServiceDependencies,
): AgentConversationService {
  if (!deps || !deps.sessionStore || !deps.tools) {
    throw new AgentConversationServiceError(
      "missing_dependencies",
      "sessionStore e tools são obrigatórios para criar o Agent Conversation Service.",
    );
  }
  const { sessionStore, tools, now, generateOrderIdempotencyKey } = deps;

  return {
    processAction(input: ProcessActionInput): AgentConversationServiceResult {
      const { channel, contactId, messageId, action } = input;
      validateMessageId(messageId);

      const sessionKey = buildAgentSessionKey(channel, contactId);
      const sessionBefore: AgentSession = structuredClone(sessionStore.getOrCreate({ channel, contactId }));

      if (messageId && sessionStore.hasProcessedMessage(sessionKey, messageId)) {
        const duplicateResult: AgentConversationResult = {
          session: structuredClone(sessionBefore),
          previousStep: sessionBefore.step,
          currentStep: sessionBefore.step,
          event: "MESSAGE_ALREADY_PROCESSED",
          messageKey: "MESSAGE_ALREADY_PROCESSED",
          data: { messageId },
        };
        return {
          sessionKey,
          sessionBefore: structuredClone(sessionBefore),
          result: duplicateResult,
          sessionAfter: structuredClone(sessionBefore),
          duplicateMessage: true,
        };
      }

      // Nenhum try/catch aqui de propósito: se o engine ou a persistência
      // lançarem, a execução para antes de markMessageProcessed — a mensagem
      // nunca é marcada como processada em caso de falha técnica.
      const engineResult = handleConversationAction({
        session: sessionBefore,
        action,
        tools,
        now,
        generateOrderIdempotencyKey,
      });

      let persisted: AgentSession = sessionStore.update(sessionKey, () => engineResult.session);

      if (messageId) {
        sessionStore.markMessageProcessed(sessionKey, messageId);
        persisted = sessionStore.get(sessionKey)!;
      }

      return {
        sessionKey,
        sessionBefore,
        result: { ...engineResult, session: structuredClone(persisted) },
        sessionAfter: structuredClone(persisted),
        duplicateMessage: false,
      };
    },
  };
}
