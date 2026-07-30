import { createAgentConversationService } from "./conversation.service.ts";
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
}): WhatsappConversationRuntime {
  const sessionStore = new InMemoryAgentSessionStore();
  return {
    async processText(message) {
      const store = await input.loadDomainStore();
      const orderCountBefore = store.orders.length;
      const tools = createAgentTools({ store });
      const conversationService = createAgentConversationService({ sessionStore, tools });
      // A integração WhatsApp permanece determinística nesta etapa: não cria
      // provider e não lê chaves OpenAI/NVIDIA.
      const textService = createTextConversationService({
        conversationService,
        sessionStore,
        tools,
        maxMisunderstandings: input.maxMisunderstandings,
        llmMode: "DISABLED",
      });
      const result = await textService.processText(message);
      if (store.orders.length !== orderCountBefore) await input.saveDomainStore(store);
      return result;
    },
  };
}
