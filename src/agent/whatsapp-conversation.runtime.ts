import { createAgentConversationService } from "./conversation.service.ts";
import { randomUUID } from "node:crypto";
import { resolveLlmRuntime } from "./llm-runtime.ts";
import type { PostgresConversationState } from "./postgres-conversation-state.ts";
import type { NvidiaCompatibleClient } from "./providers/nvidia-nemotron-llm-provider.ts";
import { buildAgentSessionKey, InMemoryAgentSessionStore } from "./session.store.ts";
import { createTextConversationService, type ProcessTextResult } from "./text-conversation.service.ts";
import { createAgentTools, type AgentDomainStore } from "./tools.ts";

export type WhatsappConversationRuntime = {
  processText(input: { channel: "whatsapp"; contactId: string; messageId: string; text: string }): Promise<ProcessTextResult>;
  markResponseDelivered?(input: { channel: "whatsapp"; contactId: string; messageId: string }): Promise<void>;
};

// Mantém apenas a sessão em memória, conforme o contrato atual. O store de
// domínio continua sendo JSON e só é salvo quando a Tool oficial criou pedido.
export function createWhatsappConversationRuntime(input: {
  loadDomainStore: () => Promise<AgentDomainStore>;
  saveDomainStore: (store: AgentDomainStore) => Promise<void>;
  maxMisunderstandings?: number;
  env?: Record<string, string | undefined>;
  // Injeção exclusiva de testes: evita qualquer chamada de rede na suíte.
  nvidiaClient?: NvidiaCompatibleClient;
  persistentState?: PostgresConversationState;
}): WhatsappConversationRuntime {
  const sessionStore = new InMemoryAgentSessionStore();
  const llmRuntime = resolveLlmRuntime({
    env: input.env ?? process.env,
    nvidiaClient: input.nvidiaClient,
  });
  const llmMode = llmRuntime.llmMode === "DISABLED" ? "DISABLED" : "FALLBACK";
  const llmInterpreter = llmRuntime.llmMode === "DISABLED" ? undefined : llmRuntime.llmInterpreter;
  const sessionLocks = new Map<string, Promise<unknown>>();

  function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tracked = run.catch(() => {});
    sessionLocks.set(key, tracked);
    run.finally(() => {
      if (sessionLocks.get(key) === tracked) sessionLocks.delete(key);
    }).catch(() => {});
    return run;
  }

  return {
    async processText(message) {
      const sessionKey = buildAgentSessionKey(message.channel, message.contactId);
      return withSessionLock(sessionKey, async () => {
        if (input.persistentState) {
          const reservation = await input.persistentState.reserveIncoming(message);
          if (reservation.state === "DELIVERED") {
            const existing = sessionStore.get(sessionKey) ?? sessionStore.getOrCreate(message);
            return {
              sessionKey,
              duplicateMessage: true,
              sessionBefore: structuredClone(existing),
              sessionAfter: structuredClone(existing),
              policy: { misunderstandingCountBefore: existing.misunderstandingCount, misunderstandingCountAfter: existing.misunderstandingCount, handoffTriggered: false, counterReset: false },
              messages: [],
            };
          }
          if (reservation.state === "READY") {
            const existing = sessionStore.get(sessionKey) ?? sessionStore.getOrCreate(message);
            return {
              sessionKey,
              duplicateMessage: false,
              sessionBefore: structuredClone(existing),
              sessionAfter: structuredClone(existing),
              policy: { misunderstandingCountBefore: existing.misunderstandingCount, misunderstandingCountAfter: existing.misunderstandingCount, handoffTriggered: false, counterReset: false },
              messages: reservation.messages.map(message => ({ ...message, id: randomUUID() })),
            };
          }
          const persistedSession = await input.persistentState.loadSession(message);
          if (persistedSession) sessionStore.restore(persistedSession);
        }
        const store = await input.loadDomainStore();
        const orderCountBefore = store.orders.length;
        const tools = createAgentTools({ store });
        const conversationService = createAgentConversationService({ sessionStore, tools });
        // O interpretador determinístico continua sendo a primeira camada. O
        // NIM só entra no fallback para linguagem natural elegível; toda saída
        // ainda passa pelo validator e pelo Conversation Engine.
        const textService = createTextConversationService({
          conversationService,
          sessionStore,
          tools,
          maxMisunderstandings: input.maxMisunderstandings,
          llmMode,
          ...(llmInterpreter === undefined ? {} : { llmInterpreter }),
        });
        const result = await textService.processText(message);
        if (store.orders.length !== orderCountBefore) await input.saveDomainStore(store);
        if (input.persistentState) {
          await input.persistentState.saveSession({ session: result.sessionAfter, lastIntent: result.result?.event ?? result.policyResult?.event });
          await input.persistentState.saveResponse({ ...message, messages: result.messages });
        }
        return result;
      });
    },
    ...(input.persistentState
      ? { markResponseDelivered: async (message: { channel: "whatsapp"; contactId: string; messageId: string }) => input.persistentState!.markResponseDelivered(message) }
      : {}),
  };
}
