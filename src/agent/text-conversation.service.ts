// Text Conversation Service — camada de política de conversa (Interpretation
// Policy) entre o Deterministic Message Interpreter e o Agent Conversation
// Service. O interpretador continua responsável apenas por converter texto
// em MATCHED/NOT_UNDERSTOOD/AMBIGUOUS; esta camada decide o que fazer com
// esse resultado: contagem de misunderstandingCount, deduplicação por
// messageId e encaminhamento humano automático ao atingir o limite. Não
// implementa IA, não chama API externa e não duplica as regras já
// implementadas pelo Conversation Service/Engine — apenas orquestra.
import type { AgentSession } from "./session.types.ts";
import type { AgentSessionStore } from "./session.store.ts";
import type { AgentTools } from "./tools.ts";
import type { AgentConversationResult } from "./conversation.types.ts";
import type { AgentConversationService } from "./conversation.service.ts";
import {
  interpretDeterministicMessage,
} from "./deterministic-interpreter.ts";
import type {
  DeterministicInterpretationResult,
  DeterministicInterpreterContext,
  InterpretDeterministicMessageInput,
} from "./interpreter.types.ts";
import { buildConversationPresentation } from "./presentation.ts";
import {
  renderConversationPresentation,
  renderTextConversationPolicyMessage,
  type AgentChatMessage,
} from "./renderer.ts";

export class TextConversationServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_MAX_MISUNDERSTANDINGS = 3;
const MIN_MAX_MISUNDERSTANDINGS = 1;
const MAX_MAX_MISUNDERSTANDINGS = 10;
const MAX_PUBLIC_SUGGESTIONS = 5;

export type TextConversationPolicyResult = {
  event: string;
  messageKey: string;
  data?: Record<string, unknown>;
};

export type BuildInterpreterContextFn = (input: {
  session: AgentSession;
  tools: AgentTools;
}) => DeterministicInterpreterContext;

export type InterpretMessageFn = (input: InterpretDeterministicMessageInput) => DeterministicInterpretationResult;

export type CreateTextConversationServiceDependencies = {
  conversationService: AgentConversationService;
  sessionStore: AgentSessionStore;
  tools: AgentTools;
  maxMisunderstandings?: number;
  interpretMessage?: InterpretMessageFn;
  buildInterpreterContext?: BuildInterpreterContextFn;
};

export type ProcessTextInput = {
  channel: string;
  contactId: string;
  messageId?: string;
  text: string;
};

export type ProcessTextResult = {
  sessionKey: string;
  duplicateMessage: boolean;
  interpretation?: DeterministicInterpretationResult;
  sessionBefore: AgentSession;
  sessionAfter: AgentSession;
  result?: AgentConversationResult;
  policyResult?: TextConversationPolicyResult;
  messages: AgentChatMessage[];
  policy: {
    misunderstandingCountBefore: number;
    misunderstandingCountAfter: number;
    handoffTriggered: boolean;
    counterReset: boolean;
  };
};

export type TextConversationService = {
  processText(input: ProcessTextInput): ProcessTextResult;
};

function validateMessageId(messageId: string | undefined): void {
  if (messageId === undefined) return;
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw new TextConversationServiceError(
      "invalid_message_id",
      "messageId deve ser uma string não vazia quando informado.",
    );
  }
}

function validateMaxMisunderstandings(value: number): void {
  if (!Number.isInteger(value) || value < MIN_MAX_MISUNDERSTANDINGS || value > MAX_MAX_MISUNDERSTANDINGS) {
    throw new TextConversationServiceError(
      "invalid_max_misunderstandings",
      `maxMisunderstandings deve ser um inteiro entre ${MIN_MAX_MISUNDERSTANDINGS} e ${MAX_MAX_MISUNDERSTANDINGS}.`,
    );
  }
}

function defaultBuildInterpreterContext(input: { tools: AgentTools }): DeterministicInterpreterContext {
  const { tools } = input;
  const products = tools.listProducts().map(product => ({
    id: product.id,
    name: product.name,
    description: product.description || undefined,
    price: product.basePrice,
    promotionalPrice: product.promotionalPrice ?? undefined,
  }));
  const business = tools.getBusiness();
  const seen = new Set<string>();
  const paymentOptions: string[] = [];
  for (const raw of business.paymentMethods) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    paymentOptions.push(trimmed);
  }
  return { products, paymentOptions, pickupSlots: tools.getPickupSlots() };
}

// Sugestões públicas de NOT_UNDERSTOOD: sem duplicadas, sem vazias, limitadas
// a um tamanho curto. Nunca inclui candidatos de AMBIGUOUS (esses carregam
// productId e nunca devem ser expostos).
function publicSuggestions(suggestions: string[] | undefined): string[] {
  if (!Array.isArray(suggestions)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of suggestions) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_PUBLIC_SUGGESTIONS) break;
  }
  return out;
}

export function createTextConversationService(
  deps: CreateTextConversationServiceDependencies,
): TextConversationService {
  if (!deps || !deps.conversationService || !deps.sessionStore || !deps.tools) {
    throw new TextConversationServiceError(
      "missing_dependencies",
      "conversationService, sessionStore e tools são obrigatórios para criar o Text Conversation Service.",
    );
  }
  const { conversationService, sessionStore, tools } = deps;
  const maxMisunderstandings = deps.maxMisunderstandings ?? DEFAULT_MAX_MISUNDERSTANDINGS;
  validateMaxMisunderstandings(maxMisunderstandings);
  const interpretMessage = deps.interpretMessage ?? interpretDeterministicMessage;
  const buildInterpreterContext = deps.buildInterpreterContext ?? defaultBuildInterpreterContext;

  return {
    processText(input: ProcessTextInput): ProcessTextResult {
      const { channel, contactId, messageId, text } = input;
      validateMessageId(messageId);

      const sessionBeforeRaw = sessionStore.getOrCreate({ channel, contactId });
      const sessionKey = sessionBeforeRaw.sessionKey;
      const sessionBefore = structuredClone(sessionBeforeRaw);
      const misunderstandingCountBefore = sessionBefore.misunderstandingCount;

      if (messageId && sessionStore.hasProcessedMessage(sessionKey, messageId)) {
        const policyResult: TextConversationPolicyResult = {
          event: "MESSAGE_ALREADY_PROCESSED",
          messageKey: "MESSAGE_ALREADY_PROCESSED",
          data: { messageId },
        };
        return {
          sessionKey,
          duplicateMessage: true,
          sessionBefore,
          sessionAfter: structuredClone(sessionBefore),
          policyResult,
          messages: [],
          policy: {
            misunderstandingCountBefore,
            misunderstandingCountAfter: misunderstandingCountBefore,
            handoffTriggered: false,
            counterReset: false,
          },
        };
      }

      const context = buildInterpreterContext({ session: sessionBefore, tools });
      const interpretation = interpretMessage({ text, session: sessionBefore, context });

      if (interpretation.status === "MATCHED") {
        const serviceResult = conversationService.processAction({
          channel,
          contactId,
          messageId,
          action: interpretation.action,
        });

        const engineResult = serviceResult.result;
        const isInvalidAction = engineResult.messageKey === "INVALID_ACTION";
        let sessionAfter = serviceResult.sessionAfter;
        const counterReset = !isInvalidAction;

        if (counterReset && sessionAfter.misunderstandingCount !== 0) {
          sessionAfter = sessionStore.update(sessionKey, current => ({ ...current, misunderstandingCount: 0 }));
        }

        const presentation = buildConversationPresentation({ result: engineResult, session: sessionAfter, tools });
        const messages = renderConversationPresentation(presentation);

        return {
          sessionKey,
          duplicateMessage: false,
          interpretation,
          sessionBefore,
          sessionAfter,
          result: { ...engineResult, session: structuredClone(sessionAfter) },
          messages,
          policy: {
            misunderstandingCountBefore,
            misunderstandingCountAfter: sessionAfter.misunderstandingCount,
            handoffTriggered: false,
            counterReset,
          },
        };
      }

      // NOT_UNDERSTOOD ou AMBIGUOUS a partir daqui.

      // A própria sessão já está em atendimento humano e o interpretador
      // sinalizou isso (único caminho que produz essa reason) — mensagem
      // comum durante handoff ativo: não incrementa, não chama o Engine, só
      // registra o messageId (deduplicação) e devolve uma resposta segura.
      if (interpretation.status === "NOT_UNDERSTOOD" && interpretation.reason === "HUMAN_HANDOFF_ACTIVE") {
        if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
        const sessionAfter = structuredClone(sessionStore.get(sessionKey)!);
        const policyResult: TextConversationPolicyResult = {
          event: "HUMAN_HANDOFF_ACTIVE",
          messageKey: "HUMAN_HANDOFF_ACTIVE",
        };
        return {
          sessionKey,
          duplicateMessage: false,
          interpretation,
          sessionBefore,
          sessionAfter,
          policyResult,
          messages: renderTextConversationPolicyMessage(policyResult),
          policy: {
            misunderstandingCountBefore,
            misunderstandingCountAfter: misunderstandingCountBefore,
            handoffTriggered: false,
            counterReset: false,
          },
        };
      }

      const newCount = misunderstandingCountBefore + 1;
      const handoffTriggered = newCount >= maxMisunderstandings;

      let sessionAfter = sessionStore.update(sessionKey, current => ({ ...current, misunderstandingCount: newCount }));

      if (handoffTriggered) {
        // REQUEST_HUMAN sem messageId: o messageId original só é registrado
        // depois do handoff ter sucesso, para nunca marcar a mensagem como
        // processada sem o encaminhamento realmente ter ocorrido.
        const handoffResult = conversationService.processAction({ channel, contactId, action: { type: "REQUEST_HUMAN" } });
        sessionAfter = handoffResult.sessionAfter;
      }

      if (messageId) {
        sessionStore.markMessageProcessed(sessionKey, messageId);
        sessionAfter = sessionStore.get(sessionKey)!;
      }
      sessionAfter = structuredClone(sessionAfter);

      const remainingAttempts = Math.max(maxMisunderstandings - newCount, 0);
      const suggestions =
        interpretation.status === "NOT_UNDERSTOOD" ? publicSuggestions(interpretation.suggestions) : [];

      const policyResult: TextConversationPolicyResult = handoffTriggered
        ? { event: "HUMAN_HANDOFF_AUTOMATIC", messageKey: "HUMAN_HANDOFF_AUTOMATIC", data: { misunderstandingCount: newCount } }
        : interpretation.status === "AMBIGUOUS"
          ? { event: "INTERPRETATION_AMBIGUOUS", messageKey: "INTERPRETATION_AMBIGUOUS", data: { misunderstandingCount: newCount } }
          : {
              event: "INTERPRETATION_NOT_UNDERSTOOD",
              messageKey: "INTERPRETATION_NOT_UNDERSTOOD",
              data: { misunderstandingCount: newCount, remainingAttempts, suggestions },
            };

      return {
        sessionKey,
        duplicateMessage: false,
        interpretation,
        sessionBefore,
        sessionAfter,
        policyResult,
        messages: renderTextConversationPolicyMessage(policyResult),
        policy: {
          misunderstandingCountBefore,
          misunderstandingCountAfter: newCount,
          handoffTriggered,
          counterReset: false,
        },
      };
    },
  };
}
