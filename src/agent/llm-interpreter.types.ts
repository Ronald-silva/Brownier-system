// Tipos do LLM Interpreter — infraestrutura independente de provedor que,
// no futuro, converterá texto em AgentConversationAction quando o
// Deterministic Interpreter devolver NOT_UNDERSTOOD/AMBIGUOUS em cenários
// elegíveis. Nenhuma lógica de conversa mora aqui, apenas a forma dos dados
// de entrada, do contrato do provider e do resultado já validado. Esta etapa
// não integra o LLM Interpreter ao Text Conversation Service.
import type { AgentConversationAction } from "./conversation.types.ts";
import type { AgentSession } from "./session.types.ts";
import type { DeterministicInterpretationResult } from "./interpreter.types.ts";

// --- contrato do provider ---------------------------------------------------

export type LlmProviderRequest = {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  timeoutMs?: number;
};

// A resposta é `unknown` de propósito: nenhuma resposta de provider é
// confiada diretamente. Todo valor devolvido passa pelo parser e pelo
// validator locais antes de virar uma ação.
export interface LlmInterpreterProvider {
  generateStructuredOutput(request: LlmProviderRequest): Promise<unknown>;
}

// --- contexto público aceito pelo prompt -----------------------------------

export type LlmInterpreterPublicProduct = {
  id: string;
  name: string;
  description?: string;
  price?: number;
};

// Apenas dados já públicos (mesmo formato que o Deterministic Interpreter já
// recebe) — nunca custo, margem, estoque administrativo ou configuração
// interna.
export type LlmInterpreterContext = {
  products?: LlmInterpreterPublicProduct[];
  paymentOptions?: string[];
  pickupSlots?: string[];
  businessName?: string;
};

// --- entrada do interpretador ------------------------------------------------

export type InterpretLlmMessageInput = {
  text: string;
  session: AgentSession;
  context?: LlmInterpreterContext;
  deterministicResult?: DeterministicInterpretationResult;
};

export type CreateLlmInterpreterInput = {
  provider: LlmInterpreterProvider;
  timeoutMs?: number;
  maxOutputLength?: number;
};

// --- resultado do LLM Interpreter -------------------------------------------
// Nenhum score de confiança (nunca 0.82, nunca 95%) — apenas os status abaixo.

export type LlmInterpretationMatched = {
  status: "MATCHED";
  actions: AgentConversationAction[];
  source: "LLM";
  explanationCode?: string;
  promptVersion: string;
  durationMs: number;
};

export type LlmInterpretationNotUnderstood = {
  status: "NOT_UNDERSTOOD";
  reason: string;
  suggestions?: string[];
  source: "LLM";
  promptVersion: string;
  durationMs: number;
};

export type LlmInterpretationCandidate = {
  action: AgentConversationAction;
  label?: string;
};

export type LlmInterpretationAmbiguous = {
  status: "AMBIGUOUS";
  reason: string;
  candidates?: LlmInterpretationCandidate[];
  source: "LLM";
  promptVersion: string;
  durationMs: number;
};

// Saída do provider foi recebida, mas rejeitada localmente (ação proibida,
// produto/horário/pagamento alucinado, lote inválido, schema inválido etc.).
export type LlmInterpretationRejected = {
  status: "REJECTED";
  reason: string;
  source: "VALIDATOR";
  promptVersion: string;
  durationMs: number;
};

// Falha técnica do provider (timeout, Promise rejeitada) — nunca usada para
// representar uma saída inválida, que deve virar REJECTED.
export type LlmInterpretationProviderError = {
  status: "PROVIDER_ERROR";
  reason: string;
  retryable: boolean;
  promptVersion: string;
  durationMs: number;
};

export type LlmInterpretationResult =
  | LlmInterpretationMatched
  | LlmInterpretationNotUnderstood
  | LlmInterpretationAmbiguous
  | LlmInterpretationRejected
  | LlmInterpretationProviderError;

export type LlmInterpreter = {
  interpret(input: InterpretLlmMessageInput): Promise<LlmInterpretationResult>;
};
