// Simulador local do agente — lê ações estruturadas (JSON, uma por linha) do
// stdin e escreve o resultado (JSON, uma linha) no stdout. Não sobe servidor
// HTTP, não abre porta, não interpreta linguagem natural e não conhece
// WhatsApp: serve só para inspecionar sessão/ação/resultado durante o
// desenvolvimento local, antes da integração com IA e WhatsApp.
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { resolveStorePath, loadStoreFile, saveStoreFile } from "../lib/store.ts";
import { createAgentTools, type AgentDomainStore } from "./tools.ts";
import { InMemoryAgentSessionStore, buildAgentSessionKey } from "./session.store.ts";
import { createAgentConversationService, type AgentConversationServiceResult } from "./conversation.service.ts";
import { buildConversationPresentation } from "./presentation.ts";
import { renderConversationPresentation } from "./renderer.ts";
import { createTextConversationService, TextConversationServiceError } from "./text-conversation.service.ts";
import { resolveLlmRuntime } from "./llm-runtime.ts";
import { LlmRuntimeConfigError } from "./llm-runtime-config.ts";
import type { OpenAiResponsesClient } from "./providers/openai-llm-provider.ts";
import type { NvidiaCompatibleClient } from "./providers/nvidia-nemotron-llm-provider.ts";
import type { TextConversationService } from "./text-conversation.service.ts";

// Lista pequena e explícita das ações estruturadas aceitas pelo Conversation
// Engine (src/agent/conversation.types.ts). Mantida aqui só para validação
// de forma na borda do simulador — a validação de conteúdo de cada ação
// continua sendo responsabilidade exclusiva do engine.
export const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  "START_CONVERSATION",
  "SHOW_MENU",
  "ADD_ITEM",
  "UPDATE_ITEM_QUANTITY",
  "REMOVE_ITEM",
  "CLEAR_CART",
  "FINISH_CART",
  "SET_CUSTOMER_NAME",
  "SET_CUSTOMER_PHONE",
  "SET_FULFILLMENT",
  "SET_PICKUP_TIME",
  "SET_CUSTOMER_NOTES",
  "SKIP_CUSTOMER_NOTES",
  "SET_PAYMENT_METHOD",
  "REVIEW_ORDER",
  "CONFIRM_ORDER",
  "GO_BACK",
  "CANCEL_CONVERSATION",
  "REQUEST_HUMAN",
  "RESET_CONVERSATION",
]);

export type SimulatorErrorResponse = { ok: false; error: { code: string; message: string } };

export type ParsedSimulatorLine =
  | {
      kind: "action";
      channel: string;
      contactId: string;
      messageId?: string;
      action: { type: string; [key: string]: unknown };
    }
  | { kind: "text"; channel: string; contactId: string; messageId?: string; text: string }
  | { kind: "command"; command: "GET_SESSION"; channel: string; contactId: string };

function invalidInput(message: string): SimulatorErrorResponse {
  return { ok: false, error: { code: "INVALID_SIMULATOR_INPUT", message } };
}

// Validação runtime mínima da forma da linha recebida — o Conversation
// Engine já valida o conteúdo específico de cada ação, então aqui só
// confirmamos a "casca" (channel/contactId/action/type conhecido) que o
// TypeScript não pode garantir vindo de uma linha de texto externa.
export function parseSimulatorLine(raw: string): { ok: true; value: ParsedSimulatorLine } | SimulatorErrorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidInput("Linha não é um JSON válido.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return invalidInput("A linha precisa ser um objeto JSON.");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.command === "string") {
    if (obj.command !== "GET_SESSION") {
      return invalidInput(`Comando desconhecido: ${obj.command}`);
    }
    if (typeof obj.channel !== "string" || obj.channel.trim().length === 0) {
      return invalidInput("channel é obrigatório para GET_SESSION.");
    }
    if (typeof obj.contactId !== "string" || obj.contactId.trim().length === 0) {
      return invalidInput("contactId é obrigatório para GET_SESSION.");
    }
    return { ok: true, value: { kind: "command", command: "GET_SESSION", channel: obj.channel, contactId: obj.contactId } };
  }

  if (typeof obj.channel !== "string" || obj.channel.trim().length === 0) {
    return invalidInput("channel é obrigatório.");
  }
  if (typeof obj.contactId !== "string" || obj.contactId.trim().length === 0) {
    return invalidInput("contactId é obrigatório.");
  }
  if (obj.messageId !== undefined && typeof obj.messageId !== "string") {
    return invalidInput("messageId, quando informado, deve ser uma string.");
  }

  // Modo textual: entrada com `text` é interpretada pelo Deterministic
  // Message Interpreter antes de virar uma AgentConversationAction — nunca
  // é a action estruturada em si (esse continua sendo o modo `action`
  // abaixo, inalterado).
  if (typeof obj.text === "string") {
    if (obj.text.trim().length === 0) {
      return invalidInput("text não pode ser vazio.");
    }
    return {
      ok: true,
      value: {
        kind: "text",
        channel: obj.channel,
        contactId: obj.contactId,
        messageId: obj.messageId as string | undefined,
        text: obj.text,
      },
    };
  }

  if (typeof obj.action !== "object" || obj.action === null) {
    return invalidInput("action ou text é obrigatório.");
  }
  const action = obj.action as Record<string, unknown>;
  if (typeof action.type !== "string" || !KNOWN_ACTION_TYPES.has(action.type)) {
    return invalidInput(`action.type desconhecido ou ausente: ${String(action.type)}`);
  }

  return {
    ok: true,
    value: {
      kind: "action",
      channel: obj.channel,
      contactId: obj.contactId,
      messageId: obj.messageId as string | undefined,
      action: action as { type: string; [key: string]: unknown },
    },
  };
}

// Semente usada apenas quando BF_STORE_PATH aponta para um arquivo que ainda
// não existe (ex.: primeira execução local, ou um caminho temporário de
// teste). Nunca é usada para sobrescrever dados reais já presentes no
// arquivo — loadStoreFile só chama isto quando a leitura falha.
export function buildSeedDomainStore(): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal (simulador)",
      pickupEnabled: true,
      deliveryEnabled: false,
      deliveryFee: 0,
      pickupSlots: [],
      paymentMethods: ["PIX", "DINHEIRO", "A_COMBINAR"],
      availabilityNotice: "Loja de simulação local.",
    },
    products: [
      {
        id: "brownie-brigadeiro",
        slug: "brigadeiro",
        name: "Brownie de Brigadeiro",
        description: "Brownie artesanal finalizado com brigadeiro cremoso.",
        category: "Brownies",
        basePrice: 5,
        promotionalPrice: null,
        minimumPromotionalQuantity: null,
        isActive: true,
        isAvailable: true,
        displayOrder: 1,
        ingredients: "Chocolate, brigadeiro, farinha, ovos e manteiga",
        allergens: "Contém glúten, leite e ovos",
      },
    ],
    orders: [],
  };
}

// Limite de misunderstandingCount usado pelo Interpretation Policy
// (src/agent/text-conversation.service.ts) antes de encaminhar a conversa
// para atendimento humano automaticamente. Opcional — o padrão (3) e os
// limites (1 a 10) são validados pelo próprio Text Conversation Service na
// criação; aqui só convertemos a variável de ambiente para número, sem
// fallback silencioso para texto inválido.
function resolveMaxMisunderstandingsFromEnv(): number | undefined {
  const raw = process.env.BF_AGENT_MAX_MISUNDERSTANDINGS?.trim();
  if (!raw) return undefined;
  return Number(raw);
}

export type SimulatorRuntimeOptions = {
  domainStore: AgentDomainStore;
  maxMisunderstandings?: number;
  // Fonte única do modo do LLM (BF_LLM_MODE/OPENAI_API_KEY/OPENAI_MODEL) —
  // resolvida via resolveLlmRuntime/readLlmRuntimeConfig, nunca lida
  // diretamente de process.env aqui dentro. Default {} ⇒ DISABLED.
  env?: Record<string, string | undefined>;
  // Só para testes: cliente OpenAI fake repassado ao provider quando o modo
  // resolvido é OPENAI_FALLBACK. Nunca criado nem exposto por esta função.
  openAiClient?: OpenAiResponsesClient;
  // Só para testes: cliente NVIDIA fake repassado ao provider quando o modo
  // resolvido é NVIDIA_NEMOTRON. Nunca criado nem exposto por esta função.
  nvidiaClient?: NvidiaCompatibleClient;
};

export type SimulatorRuntime = {
  tools: ReturnType<typeof createAgentTools>;
  sessionStore: InMemoryAgentSessionStore;
  conversationService: ReturnType<typeof createAgentConversationService>;
  textService: TextConversationService;
};

// Fábrica isolada do runtime do simulador — extraída para que testes
// possam instanciar o mesmo runtime com um env e um cliente OpenAI fake
// explícitos, sem depender de spawn de processo nem de rede. O CLI real
// (runSimulator) sempre chama isto com env: process.env, então a execução
// via `npm run agent:simulate` continua resolvendo o modo a partir do
// ambiente real (DISABLED por padrão, quando BF_LLM_MODE não está setado).
// Devolve `conversationService` também porque o modo `action` cru do
// simulador (linha do stdin com `action`, não `text`) continua chamando-o
// diretamente, sem passar pelo Text Conversation Service.
export function createSimulatorRuntime(options: SimulatorRuntimeOptions): SimulatorRuntime {
  const tools = createAgentTools({ store: options.domainStore });
  const sessionStore = new InMemoryAgentSessionStore();
  const conversationService = createAgentConversationService({ sessionStore, tools });
  const llmRuntime = resolveLlmRuntime({
    env: options.env ?? {},
    openAiClient: options.openAiClient,
    nvidiaClient: options.nvidiaClient,
  });
  const textConversationLlmMode =
    llmRuntime.llmMode === "DISABLED"
      ? "DISABLED"
      : "FALLBACK";

  // O Text Conversation Service não conhece providers: todo runtime ativo
  // recebe seu interpreter já criado e usa o modo interno FALLBACK.
  const textService = llmRuntime.llmMode === "DISABLED"
    ? createTextConversationService({
        conversationService,
        sessionStore,
        tools,
        maxMisunderstandings: options.maxMisunderstandings,
        llmMode: textConversationLlmMode,
      })
    : createTextConversationService({
        conversationService,
        sessionStore,
        tools,
        maxMisunderstandings: options.maxMisunderstandings,
        llmMode: textConversationLlmMode,
        llmInterpreter: llmRuntime.llmInterpreter,
      });
  return { tools, sessionStore, conversationService, textService };
}

async function runSimulator(): Promise<void> {
  if (!process.env.BF_STORE_PATH?.trim()) {
    console.log(
      JSON.stringify({
        ok: false,
        error: {
          code: "MISSING_BF_STORE_PATH",
          message: "Defina BF_STORE_PATH — o simulador não escreve no arquivo de dados real.",
        },
      }),
    );
    process.exitCode = 1;
    return;
  }
  const storePath = resolveStorePath();
  // Suppress console.log during store initialization since we output only JSON to stdout
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  const domainStore = await loadStoreFile<AgentDomainStore>(storePath, buildSeedDomainStore);
  console.log = originalLog;
  let runtime: SimulatorRuntime;
  try {
    runtime = createSimulatorRuntime({
      domainStore,
      maxMisunderstandings: resolveMaxMisunderstandingsFromEnv(),
      env: process.env,
    });
  } catch (error) {
    const code =
      error instanceof TextConversationServiceError || error instanceof LlmRuntimeConfigError
        ? error.code
        : "SIMULATOR_TECHNICAL_ERROR";
    console.log(
      JSON.stringify({
        ok: false,
        error: {
          code,
          message: error instanceof Error ? error.message : "Erro técnico inesperado ao configurar o simulador.",
        },
      }),
    );
    process.exitCode = 1;
    return;
  }
  const { tools, sessionStore, conversationService, textService } = runtime;

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    const parsed = parseSimulatorLine(line);
    if (!parsed.ok) {
      console.log(JSON.stringify(parsed));
      continue;
    }

    try {
      if (parsed.value.kind === "command") {
        const sessionKey = buildAgentSessionKey(parsed.value.channel, parsed.value.contactId);
        const session = sessionStore.get(sessionKey) ?? null;
        console.log(JSON.stringify({ ok: true, session }));
        continue;
      }

      if (parsed.value.kind === "text") {
        const { channel, contactId, messageId, text } = parsed.value;

        // Toda a política de interpretação (contagem de não compreensão,
        // deduplicação, encaminhamento humano automático) mora no Text
        // Conversation Service — o simulador é só o adaptador de stdin/stdout,
        // sem duplicar nenhuma dessas regras aqui.
        const textResult = await textService.processText({ channel, contactId, messageId, text });

        if (!textResult.duplicateMessage && textResult.result?.event === "ORDER_CREATED") {
          await saveStoreFile(storePath, domainStore);
        }

        const debugContext = Boolean(process.env.BF_SIMULATOR_DEBUG_CONTEXT?.trim());
        let presentationContext: unknown;
        if (debugContext && textResult.result) {
          presentationContext = buildConversationPresentation({
            result: textResult.result,
            session: textResult.sessionAfter,
            tools,
          }).context;
        }
        console.log(
          JSON.stringify({
            ...textResult,
            ...(presentationContext !== undefined ? { presentationContext } : {}),
          }),
        );
        continue;
      }

      const { channel, contactId, messageId, action } = parsed.value;
      const serviceResult: AgentConversationServiceResult = conversationService.processAction({
        channel,
        contactId,
        messageId,
        action: action as never,
      });

      if (!serviceResult.duplicateMessage && serviceResult.result.event === "ORDER_CREATED") {
        await saveStoreFile(storePath, domainStore);
      }

      const presentation = buildConversationPresentation({
        result: serviceResult.result,
        session: serviceResult.sessionAfter,
        tools,
      });
      const messages = renderConversationPresentation(presentation);
      const debugContext = Boolean(process.env.BF_SIMULATOR_DEBUG_CONTEXT?.trim());
      console.log(
        JSON.stringify({
          ...serviceResult,
          messages,
          ...(debugContext ? { presentationContext: presentation.context } : {}),
        }),
      );
    } catch (error) {
      console.error(error);
      console.log(
        JSON.stringify({
          ok: false,
          error: { code: "SIMULATOR_TECHNICAL_ERROR", message: error instanceof Error ? error.message : "Erro técnico inesperado." },
        }),
      );
    }
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runSimulator().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
