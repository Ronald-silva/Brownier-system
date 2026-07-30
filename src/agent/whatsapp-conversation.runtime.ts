import { createAgentConversationService } from "./conversation.service.ts";
import { resolveLlmRuntime } from "./llm-runtime.ts";
import type { NvidiaCompatibleClient } from "./providers/nvidia-nemotron-llm-provider.ts";
import { InMemoryAgentSessionStore } from "./session.store.ts";
import { createTextConversationService, type ProcessTextResult } from "./text-conversation.service.ts";
import { createAgentTools, type AgentDomainStore } from "./tools.ts";

export type WhatsappConversationRuntime = {
  processText(input: { channel: "whatsapp"; contactId: string; messageId: string; text: string }): Promise<ProcessTextResult>;
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
}): WhatsappConversationRuntime {
  const sessionStore = new InMemoryAgentSessionStore();
  const llmRuntime = resolveLlmRuntime({
    env: input.env ?? process.env,
    nvidiaClient: input.nvidiaClient,
  });
  const llmMode = llmRuntime.llmMode === "DISABLED" ? "DISABLED" : "FALLBACK";
  const llmInterpreter = llmRuntime.llmMode === "DISABLED" ? undefined : llmRuntime.llmInterpreter;

  return {
    async processText(message) {
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
      return result;
    },
  };
}
