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
import { buildAgentSessionKey } from "./session.store.ts";
import type { AgentTools } from "./tools.ts";
import type { AgentConversationAction, AgentConversationResult } from "./conversation.types.ts";
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
import { isLlmFallbackEligible } from "./llm-eligibility.ts";
import type { LlmInterpreter, LlmInterpretationResult, InterpretLlmMessageInput } from "./llm-interpreter.types.ts";
import { executeConversationActionBatch } from "./conversation-action-batch.ts";

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

const DEFAULT_LLM_MODE = "DISABLED" as const;
const DEFAULT_MAX_LLM_INPUT_LENGTH = 1000;
const MIN_MAX_LLM_INPUT_LENGTH = 50;
const MAX_MAX_LLM_INPUT_LENGTH = 10_000;

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

export type InterpretWithLlmFn = (input: InterpretLlmMessageInput) => Promise<LlmInterpretationResult>;

export type CreateTextConversationServiceDependencies = {
  conversationService: AgentConversationService;
  sessionStore: AgentSessionStore;
  tools: AgentTools;
  maxMisunderstandings?: number;
  interpretMessage?: InterpretMessageFn;
  buildInterpreterContext?: BuildInterpreterContextFn;
  llmInterpreter?: LlmInterpreter;
  interpretWithLlm?: InterpretWithLlmFn;
  llmMode?: "DISABLED" | "FALLBACK";
  maxLlmInputLength?: number;
};

export type ProcessTextInput = {
  channel: string;
  contactId: string;
  messageId?: string;
  text: string;
};

export type TextConversationInterpretationSummary = {
  deterministic: DeterministicInterpretationResult;
  llm?: LlmInterpretationResult;
  finalSource: "DETERMINISTIC" | "LLM" | "POLICY";
};

export type TextConversationExecutionSummary = {
  mode: "SINGLE_ACTION" | "ACTION_BATCH";
  actionCount: number;
  completedActionCount: number;
  preflightPassed?: boolean;
  failedActionIndex?: number;
};

export type ProcessTextResult = {
  sessionKey: string;
  duplicateMessage: boolean;
  interpretation?: TextConversationInterpretationSummary;
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
    technicalFailure?: boolean;
  };
  execution?: TextConversationExecutionSummary;
};

export type TextConversationService = {
  processText(input: ProcessTextInput): Promise<ProcessTextResult>;
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

function validateLlmMode(value: string): void {
  if (value !== "DISABLED" && value !== "FALLBACK") {
    throw new TextConversationServiceError("invalid_llm_mode", 'llmMode deve ser "DISABLED" ou "FALLBACK".');
  }
}

function validateMaxLlmInputLength(value: number): void {
  if (!Number.isInteger(value) || value < MIN_MAX_LLM_INPUT_LENGTH || value > MAX_MAX_LLM_INPUT_LENGTH) {
    throw new TextConversationServiceError(
      "invalid_max_llm_input_length",
      `maxLlmInputLength deve ser um inteiro entre ${MIN_MAX_LLM_INPUT_LENGTH} e ${MAX_MAX_LLM_INPUT_LENGTH}.`,
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

// O LLM Interpreter e o Output Validator carregam campos nunca pensados para
// sair do processo: o `reason` de um resultado REJECTED traz motivos
// técnicos internos de validação (ação proibida, produto/horário/pagamento
// alucinado, lote inválido, schema inválido etc.), `promptVersion` é detalhe
// de infraestrutura do provider, e os `candidates` de AMBIGUOUS carregam
// AgentConversationAction com productId interno. Diferente de NOT_UNDERSTOOD,
// cujo `reason` já é uma categoria pensada para uso público/observabilidade
// (ex.: "GENERIC"), REJECTED e os candidatos de AMBIGUOUS nunca devem
// aparecer no ProcessTextResult devolvido ao chamador — construímos objetos
// estreitos em vez de espalhar (`...outcome`) para nunca deixar um campo novo
// vazar por acidente quando o tipo evoluir.
function sanitizeLlmOutcomeForResult(outcome: LlmInterpretationResult): LlmInterpretationResult {
  if (outcome.status === "REJECTED") {
    return {
      status: "REJECTED",
      source: outcome.source,
      reason: "REJECTED_BY_VALIDATOR",
      durationMs: outcome.durationMs,
    } as LlmInterpretationResult;
  }
  if (outcome.status === "AMBIGUOUS") {
    return {
      status: "AMBIGUOUS",
      reason: outcome.reason,
      source: outcome.source,
      promptVersion: outcome.promptVersion,
      durationMs: outcome.durationMs,
    };
  }
  return outcome;
}

// Aplica uma única ação estruturada (determinística ou vinda do LLM) ao
// Conversation Service e resolve o zeramento do contador de não compreensão.
// Reusado tanto pelo caminho determinístico MATCHED quanto pelo caminho de
// fallback do LLM MATCHED com uma única ação — nunca duplicado entre os dois.
function applySingleAction(params: {
  conversationService: AgentConversationService;
  sessionStore: AgentSessionStore;
  channel: string;
  contactId: string;
  messageId: string | undefined;
  sessionKey: string;
  action: AgentConversationAction;
}): { engineResult: AgentConversationResult; sessionAfter: AgentSession; counterReset: boolean } {
  const { conversationService, sessionStore, channel, contactId, messageId, sessionKey, action } = params;
  const serviceResult = conversationService.processAction({ channel, contactId, messageId, action });
  const engineResult = serviceResult.result;
  const isInvalidAction = engineResult.messageKey === "INVALID_ACTION";
  let sessionAfter = serviceResult.sessionAfter;
  const counterReset = !isInvalidAction;
  if (counterReset && sessionAfter.misunderstandingCount !== 0) {
    sessionAfter = sessionStore.update(sessionKey, current => ({ ...current, misunderstandingCount: 0 }));
  }
  return { engineResult, sessionAfter, counterReset };
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

  const llmMode = deps.llmMode ?? DEFAULT_LLM_MODE;
  validateLlmMode(llmMode);
  const maxLlmInputLength = deps.maxLlmInputLength ?? DEFAULT_MAX_LLM_INPUT_LENGTH;
  validateMaxLlmInputLength(maxLlmInputLength);
  const interpretWithLlm: InterpretWithLlmFn | undefined =
    deps.interpretWithLlm ?? (deps.llmInterpreter ? input => deps.llmInterpreter!.interpret(input) : undefined);
  const llmEnabled = llmMode === "FALLBACK" && typeof interpretWithLlm === "function";

  const sessionLocks = new Map<string, Promise<unknown>>();

  // Mutex local por sessionKey — só serializa chamadas dentro deste
  // processo/instância (Map em closure, não é singleton global nem promete
  // proteção distribuída). Uma falha em fn() não trava a fila: a próxima
  // aquisição roda normalmente porque `tracked` engole o erro só para fins
  // de encadeamento, enquanto `run` (devolvido ao chamador) preserva o erro.
  // `run.finally(...)` devolve uma nova promise que adota a rejeição de
  // `run` — como `run` já é entregue (e tratado) pelo chamador, essa segunda
  // promise fica sem handler próprio e o Node reporta unhandledRejection se
  // não for silenciada aqui; o `.catch(() => {})` no fim só evita esse aviso
  // espúrio, sem alterar o valor/erro devolvido por `run`.
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
    async processText(input: ProcessTextInput): Promise<ProcessTextResult> {
      const { channel, contactId, messageId, text } = input;
      validateMessageId(messageId);
      const sessionKey = buildAgentSessionKey(channel, contactId);

      return withSessionLock(sessionKey, async () => {
      const sessionBeforeRaw = sessionStore.getOrCreate({ channel, contactId });
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
        const { engineResult, sessionAfter, counterReset } = applySingleAction({
          conversationService, sessionStore, channel, contactId, messageId, sessionKey, action: interpretation.action,
        });
        const presentation = buildConversationPresentation({ result: engineResult, session: sessionAfter, tools });
        const messages = renderConversationPresentation(presentation);

        return {
          sessionKey,
          duplicateMessage: false,
          interpretation: { deterministic: interpretation, finalSource: "DETERMINISTIC" },
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
          interpretation: { deterministic: interpretation, finalSource: "POLICY" },
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

      let llmOutcome: LlmInterpretationResult | undefined;
      if (llmEnabled) {
        const eligibility = isLlmFallbackEligible({
          deterministicResult: interpretation,
          session: sessionBefore,
          text,
          maxLlmInputLength,
        });
        if (eligibility.eligible) {
          llmOutcome = await interpretWithLlm!({ text, session: sessionBefore, context, deterministicResult: interpretation });
        }
      }

      if (llmOutcome?.status === "PROVIDER_ERROR") {
        const sessionAfterUnchanged = structuredClone(sessionStore.get(sessionKey)!);
        const policyResult: TextConversationPolicyResult = {
          event: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
          messageKey: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
        };
        return {
          sessionKey,
          duplicateMessage: false,
          interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "POLICY" },
          sessionBefore,
          sessionAfter: sessionAfterUnchanged,
          policyResult,
          messages: renderTextConversationPolicyMessage(policyResult),
          policy: {
            misunderstandingCountBefore,
            misunderstandingCountAfter: misunderstandingCountBefore,
            handoffTriggered: false,
            counterReset: false,
            technicalFailure: true,
          },
        };
      }

      if (llmOutcome?.status === "MATCHED" && llmOutcome.actions.length === 1) {
        const { engineResult, sessionAfter, counterReset } = applySingleAction({
          conversationService, sessionStore, channel, contactId, messageId, sessionKey, action: llmOutcome.actions[0]!,
        });
        const presentation = buildConversationPresentation({ result: engineResult, session: sessionAfter, tools });
        const messages = renderConversationPresentation(presentation);
        return {
          sessionKey,
          duplicateMessage: false,
          interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "LLM" },
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

      let batchResult: ReturnType<typeof executeConversationActionBatch> | undefined;
      if (llmOutcome?.status === "MATCHED" && llmOutcome.actions.length > 1) {
        batchResult = executeConversationActionBatch({
          conversationService, channel, contactId, session: sessionBefore, actions: llmOutcome.actions, tools,
        });

        if (batchResult.status === "COMPLETED") {
          const lastResult = batchResult.results[batchResult.results.length - 1]!;
          let sessionAfter = batchResult.sessionAfter;
          if (sessionAfter.misunderstandingCount !== 0) {
            sessionAfter = sessionStore.update(sessionKey, current => ({ ...current, misunderstandingCount: 0 }));
          }
          if (messageId) {
            sessionStore.markMessageProcessed(sessionKey, messageId);
            sessionAfter = sessionStore.get(sessionKey)!;
          }
          sessionAfter = structuredClone(sessionAfter);
          const presentation = buildConversationPresentation({ result: lastResult.result, session: sessionAfter, tools });
          const messages = renderConversationPresentation(presentation);
          return {
            sessionKey,
            duplicateMessage: false,
            interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "LLM" },
            sessionBefore,
            sessionAfter,
            result: { ...lastResult.result, session: structuredClone(sessionAfter) },
            messages,
            policy: {
              misunderstandingCountBefore,
              misunderstandingCountAfter: sessionAfter.misunderstandingCount,
              handoffTriggered: false,
              counterReset: true,
            },
            execution: {
              mode: "ACTION_BATCH",
              actionCount: llmOutcome.actions.length,
              completedActionCount: batchResult.results.length,
              preflightPassed: true,
            },
          };
        }

        if (batchResult.status === "FAILED") {
          const policyResult: TextConversationPolicyResult = {
            event: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
            messageKey: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
          };
          return {
            sessionKey,
            duplicateMessage: false,
            interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "POLICY" },
            sessionBefore,
            sessionAfter: structuredClone(sessionStore.get(sessionKey)!),
            policyResult,
            messages: renderTextConversationPolicyMessage(policyResult),
            policy: {
              misunderstandingCountBefore,
              misunderstandingCountAfter: misunderstandingCountBefore,
              handoffTriggered: false,
              counterReset: false,
              technicalFailure: true,
            },
            execution: {
              mode: "ACTION_BATCH",
              actionCount: llmOutcome.actions.length,
              // `batchResult.results.length` inclui o resultado da própria ação
              // que falhou (executeConversationActionBatch empurra o resultado
              // antes de checar se é falha), então usar esse length aqui
              // contaria a ação que falhou como "completada". failedActionIndex
              // já é o índice (0-based) da ação que falhou, então o número de
              // ações que de fato tiveram sucesso é exatamente esse índice.
              completedActionCount: batchResult.failedActionIndex ?? 0,
              preflightPassed: true,
              failedActionIndex: batchResult.failedActionIndex,
            },
          };
        }
        // batchResult.status === "REJECTED": cai no bloco de falha de
        // compreensão abaixo (mesma mensagem/incremento de uma falha comum).
      }

      const failure: { status: "NOT_UNDERSTOOD" | "AMBIGUOUS"; suggestions: string[] } =
        llmOutcome?.status === "NOT_UNDERSTOOD"
          ? { status: "NOT_UNDERSTOOD", suggestions: publicSuggestions(llmOutcome.suggestions) }
          : llmOutcome?.status === "AMBIGUOUS"
            ? { status: "AMBIGUOUS", suggestions: [] }
            : interpretation.status === "AMBIGUOUS"
              ? { status: "AMBIGUOUS", suggestions: [] }
              : { status: "NOT_UNDERSTOOD", suggestions: publicSuggestions(interpretation.suggestions) };

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

      const policyResult: TextConversationPolicyResult = handoffTriggered
        ? { event: "HUMAN_HANDOFF_AUTOMATIC", messageKey: "HUMAN_HANDOFF_AUTOMATIC", data: { misunderstandingCount: newCount } }
        : failure.status === "AMBIGUOUS"
          ? { event: "INTERPRETATION_AMBIGUOUS", messageKey: "INTERPRETATION_AMBIGUOUS", data: { misunderstandingCount: newCount } }
          : {
              event: "INTERPRETATION_NOT_UNDERSTOOD",
              messageKey: "INTERPRETATION_NOT_UNDERSTOOD",
              data: { misunderstandingCount: newCount, remainingAttempts, suggestions: failure.suggestions },
            };

      return {
        sessionKey,
        duplicateMessage: false,
        interpretation: {
          deterministic: interpretation,
          ...(llmOutcome ? { llm: sanitizeLlmOutcomeForResult(llmOutcome) } : {}),
          finalSource: "POLICY",
        },
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
        ...(batchResult?.status === "REJECTED"
          ? {
              execution: {
                mode: "ACTION_BATCH" as const,
                actionCount: llmOutcome!.status === "MATCHED" ? llmOutcome!.actions.length : 0,
                completedActionCount: 0,
                preflightPassed: false,
                failedActionIndex: batchResult.failedActionIndex,
              },
            }
          : {}),
      };
      });
    },
  };
}
