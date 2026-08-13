// Text Conversation Service — camada de política de conversa (Interpretation
// Policy) entre o Deterministic Message Interpreter e o Agent Conversation
// Service. O interpretador continua responsável apenas por converter texto
// em MATCHED/NOT_UNDERSTOOD/AMBIGUOUS; esta camada decide o que fazer com
// esse resultado: contagem de misunderstandingCount, deduplicação por
// messageId e encaminhamento humano automático ao atingir o limite. Não
// implementa IA, não chama API externa e não duplica as regras já
// implementadas pelo Conversation Service/Engine — apenas orquestra.
import { randomUUID } from "node:crypto";
import type { AgentSession, AgentShortHistoryEntry } from "./session.types.ts";
import type { AgentSessionStore } from "./session.store.ts";
import { buildAgentSessionKey } from "./session.store.ts";
import type { AgentTools } from "./tools.ts";
import type { AgentConversationAction, AgentConversationResult } from "./conversation.types.ts";
import type { AgentConversationService } from "./conversation.service.ts";
import {
  interpretDeterministicMessage,
  normalizeInterpreterText,
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
import {
  isLlmFallbackEligible,
  DEFAULT_MAX_LLM_INPUT_LENGTH,
  MIN_MAX_LLM_INPUT_LENGTH,
  MAX_MAX_LLM_INPUT_LENGTH,
} from "./llm-eligibility.ts";
import type {
  LlmInterpreter,
  LlmInterpretationResult,
  LlmInterpretationMatched,
  LlmInterpretationNotUnderstood,
  LlmInterpretationAmbiguous,
  LlmInterpretationRejected,
  LlmInterpretationProviderError,
  InterpretLlmMessageInput,
} from "./llm-interpreter.types.ts";
import { executeConversationActionBatch, isFailureResult } from "./conversation-action-batch.ts";
import { resolveFactualIntent } from "./factual-intent.ts";
import type { OperatingStatus } from "./operating-status.ts";
import { WEEKDAY_LABELS_PT_BR, formatTimeBR } from "../lib/business-hours.ts";
import { buildAllowedFacts } from "./allowed-facts.ts";
import { decideRenderStrategy } from "./response-strategy-policy.ts";
import { computePlanningFailureFallback } from "./planning-failure-fallback.ts";
import { validateResponseText } from "./response-text-validator.ts";
import { appendShortHistory, appendShortHistoryTurn } from "./short-history.ts";
import { MESSAGE_CATALOG } from "./messages.ts";
import type {
  AllowedFact,
  ResponseIntent,
  VerbalizationRequest,
  VerbalizationResult,
} from "./conversation-intelligence.types.ts";
import { LLM_VERBALIZER_PROMPT_VERSION } from "./llm-verbalizer-prompt.ts";

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
// Sugestões do caminho determinístico são sempre curtas (nome de forma de
// pagamento, horário de retirada); esse teto mantém as do LLM na mesma escala.
const MAX_PUBLIC_SUGGESTION_LENGTH = 60;

const DEFAULT_LLM_MODE = "DISABLED" as const;

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

export type VerbalizeWithLlmFn = (request: VerbalizationRequest) => Promise<VerbalizationResult>;

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
  // BF_VERBALIZATION_MODE=DISABLED|ENABLED (padrão DISABLED). Só tem efeito
  // quando llmMode === "FALLBACK" e verbalizeWithLlm/llmVerbalizer estão
  // presentes — com DISABLED (ou ausente), o comportamento é idêntico ao de
  // antes desta funcionalidade: sempre template.
  verbalizationMode?: "DISABLED" | "ENABLED";
  verbalizeWithLlm?: VerbalizeWithLlmFn;
  now?: () => Date;
};

export type ProcessTextInput = {
  channel: string;
  contactId: string;
  messageId?: string;
  text: string;
};

// `llm` nunca é o LlmInterpretationResult cru: é sempre a forma já reduzida
// por sanitizeLlmOutcomeForResult() (ver PublicLlmInterpretationResult, mais
// abaixo). Tipar como o resultado completo prometeria ao chamador campos que
// esta camada remove de propósito.
export type TextConversationInterpretationSummary = {
  deterministic: DeterministicInterpretationResult;
  llm?: PublicLlmInterpretationResult;
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

// Formas que uma opção sugerida nunca tem numa conversa de pedido — telefone
// (4+ dígitos seguidos), URL e handle de contato. Uma sugestão com qualquer
// uma delas é descartada inteira (nunca truncada e mantida): truncar poderia
// deixar metade de um link ou de um número de contato na mensagem.
const UNSAFE_SUGGESTION_PATTERN = /\d{4,}|http|www\.|@/i;

// Sugestões públicas de NOT_UNDERSTOOD: sem duplicadas, sem vazias, curtas e
// sem conteúdo com cara de contato/link. Nunca inclui candidatos de AMBIGUOUS
// (esses carregam productId e nunca devem ser expostos).
//
// Este é o único ponto do fallback em que texto livre gerado pelo modelo chega
// ao cliente com a voz da marca: toda *ação* proposta é conferida contra o
// catálogo real, mas as sugestões não passam por nenhuma dessas barreiras. Por
// isso o filtro é por forma (tamanho e padrão), não por confiança na origem —
// vale igualmente para as sugestões determinísticas, que já respeitam esses
// limites naturalmente.
function publicSuggestions(suggestions: string[] | undefined): string[] {
  if (!Array.isArray(suggestions)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of suggestions) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (trimmed.length > MAX_PUBLIC_SUGGESTION_LENGTH) continue;
    if (UNSAFE_SUGGESTION_PATTERN.test(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_PUBLIC_SUGGESTIONS) break;
  }
  return out;
}

function explicitlyRequestsHuman(text: string): boolean {
  const normalized = normalizeInterpreterText(text);
  if (new Set([
    "atendente", "atendimento humano", "falar com atendente",
    "falar com uma pessoa", "humano", "suporte",
  ]).has(normalized)) return true;
  return /^(?:quero|gostaria|preciso|posso|pode).*(?:falar|conversar).*(?:pessoa|alguem|atendente|humano)/.test(normalized);
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
//
// O tipo de retorno é declarado (nunca um `as`): sem ele, um `as` desligaria
// justamente a checagem de excesso de propriedades que faz o compilador
// reclamar quando alguém acrescenta um campo novo — a única barreira
// automática da função cujo trabalho inteiro é evitar vazamento.
// Cada branch devolve um destes tipos estreitos anotado explicitamente, para
// que a checagem de excesso de propriedades valha por branch (e não só contra
// a união inteira, que aceitaria um campo de qualquer outro membro).
type PublicLlmMatchedWithoutPromptVersion = Omit<LlmInterpretationMatched, "promptVersion"> & {
  promptVersion?: never;
};
type PublicLlmAmbiguous = Omit<LlmInterpretationAmbiguous, "candidates"> & { candidates?: never };
type PublicLlmRejected = Omit<LlmInterpretationRejected, "promptVersion"> & { promptVersion?: never };
type PublicLlmProviderError = Omit<LlmInterpretationProviderError, "reason"> & {
  reason: "TIMEOUT" | "PROVIDER_REJECTED";
};

export type PublicLlmInterpretationResult =
  | LlmInterpretationMatched
  | PublicLlmMatchedWithoutPromptVersion
  | LlmInterpretationNotUnderstood
  | PublicLlmAmbiguous
  | PublicLlmRejected
  | PublicLlmProviderError;

// Reasons vindos do modelo nunca são públicos: o modelo pode ecoar prompt,
// mensagem do usuário ou dados da sessão. O consumidor recebe só códigos
// constantes, suficientes para distinguir o tipo de resultado sem propagar
// texto livre do provider.
type LlmOutcomeWithReason = Exclude<LlmInterpretationResult, LlmInterpretationMatched>;

function sanitizePublicLlmReason(outcome: LlmInterpretationNotUnderstood): "LLM_NOT_UNDERSTOOD";
function sanitizePublicLlmReason(outcome: LlmInterpretationAmbiguous): "LLM_AMBIGUOUS";
function sanitizePublicLlmReason(outcome: LlmInterpretationRejected): "REJECTED_BY_VALIDATOR";
function sanitizePublicLlmReason(outcome: LlmInterpretationProviderError): "TIMEOUT" | "PROVIDER_REJECTED";
function sanitizePublicLlmReason(
  outcome: LlmOutcomeWithReason,
): "LLM_NOT_UNDERSTOOD" | "LLM_AMBIGUOUS" | "REJECTED_BY_VALIDATOR" | "TIMEOUT" | "PROVIDER_REJECTED" {
  if (outcome.status === "NOT_UNDERSTOOD") return "LLM_NOT_UNDERSTOOD";
  if (outcome.status === "AMBIGUOUS") return "LLM_AMBIGUOUS";
  if (outcome.status === "REJECTED") return "REJECTED_BY_VALIDATOR";
  return outcome.reason === "TIMEOUT" ? "TIMEOUT" : "PROVIDER_REJECTED";
}

// `stripPromptVersion` é usado quando o resultado MATCHED é apenas contexto de
// um lote que não completou (REJECTED no preflight ou FAILED na execução):
// nesse caso `actions` continua necessário para ler `execution.failedActionIndex`
// (que indexa nele), mas `promptVersion` não serve a nada para o chamador. Uma
// ação MATCHED que de fato executou mantém o `promptVersion` — comportamento
// já estabelecido, deliberadamente não alterado aqui.
function sanitizeLlmOutcomeForResult(
  outcome: LlmInterpretationResult,
  options?: { stripPromptVersion?: boolean },
): PublicLlmInterpretationResult {
  if (outcome.status === "REJECTED") {
    const sanitized: PublicLlmRejected = {
      status: "REJECTED",
      source: outcome.source,
      reason: sanitizePublicLlmReason(outcome),
      durationMs: outcome.durationMs,
    };
    return sanitized;
  }
  if (outcome.status === "AMBIGUOUS") {
    const sanitized: PublicLlmAmbiguous = {
      status: "AMBIGUOUS",
      reason: sanitizePublicLlmReason(outcome),
      source: outcome.source,
      promptVersion: outcome.promptVersion,
      durationMs: outcome.durationMs,
    };
    return sanitized;
  }
  if (outcome.status === "NOT_UNDERSTOOD") {
    return {
      status: "NOT_UNDERSTOOD",
      reason: sanitizePublicLlmReason(outcome),
      ...(outcome.suggestions ? { suggestions: outcome.suggestions } : {}),
      source: outcome.source,
      promptVersion: outcome.promptVersion,
      durationMs: outcome.durationMs,
    };
  }
  if (outcome.status === "PROVIDER_ERROR") {
    const sanitized: PublicLlmProviderError = {
      status: "PROVIDER_ERROR",
      reason: sanitizePublicLlmReason(outcome),
      retryable: outcome.retryable,
      promptVersion: outcome.promptVersion,
      durationMs: outcome.durationMs,
    };
    return sanitized;
  }
  if (outcome.status === "MATCHED" && options?.stripPromptVersion) {
    const sanitized: PublicLlmMatchedWithoutPromptVersion = {
      status: "MATCHED",
      actions: outcome.actions,
      source: outcome.source,
      ...(outcome.explanationCode !== undefined ? { explanationCode: outcome.explanationCode } : {}),
      durationMs: outcome.durationMs,
    };
    return sanitized;
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
  // Só um resultado que o Engine NÃO recusou conta como compreensão bem
  // sucedida. O predicado vem de conversation-action-batch.ts porque lá mora a
  // lista autoritativa de messageKeys de recusa (INVALID_ACTION, CART_EMPTY,
  // PAYMENT_METHOD_UNAVAILABLE etc.) — reconhecer só INVALID_ACTION aqui
  // zerava o contador numa ação recusada e apagava o progresso rumo ao handoff
  // automático. Vale igual para o caminho determinístico e para o do LLM.
  let sessionAfter = serviceResult.sessionAfter;
  const counterReset = !isFailureResult(engineResult);
  if (counterReset && sessionAfter.misunderstandingCount !== 0) {
    sessionAfter = sessionStore.update(sessionKey, current => ({ ...current, misunderstandingCount: 0 }));
  }
  return { engineResult, sessionAfter, counterReset };
}

// Grava o messageKey da última mensagem efetivamente enviada ao cliente
// nesta sessão (AgentSession.lastMessageKey) — hoje só consumido pela
// guarda de repetição de SHOW_MENU/MENU_READY (ver processText), mas
// deliberadamente genérico: reflete a última mensagem de qualquer turno,
// não só SHOW_MENU. Roda sempre como a última operação de sessão do turno,
// ainda dentro do lock (withSessionLock), para nunca sobrescrever com um
// valor desatualizado o resultado de um turno concorrente mais recente.
// Sem mensagem nova de fato enviada (duplicata deduplicada, messages
// vazio) não há o que gravar.
function recordLastMessageKey(
  sessionStore: AgentSessionStore,
  sessionKey: string,
  result: ProcessTextResult,
): ProcessTextResult {
  if (result.duplicateMessage || result.messages.length === 0) return result;
  const messageKey = result.result?.messageKey ?? result.policyResult?.messageKey;
  if (!messageKey || result.sessionAfter.lastMessageKey === messageKey) return result;
  const updated = sessionStore.update(sessionKey, current => ({ ...current, lastMessageKey: messageKey }));
  return { ...result, sessionAfter: structuredClone(updated) };
}

// Traduz o OperatingStatus já calculado (relógio real, America/Fortaleza) no
// messageKey/dados certos — nunca o inverso: o texto nunca decide o estado,
// só o exibe. Cobre os quatro casos pedidos (aberto, fechado hoje, fechado
// em outro dia, sem cadastro) mais o caso residual sem próxima abertura
// nenhuma (todos os dias fechados), que nunca deve travar/lançar.
function pickupAvailabilityPolicyResult(status: OperatingStatus): TextConversationPolicyResult {
  if (!status.known) {
    return { event: "BUSINESS_PICKUP_HOURS_UNAVAILABLE", messageKey: "BUSINESS_PICKUP_HOURS_UNAVAILABLE" };
  }
  if (status.isOpenNow) {
    return { event: "BUSINESS_OPEN_NOW", messageKey: "BUSINESS_OPEN_NOW", data: { closeTime: formatTimeBR(status.currentClose!) } };
  }
  if (!status.nextOpen) {
    return { event: "BUSINESS_CLOSED_NO_NEXT_OPEN", messageKey: "BUSINESS_CLOSED_NO_NEXT_OPEN" };
  }
  if (status.nextOpen.sameDay) {
    return { event: "BUSINESS_CLOSED_TODAY", messageKey: "BUSINESS_CLOSED_TODAY", data: { nextOpenTime: formatTimeBR(status.nextOpen.time) } };
  }
  return {
    event: "BUSINESS_CLOSED_OTHER_DAY",
    messageKey: "BUSINESS_CLOSED_OTHER_DAY",
    data: { weekday: WEEKDAY_LABELS_PT_BR[status.nextOpen.weekday], nextOpenTime: formatTimeBR(status.nextOpen.time) },
  };
}

function llmRecoveryKind(session: AgentSession): "START" | "ORDER" {
  return session.step === "START" || session.step === "BROWSING_MENU" ? "START" : "ORDER";
}

// Palavras que indicam um pedido explícito de ver o cardápio/opções — usadas
// só como exceção à guarda de repetição de SHOW_MENU (ver mais abaixo). Não
// tenta ser uma lista exaustiva de todo jeito de pedir isso: um falso
// negativo aqui (frase que pede de novo sem usar nenhuma destas palavras) só
// custa um turno extra de esclarecimento, o mesmo fallback que já existe
// para qualquer mensagem não compreendida. "cardapio"/"menu"/"sabores" já são
// interceptadas antes mesmo de chegar aqui por resolveFactualIntent — ficam
// na lista só para cobrir o caso raro em que outra palavra-chave factual
// (ex.: pergunta de horário) tem precedência sobre elas na mesma mensagem.
const MENU_REQUEST_CUE_WORDS = new Set(["cardapio", "menu", "sabores", "opcoes", "novo", "novamente"]);

function mentionsMenuRequestCue(text: string): boolean {
  const words = normalizeInterpreterText(text).split(" ").filter(Boolean);
  return words.some(word => MENU_REQUEST_CUE_WORDS.has(word));
}

const DEFAULT_CONFIRM_RESPONSE_INTENT: ResponseIntent = { kind: "CONFIRM_ACTION_RESULT" };

const MAX_HANDOFF_PENDING_QUESTION_LENGTH = 140;

// Resumo sanitizado anexado ao evento de encaminhamento humano (automático
// ou por intenção REQUEST_HUMAN) — nunca token, telefone completo ou payload
// bruto, nunca promete tempo de resposta. Só o essencial para o atendente
// retomar o contexto: intenção, itens do carrinho e a última pergunta.
export type HandoffSummary = {
  intent: string;
  cartItemCount: number;
  pendingQuestion: string;
};

function buildHandoffSummary(input: { session: AgentSession; intent: string; lastCustomerMessage: string }): HandoffSummary {
  const trimmed = typeof input.lastCustomerMessage === "string" ? input.lastCustomerMessage.trim() : "";
  return {
    intent: input.intent,
    cartItemCount: input.session.items.reduce((sum, item) => sum + item.quantity, 0),
    pendingQuestion: trimmed.length > MAX_HANDOFF_PENDING_QUESTION_LENGTH ? `${trimmed.slice(0, MAX_HANDOFF_PENDING_QUESTION_LENGTH)}…` : trimmed,
  };
}

// Tenta a chamada NVIDIA #2 + o validador fail-closed; qualquer falha (rede,
// timeout, JSON malformado, grounding reprovado) devolve undefined — nunca
// lança, nunca deixa o chamador sem uma resposta. O chamador sempre tem um
// template pronto para usar como fallback (fallbackMessageKey já calculado
// antes desta tentativa).
async function tryVerbalize(params: {
  verbalizeWithLlm: VerbalizeWithLlmFn;
  currentCustomerMessage: string;
  shortHistory: AgentShortHistoryEntry[];
  responseIntent: ResponseIntent;
  facts: AllowedFact[];
  businessName: string;
  catalogProductNames: string[];
}): Promise<AgentChatMessage[] | undefined> {
  try {
    const result = await params.verbalizeWithLlm({
      currentCustomerMessage: params.currentCustomerMessage,
      shortHistory: params.shortHistory,
      responseIntent: params.responseIntent,
      facts: params.facts,
      businessName: params.businessName,
      promptVersion: LLM_VERBALIZER_PROMPT_VERSION,
    });
    if (result.status !== "VERBALIZED") return undefined;
    const validation = validateResponseText({
      text: result.text,
      usedFactIds: result.usedFactIds,
      facts: params.facts,
      catalogProductNames: params.catalogProductNames,
    });
    if (!validation.ok) return undefined;
    return [{ id: randomUUID(), type: "text", text: result.text, metadata: { verbalized: true } }];
  } catch {
    return undefined;
  }
}

// Decide TEMPLATE vs. VERBALIZE (response-strategy-policy.ts, sempre
// determinístico) e, só quando VERBALIZE, tenta a verbalização — caindo
// sempre de volta para templateMessages em qualquer falha ou quando a
// funcionalidade está desligada (comportamento idêntico ao anterior).
async function renderTurnMessages(params: {
  verbalizationEnabled: boolean;
  verbalizeWithLlm?: VerbalizeWithLlmFn;
  templateMessages: AgentChatMessage[];
  responseIntent: ResponseIntent;
  confidence: "HIGH" | "LOW";
  facts: AllowedFact[];
  currentCustomerMessage: string;
  shortHistory: AgentShortHistoryEntry[];
  businessName: string;
  catalogProductNames: string[];
  // Sinal determinístico (nunca vindo do modelo) do que o Engine realmente
  // executou neste turno — ver Regra 0 de response-strategy-policy.ts.
  executedActionType?: string;
  messageKey?: string;
}): Promise<AgentChatMessage[]> {
  if (!params.verbalizationEnabled || !params.verbalizeWithLlm) return params.templateMessages;
  const strategy = decideRenderStrategy({
    confidence: params.confidence,
    responseIntent: params.responseIntent,
    facts: params.facts,
    executedActionType: params.executedActionType,
    messageKey: params.messageKey,
  });
  if (strategy !== "VERBALIZE") return params.templateMessages;
  const verbalized = await tryVerbalize({
    verbalizeWithLlm: params.verbalizeWithLlm,
    currentCustomerMessage: params.currentCustomerMessage,
    shortHistory: params.shortHistory,
    responseIntent: params.responseIntent,
    facts: params.facts,
    businessName: params.businessName,
    catalogProductNames: params.catalogProductNames,
  });
  return verbalized ?? params.templateMessages;
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

  const verbalizeWithLlm = deps.verbalizeWithLlm;
  const verbalizationEnabled = llmEnabled && deps.verbalizationMode === "ENABLED" && typeof verbalizeWithLlm === "function";
  // Histórico curto só é gravado quando o planejamento NVIDIA está de fato
  // ligado — sem isso, nada consome shortHistory e a sessão continua
  // exatamente na forma de hoje (campo nunca aparece por padrão).
  const shortHistoryEnabled = llmEnabled;
  const now = deps.now ?? (() => new Date());

  const sessionLocks = new Map<string, Promise<unknown>>();

  // Grava a troca (mensagem do cliente + texto final do agente) no
  // histórico curto já persistido pelo mesmo PostgresConversationState que
  // salva o resto da sessão — nenhuma tabela nova. Só chamado quando
  // shortHistoryEnabled; nunca fonte de fato (ver short-history.ts).
  function persistShortHistory(
    sessionKey: string,
    beforeHistory: AgentShortHistoryEntry[] | undefined,
    input: { customerText: string; customerMessageId?: string; agentText: string },
  ): AgentSession {
    const at = now().toISOString();
    const nextHistory = appendShortHistoryTurn(beforeHistory, {
      customerText: input.customerText,
      customerAt: at,
      ...(input.customerMessageId ? { customerMessageId: input.customerMessageId } : {}),
      agentText: input.agentText,
      agentAt: at,
    });
    return sessionStore.update(sessionKey, current => ({ ...current, shortHistory: nextHistory }));
  }

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
      const turnResult = await (async (): Promise<ProcessTextResult> => {
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

      // Informações factuais têm precedência sobre o interpretador e o LLM:
      // vêm do Store real e nunca dependem de inferência do modelo.
      const factualIntent = resolveFactualIntent({ text, address: tools.getBusinessAddress?.(), operatingStatus: tools.getOperatingStatus?.() });
      if (factualIntent?.kind === "MENU") {
        const { engineResult, sessionAfter, counterReset } = applySingleAction({
          conversationService, sessionStore, channel, contactId, messageId, sessionKey, action: { type: "SHOW_MENU" },
        });
        const presentation = buildConversationPresentation({ result: engineResult, session: sessionAfter, tools });
        return {
          sessionKey, duplicateMessage: false,
          interpretation: { deterministic: interpretation, finalSource: "POLICY" },
          sessionBefore, sessionAfter, result: { ...engineResult, session: structuredClone(sessionAfter) },
          messages: renderConversationPresentation(presentation),
          policy: { misunderstandingCountBefore, misunderstandingCountAfter: sessionAfter.misunderstandingCount, handoffTriggered: false, counterReset },
        };
      }
      if (factualIntent?.kind === "ADDRESS" || factualIntent?.kind === "PICKUP_AVAILABILITY" || factualIntent?.kind === "CART_TOTAL" || factualIntent?.kind === "OUT_OF_SCOPE_PRODUCT" || factualIntent?.kind === "RESPONSIBLE" || factualIntent?.kind === "PAYMENT_OPTIONS" || factualIntent?.kind === "PIX_KEY" || factualIntent?.kind === "PAYMENT_PROOF" || factualIntent?.kind === "OPERATING_HOURS" || factualIntent?.kind === "DELIVERY") {
        if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
        const sessionAfter = structuredClone(sessionStore.get(sessionKey)!);
        const policyResult: TextConversationPolicyResult = factualIntent.kind === "ADDRESS"
          ? factualIntent.address
            ? { event: "BUSINESS_ADDRESS", messageKey: "BUSINESS_ADDRESS", data: { address: factualIntent.address } }
            : { event: "BUSINESS_ADDRESS_UNAVAILABLE", messageKey: "BUSINESS_ADDRESS_UNAVAILABLE" }
          : factualIntent.kind === "PICKUP_AVAILABILITY"
            ? pickupAvailabilityPolicyResult(factualIntent.status)
          : factualIntent.kind === "OUT_OF_SCOPE_PRODUCT"
              ? { event: "OUT_OF_SCOPE_PRODUCT", messageKey: "OUT_OF_SCOPE_PRODUCT" }
            : factualIntent.kind === "RESPONSIBLE"
              ? { event: "BUSINESS_RESPONSIBLE", messageKey: "BUSINESS_RESPONSIBLE", data: { name: tools.getBusinessResponsible?.() || "Mateus" } }
            : factualIntent.kind === "PAYMENT_OPTIONS"
              ? { event: "BUSINESS_PAYMENT_OPTIONS", messageKey: "BUSINESS_PAYMENT_OPTIONS", data: { options: tools.getBusiness().paymentMethods } }
            : factualIntent.kind === "PIX_KEY"
              ? tools.getBusinessPixKey?.()
                ? { event: "BUSINESS_PIX_KEY", messageKey: "BUSINESS_PIX_KEY", data: { pixKey: tools.getBusinessPixKey() } }
                : { event: "BUSINESS_PIX_KEY_UNAVAILABLE", messageKey: "BUSINESS_PIX_KEY_UNAVAILABLE" }
            : factualIntent.kind === "PAYMENT_PROOF"
              ? { event: "BUSINESS_PAYMENT_PROOF", messageKey: "BUSINESS_PAYMENT_PROOF" }
            : factualIntent.kind === "OPERATING_HOURS"
              ? { event: "BUSINESS_OPERATING_HOURS", messageKey: "BUSINESS_OPERATING_HOURS", data: { hours: tools.getBusinessHours?.() || "Horários não cadastrados." } }
            : factualIntent.kind === "DELIVERY"
              ? { event: "BUSINESS_DELIVERY_UNAVAILABLE", messageKey: "BUSINESS_DELIVERY_UNAVAILABLE" }
            : (() => {
                const quote = tools.quoteCart?.(sessionBefore.items);
                return quote
                  ? { event: "CART_TOTAL", messageKey: "CART_TOTAL", data: { total: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(quote.total).replace(/\u00A0/g, " ") } }
                  : { event: "CART_TOTAL_EMPTY", messageKey: "CART_TOTAL_EMPTY" };
              })();
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
            misunderstandingCountAfter: sessionAfter.misunderstandingCount,
            handoffTriggered: false,
            counterReset: false,
          },
        };
      }

      if (interpretation.status === "MATCHED") {
        const { engineResult, sessionAfter, counterReset } = applySingleAction({
          conversationService, sessionStore, channel, contactId, messageId, sessionKey, action: interpretation.action,
        });
        const presentation = buildConversationPresentation({ result: engineResult, session: sessionAfter, tools });
        const messages = renderConversationPresentation(presentation);
        return {
          sessionKey, duplicateMessage: false,
          interpretation: { deterministic: interpretation, finalSource: "DETERMINISTIC" },
          sessionBefore, sessionAfter, result: { ...engineResult, session: structuredClone(sessionAfter) }, messages,
          policy: { misunderstandingCountBefore, misunderstandingCountAfter: sessionAfter.misunderstandingCount, handoffTriggered: false, counterReset },
        };
      }

      // NOT_UNDERSTOOD ou AMBIGUOUS a partir daqui. A sessão em handoff não
      // chama o Engine nem o provider para mensagens que não são factuais.
      if (interpretation.status === "NOT_UNDERSTOOD" && interpretation.reason === "HUMAN_HANDOFF_ACTIVE") {
        if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
        const sessionAfter = structuredClone(sessionStore.get(sessionKey)!);
        const policyResult: TextConversationPolicyResult = { event: "HUMAN_HANDOFF_ACTIVE", messageKey: "HUMAN_HANDOFF_ACTIVE" };
        return {
          sessionKey, duplicateMessage: false,
          interpretation: { deterministic: interpretation, finalSource: "POLICY" }, sessionBefore, sessionAfter, policyResult,
          messages: renderTextConversationPolicyMessage(policyResult),
          policy: { misunderstandingCountBefore, misunderstandingCountAfter: misunderstandingCountBefore, handoffTriggered: false, counterReset: false },
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
          llmOutcome = await interpretWithLlm!({
            text,
            session: sessionBefore,
            context,
            deterministicResult: interpretation,
            ...(shortHistoryEnabled ? { shortHistory: appendShortHistory(sessionBefore.shortHistory, { role: "customer", text, at: now().toISOString(), ...(messageId ? { messageId } : {}) }) } : {}),
          });
        }
      }

      // Guarda de repetição (mitigação estrutural, não a causa raiz — ver
      // docs/audits/2026-08-01-show-menu-repetido.md): se o planejamento do
      // LLM decidiu SHOW_MENU de novo, mas a última mensagem já enviada
      // nesta sessão foi MENU_READY e nada progrediu desde então (step ainda
      // BROWSING_MENU/BUILDING_ORDER — não STARTING, o que indicaria que o
      // cardápio nunca tinha sido mostrado de fato), reenviar o mesmo
      // cardápio de novo É suspeito — mas só quando a mensagem atual não
      // contém nenhum indício de pedido explícito (mentionsMenuRequestCue).
      // Sem essa checagem de conteúdo, um "pode mostrar de novo, esqueci um
      // sabor" legítimo cairia na guarda tão facilmente quanto uma repetição
      // silenciosa: as duas produzem exatamente o mesmo estado de sessão
      // (lastMessageKey=MENU_READY, step BROWSING_MENU/BUILDING_ORDER, ação
      // LLM MATCHED SHOW_MENU) — rastrear só a origem (LLM vs.
      // determinístico/factual) da mensagem anterior não resolve isso, pois
      // no caso legítimo a mensagem anterior TAMBÉM veio do LLM. Rastrear a
      // origem sozinha ainda enfraqueceria a guarda no padrão mais provável
      // do incidente real (primeira exibição via atalho factual "cardápio",
      // reincidências via LLM não pedidas): exigir origem LLM na mensagem
      // anterior deixaria essas reincidências passarem. Por isso a decisão
      // aqui é conteúdo da mensagem atual, não origem da anterior. Reduz o
      // llmOutcome a NOT_UNDERSTOOD para cair no caminho de esclarecimento/
      // handoff por incompreensão já existente (mais abaixo), em vez de
      // reexecutar SHOW_MENU. Só se aplica à ação vinda do LLM: SHOW_MENU
      // determinístico (factual ou do interpretador determinístico) não
      // passa por aqui e continua funcionando igual.
      //
      // `actions.length >= 1` (em vez de `=== 1`) cobre também o caso real
      // observado em produção: o planejamento às vezes devolve SHOW_MENU
      // dentro de um LOTE de 2+ ações (ex.: duplicado), que sem isso
      // executaria pelo caminho de lote — sem nenhuma proteção de
      // repetição, já que o lote nunca passava por aqui. `.every()` garante
      // que só um lote 100% composto por SHOW_MENU cai na guarda; um lote
      // real com SHOW_MENU misturado a outra ação de negócio (não
      // reproduzido até agora, mas não impossível) continua fora do escopo
      // desta guarda e seria tratado como um incidente novo, não como
      // repetição de cardápio.
      if (
        llmOutcome?.status === "MATCHED" &&
        llmOutcome.actions.length >= 1 &&
        llmOutcome.actions.every(action => action.type === "SHOW_MENU") &&
        sessionBefore.lastMessageKey === "MENU_READY" &&
        (sessionBefore.step === "BROWSING_MENU" || sessionBefore.step === "BUILDING_ORDER") &&
        !mentionsMenuRequestCue(text)
      ) {
        llmOutcome = {
          status: "NOT_UNDERSTOOD",
          reason: "REPEATED_MENU_GUARD",
          source: "LLM",
          promptVersion: llmOutcome.promptVersion,
          durationMs: llmOutcome.durationMs,
        };
      }

      if (llmOutcome?.status === "PROVIDER_ERROR") {
        if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
        const sessionAfterUnchanged = structuredClone(sessionStore.get(sessionKey)!);
        // Fallback contextual (nunca o texto genérico incondicional de
        // antes, exceto como último recurso explícito): reexecuta a
        // checagem factual determinística e, se não bater, reapresenta o
        // que a etapa atual já pede.
        const fallback = computePlanningFailureFallback({
          currentMessage: text,
          session: sessionBefore,
          address: tools.getBusinessAddress?.(),
          operatingStatus: tools.getOperatingStatus?.(),
          reason: "PROVIDER_ERROR",
        });
        // Último recurso (session.step === START sem nenhum sinal factual):
        // mantém exatamente o comportamento já testado (texto varia por
        // recovery, nunca o texto genérico cru).
        if (fallback.messageKey === "POLICY_LLM_TEMPORARILY_UNAVAILABLE") {
          const policyResult: TextConversationPolicyResult = {
            event: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
            messageKey: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
            data: { recovery: llmRecoveryKind(sessionBefore) },
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
        const presentation = buildConversationPresentation({
          result: { session: sessionAfterUnchanged, previousStep: sessionAfterUnchanged.step, currentStep: sessionAfterUnchanged.step, event: fallback.messageKey, messageKey: fallback.messageKey, data: fallback.data },
          session: sessionAfterUnchanged,
          tools,
        });
        const policyResult: TextConversationPolicyResult = {
          event: fallback.messageKey,
          messageKey: fallback.messageKey,
          data: { recovery: llmRecoveryKind(sessionBefore), ...(fallback.data ?? {}) },
        };
        return {
          sessionKey,
          duplicateMessage: false,
          interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "POLICY" },
          sessionBefore,
          sessionAfter: sessionAfterUnchanged,
          policyResult,
          messages: renderConversationPresentation(presentation),
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
        const templateMessages = renderConversationPresentation(presentation);
        const responseIntent = llmOutcome.responseIntent ?? DEFAULT_CONFIRM_RESPONSE_INTENT;
        const confidence = llmOutcome.confidence ?? "HIGH";
        const facts = buildAllowedFacts({
          result: engineResult,
          tools,
          operatingStatus: tools.getOperatingStatus?.(),
          requestedFactKeys: responseIntent.kind === "ANSWER_FACTUAL" ? responseIntent.factKeys : undefined,
        });
        const messages = await renderTurnMessages({
          verbalizationEnabled,
          verbalizeWithLlm,
          templateMessages,
          responseIntent,
          confidence,
          facts,
          currentCustomerMessage: text,
          shortHistory: appendShortHistory(sessionBefore.shortHistory, { role: "customer", text, at: now().toISOString() }),
          businessName: tools.getBusiness().name,
          catalogProductNames: tools.listProducts().map(p => p.name),
          executedActionType: llmOutcome.actions[0]!.type,
          messageKey: engineResult.messageKey,
        });
        let finalSessionAfter = sessionAfter;
        if (shortHistoryEnabled) {
          finalSessionAfter = structuredClone(
            persistShortHistory(sessionKey, sessionBefore.shortHistory, {
              customerText: text,
              ...(messageId ? { customerMessageId: messageId } : {}),
              agentText: messages.map(m => m.text).join(" "),
            }),
          );
        }
        return {
          sessionKey,
          duplicateMessage: false,
          interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "LLM" },
          sessionBefore,
          sessionAfter: finalSessionAfter,
          result: { ...engineResult, session: structuredClone(finalSessionAfter) },
          messages,
          policy: {
            misunderstandingCountBefore,
            misunderstandingCountAfter: finalSessionAfter.misunderstandingCount,
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

          // Lote de múltiplos ADD_ITEM (ex.: "2 brigadeiros e 1 de ninho" em
          // uma só mensagem via verbalização): o template padrão de
          // ITEM_ADDED só descreve um produto, então usar `lastResult`
          // sozinho mostra apenas o último item ao cliente, mesmo com o
          // carrinho correto internamente. Quando TODAS as ações do lote
          // forem ADD_ITEM, a apresentação/renderização usam uma chave
          // agregada com produto+quantidade final de cada item do lote.
          // O `result` estrutural devolvido ao chamador (abaixo, fora deste
          // bloco) continua sendo o da última ação — só o texto exibido
          // muda; nenhum contrato de dados existente é alterado.
          const itemAddedResults = batchResult.results.filter(r => r.result.messageKey === "ITEM_ADDED");
          const isPureAddItemBatch =
            itemAddedResults.length > 1 && itemAddedResults.length === batchResult.results.length;
          let presentationResult = lastResult.result;
          if (isPureAddItemBatch) {
            const quantityByProduct = new Map<string, number>();
            for (const itemResult of itemAddedResults) {
              const itemData = itemResult.result.data as { productId?: unknown; quantity?: unknown } | undefined;
              if (typeof itemData?.productId === "string" && typeof itemData?.quantity === "number") {
                quantityByProduct.set(itemData.productId, itemData.quantity);
              }
            }
            presentationResult = {
              ...lastResult.result,
              messageKey: "ITEMS_ADDED_BATCH",
              data: { items: Array.from(quantityByProduct, ([productId, quantity]) => ({ productId, quantity })) },
            };
          }
          const presentation = buildConversationPresentation({ result: presentationResult, session: sessionAfter, tools });
          const templateMessages = renderConversationPresentation(presentation);
          const responseIntent = llmOutcome.responseIntent ?? DEFAULT_CONFIRM_RESPONSE_INTENT;
          const confidence = llmOutcome.confidence ?? "HIGH";
          const facts = buildAllowedFacts({
            result: presentationResult,
            tools,
            operatingStatus: tools.getOperatingStatus?.(),
            requestedFactKeys: responseIntent.kind === "ANSWER_FACTUAL" ? responseIntent.factKeys : undefined,
          });
          const messages = await renderTurnMessages({
            verbalizationEnabled,
            verbalizeWithLlm,
            templateMessages,
            responseIntent,
            confidence,
            facts,
            currentCustomerMessage: text,
            shortHistory: appendShortHistory(sessionBefore.shortHistory, { role: "customer", text, at: now().toISOString() }),
            businessName: tools.getBusiness().name,
            catalogProductNames: tools.listProducts().map(p => p.name),
            messageKey: presentationResult.messageKey,
          });
          if (shortHistoryEnabled) {
            sessionAfter = structuredClone(
              persistShortHistory(sessionKey, sessionBefore.shortHistory, {
                customerText: text,
                ...(messageId ? { customerMessageId: messageId } : {}),
                agentText: messages.map(m => m.text).join(" "),
              }),
            );
          }
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
          if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
          const policyResult: TextConversationPolicyResult = {
            event: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
            messageKey: "POLICY_LLM_TEMPORARILY_UNAVAILABLE",
            data: { recovery: llmRecoveryKind(sessionBefore) },
          };
          return {
            sessionKey,
            duplicateMessage: false,
            interpretation: {
              deterministic: interpretation,
              llm: sanitizeLlmOutcomeForResult(llmOutcome, { stripPromptVersion: true }),
              finalSource: "POLICY",
            },
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

      // Intenções não-transacionais identificadas pelo planejamento —
      // reconhecidas naturalmente, sem contar como "não entendi" e sem
      // empurrar o pedido. Nunca vindas do determinístico (que já trataria
      // REQUEST_HUMAN/comandos globais antes de chegar aqui) — só do plano
      // NVIDIA, quando a ação de negócio não é o caso.
      if (llmOutcome?.status === "NOT_UNDERSTOOD" && llmOutcome.intent && llmOutcome.intent !== "UNRECOGNIZED" && llmOutcome.intent !== "BUSINESS_ACTION" && llmOutcome.intent !== "FACTUAL_QUESTION" && llmOutcome.intent !== "CLARIFICATION_NEEDED") {
        const intent = llmOutcome.intent;
        const confidence = llmOutcome.confidence ?? "HIGH";
        const currentShortHistory = appendShortHistory(sessionBefore.shortHistory, { role: "customer", text, at: now().toISOString() });

        if (intent === "REQUEST_HUMAN") {
          // Só uma solicitação inequívoca pode bloquear o atendimento. Isso
          // evita que perguntas como "com quem eu falo?" virem transferência.
          if (!explicitlyRequestsHuman(text)) {
            if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
            const sessionAfterUnchanged = structuredClone(sessionStore.get(sessionKey)!);
            const policyResult: TextConversationPolicyResult = {
              event: "HUMAN_HANDOFF_CONFIRMATION_REQUIRED",
              messageKey: "HUMAN_HANDOFF_CONFIRMATION_REQUIRED",
            };
            return {
              sessionKey, duplicateMessage: false,
              interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "POLICY" },
              sessionBefore, sessionAfter: sessionAfterUnchanged, policyResult,
              messages: renderTextConversationPolicyMessage(policyResult),
              policy: { misunderstandingCountBefore, misunderstandingCountAfter: misunderstandingCountBefore, handoffTriggered: false, counterReset: false },
            };
          }
          const { engineResult, sessionAfter: handoffSessionAfter, counterReset } = applySingleAction({
            conversationService, sessionStore, channel, contactId, messageId, sessionKey, action: { type: "REQUEST_HUMAN" },
          });
          const templateMessages = renderConversationPresentation(
            buildConversationPresentation({ result: engineResult, session: handoffSessionAfter, tools }),
          );
          const responseIntent: ResponseIntent = llmOutcome.responseIntent ?? { kind: "REQUEST_HUMAN_ACK" };
          const messages = await renderTurnMessages({
            verbalizationEnabled, verbalizeWithLlm, templateMessages, responseIntent, confidence, facts: [],
            currentCustomerMessage: text, shortHistory: currentShortHistory,
            businessName: tools.getBusiness().name, catalogProductNames: tools.listProducts().map(p => p.name),
          });
          let finalSessionAfter = handoffSessionAfter;
          if (shortHistoryEnabled) {
            finalSessionAfter = structuredClone(persistShortHistory(sessionKey, sessionBefore.shortHistory, {
              customerText: text, ...(messageId ? { customerMessageId: messageId } : {}), agentText: messages.map(m => m.text).join(" "),
            }));
          }
          return {
            sessionKey, duplicateMessage: false,
            interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "LLM" },
            sessionBefore, sessionAfter: finalSessionAfter,
            result: { ...engineResult, session: structuredClone(finalSessionAfter), data: { ...engineResult.data, handoffSummary: buildHandoffSummary({ session: finalSessionAfter, intent, lastCustomerMessage: text }) } },
            messages,
            policy: { misunderstandingCountBefore, misunderstandingCountAfter: finalSessionAfter.misunderstandingCount, handoffTriggered: false, counterReset },
          };
        }

        const messageKey = intent === "SOCIAL" ? "SOCIAL_ACKNOWLEDGED" : intent === "OBJECTION" ? "OBJECTION_ACKNOWLEDGED" : "OUT_OF_SCOPE_DECLINED";
        const defaultResponseIntent: ResponseIntent =
          intent === "SOCIAL" ? { kind: "SOCIAL_ACK" } : intent === "OBJECTION" ? { kind: "ACKNOWLEDGE_OBJECTION" } : { kind: "DECLINE_OUT_OF_SCOPE" };
        const responseIntent = llmOutcome.responseIntent ?? defaultResponseIntent;
        if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
        const sessionAfterUnchanged = structuredClone(sessionStore.get(sessionKey)!);
        const templateMessages: AgentChatMessage[] = [
          { id: randomUUID(), type: "text", text: MESSAGE_CATALOG[messageKey]!, metadata: { messageKey } },
        ];
        const messages = await renderTurnMessages({
          verbalizationEnabled, verbalizeWithLlm, templateMessages, responseIntent, confidence, facts: [],
          currentCustomerMessage: text, shortHistory: currentShortHistory,
          businessName: tools.getBusiness().name, catalogProductNames: tools.listProducts().map(p => p.name),
        });
        let finalSessionAfter = sessionAfterUnchanged;
        if (shortHistoryEnabled) {
          finalSessionAfter = structuredClone(persistShortHistory(sessionKey, sessionBefore.shortHistory, {
            customerText: text, ...(messageId ? { customerMessageId: messageId } : {}), agentText: messages.map(m => m.text).join(" "),
          }));
        }
        const policyResult: TextConversationPolicyResult = { event: messageKey, messageKey };
        return {
          sessionKey, duplicateMessage: false,
          interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "LLM" },
          sessionBefore, sessionAfter: finalSessionAfter, policyResult, messages,
          policy: { misunderstandingCountBefore, misunderstandingCountAfter: misunderstandingCountBefore, handoffTriggered: false, counterReset: false },
        };
      }

      // Produto que o modelo não conseguiu resolver no catálogo não é erro
      // do cliente. É uma pergunta comercial comum: respondemos com clareza
      // e mantemos a conversa aberta, sem consumir tentativas nem transferir.
      if (llmOutcome?.status === "NOT_UNDERSTOOD" && llmOutcome.reason.trim().toUpperCase() === "PRODUCT_NOT_FOUND") {
        if (messageId) sessionStore.markMessageProcessed(sessionKey, messageId);
        const sessionAfter = structuredClone(sessionStore.get(sessionKey)!);
        const policyResult: TextConversationPolicyResult = { event: "PRODUCT_NOT_IN_MENU", messageKey: "PRODUCT_NOT_IN_MENU" };
        return {
          sessionKey, duplicateMessage: false,
          interpretation: { deterministic: interpretation, llm: sanitizeLlmOutcomeForResult(llmOutcome), finalSource: "POLICY" },
          sessionBefore, sessionAfter, policyResult,
          messages: renderTextConversationPolicyMessage(policyResult),
          policy: { misunderstandingCountBefore, misunderstandingCountAfter: misunderstandingCountBefore, handoffTriggered: false, counterReset: false },
        };
      }

      const failure: { status: "NOT_UNDERSTOOD" | "AMBIGUOUS"; suggestions: string[] } =
        llmOutcome?.status === "NOT_UNDERSTOOD"
          ? { status: "NOT_UNDERSTOOD", suggestions: publicSuggestions(llmOutcome.suggestions) }
          : llmOutcome?.status === "AMBIGUOUS"
            ? { status: "AMBIGUOUS", suggestions: [] }
            : interpretation.status === "AMBIGUOUS"
              ? { status: "AMBIGUOUS", suggestions: [] }
              : { status: "NOT_UNDERSTOOD", suggestions: publicSuggestions(interpretation.suggestions) };

      // O contador é apenas sinal interno para ajustar a mensagem de ajuda;
      // ele não bloqueia a conversa nem cresce indefinidamente.
      const newCount = Math.min(misunderstandingCountBefore + 1, maxMisunderstandings);
      // Não encaminhamos automaticamente por frases que o sistema não
      // reconheceu. Um cliente deve poder reformular, mudar de assunto e ver
      // o cardápio sem ser bloqueado. Handoff continua disponível quando ele
      // o pede explicitamente ("atendente", "falar com uma pessoa" etc.).
      const handoffTriggered = false;

      let sessionAfter = sessionStore.update(sessionKey, current => ({ ...current, misunderstandingCount: newCount }));

      if (messageId) {
        sessionStore.markMessageProcessed(sessionKey, messageId);
        sessionAfter = sessionStore.get(sessionKey)!;
      }
      sessionAfter = structuredClone(sessionAfter);

      const remainingAttempts = Math.max(maxMisunderstandings - newCount, 0);

      const policyResult: TextConversationPolicyResult = failure.status === "AMBIGUOUS"
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
          // Um llmOutcome MATCHED só chega até aqui por um lote rejeitado no
          // preflight — `actions` fica (é o que dá sentido a
          // `execution.failedActionIndex`, que indexa nele), `promptVersion` sai.
          ...(llmOutcome
            ? { llm: sanitizeLlmOutcomeForResult(llmOutcome, { stripPromptVersion: batchResult?.status === "REJECTED" }) }
            : {}),
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
      })();
      return recordLastMessageKey(sessionStore, sessionKey, turnResult);
      });
    },
  };
}
