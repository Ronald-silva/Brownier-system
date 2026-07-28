// LLM Output Validator — parser seguro + allowlist de ações + validação por
// etapa, produto, retirada, horário, pagamento, nome, telefone e observação.
// Nenhuma chamada de rede, nenhum SDK, nenhuma execução de código do
// provider: apenas JSON.parse e comparação exata contra dados já
// confirmados em `context` e na etapa atual da sessão. Este é o único lugar
// que decide se uma proposta do LLM pode virar uma AgentConversationAction
// real — o LLM nunca altera Session Store, nunca chama Tools/Orders.
import { normalizeInterpreterText } from "./deterministic-interpreter.ts";
import type { AgentConversationAction } from "./conversation.types.ts";
import type { AgentConversationStep, AgentSession } from "./session.types.ts";
import type { LlmInterpreterContext, LlmInterpreterPublicProduct } from "./llm-interpreter.types.ts";

export const DEFAULT_MAX_OUTPUT_LENGTH = 20_000;
const MAX_ACTIONS_PER_MESSAGE = 5;
const MAX_CUSTOMER_NAME_LENGTH = 120;
const MAX_CUSTOMER_NOTES_LENGTH = 500;
const MAX_PHONE_LENGTH = 30;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const MAX_ITEM_QUANTITY = 100;

// --- allowlist de ações -----------------------------------------------------
// Os únicos 19 tipos definidos em AgentConversationAction (conversation.types.ts).
// Nenhum tipo é inventado aqui; se um tipo listado na spec não existisse no
// contrato real, ele NÃO seria adicionado (não é o caso: todos existem).
const ALLOWED_ACTION_TYPES: ReadonlySet<AgentConversationAction["type"]> = new Set([
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
  "RESET_CONVERSATION",
  "REQUEST_HUMAN",
]);

// Classificação local por etapa (código, nunca confiado ao LLM). REVIEW_ORDER
// não aparece em nenhuma etapa: a spec não define uma etapa elegível para
// ele, então fica bloqueado por padrão (ver limitações no relatório final).
const STEP_ALLOWED_ACTIONS: Record<AgentConversationStep, ReadonlySet<string>> = {
  START: new Set(["START_CONVERSATION", "SHOW_MENU", "REQUEST_HUMAN", "RESET_CONVERSATION"]),
  BROWSING_MENU: new Set([
    "ADD_ITEM",
    "REMOVE_ITEM",
    "UPDATE_ITEM_QUANTITY",
    "CLEAR_CART",
    "FINISH_CART",
    "SHOW_MENU",
    "GO_BACK",
    "CANCEL_CONVERSATION",
    "REQUEST_HUMAN",
    "RESET_CONVERSATION",
  ]),
  BUILDING_ORDER: new Set([
    "ADD_ITEM",
    "REMOVE_ITEM",
    "UPDATE_ITEM_QUANTITY",
    "CLEAR_CART",
    "FINISH_CART",
    "SHOW_MENU",
    "GO_BACK",
    "CANCEL_CONVERSATION",
    "REQUEST_HUMAN",
    "RESET_CONVERSATION",
  ]),
  COLLECTING_NAME: new Set([
    "SET_CUSTOMER_NAME",
    "SET_CUSTOMER_PHONE",
    "SHOW_MENU",
    "GO_BACK",
    "CANCEL_CONVERSATION",
    "REQUEST_HUMAN",
    "RESET_CONVERSATION",
  ]),
  COLLECTING_FULFILLMENT: new Set([
    "SET_FULFILLMENT",
    "SET_CUSTOMER_PHONE",
    "SHOW_MENU",
    "GO_BACK",
    "CANCEL_CONVERSATION",
    "REQUEST_HUMAN",
    "RESET_CONVERSATION",
  ]),
  COLLECTING_PICKUP_TIME: new Set(["SET_PICKUP_TIME", "SHOW_MENU", "GO_BACK", "CANCEL_CONVERSATION", "REQUEST_HUMAN", "RESET_CONVERSATION"]),
  COLLECTING_NOTES: new Set([
    "SET_CUSTOMER_NOTES",
    "SKIP_CUSTOMER_NOTES",
    "SHOW_MENU",
    "GO_BACK",
    "CANCEL_CONVERSATION",
    "REQUEST_HUMAN",
    "RESET_CONVERSATION",
  ]),
  COLLECTING_PAYMENT: new Set(["SET_PAYMENT_METHOD", "SHOW_MENU", "GO_BACK", "CANCEL_CONVERSATION", "REQUEST_HUMAN", "RESET_CONVERSATION"]),
  AWAITING_CONFIRMATION: new Set(["CONFIRM_ORDER", "GO_BACK", "CANCEL_CONVERSATION", "REQUEST_HUMAN"]),
  ORDER_CREATED: new Set(["RESET_CONVERSATION", "SHOW_MENU", "REQUEST_HUMAN"]),
  HUMAN_HANDOFF: new Set(["RESET_CONVERSATION"]),
};

const HUMAN_HANDOFF_OVERRIDE_ALLOWED: ReadonlySet<string> = new Set(["RESET_CONVERSATION"]);

function allowedActionsForSession(session: AgentSession): ReadonlySet<string> {
  if (session.underHumanHandoff) return HUMAN_HANDOFF_OVERRIDE_ALLOWED;
  return STEP_ALLOWED_ACTIONS[session.step] ?? new Set();
}

// --- parser ------------------------------------------------------------------

export type LlmOutputParseResult = { ok: true; value: unknown } | { ok: false; reason: string };

const JSON_FENCE_REGEX = /^```json\s*([\s\S]*?)\s*```$/i;

// Aceita objeto já estruturado, string JSON simples, ou string com bloco
// ```json ... ```. Nunca usa eval/Function; só JSON.parse. Rejeita saída
// vazia, acima do limite, ou que não seja JSON estritamente válido (o que
// naturalmente rejeita texto extra antes/depois do JSON).
export function parseLlmOutput(raw: unknown, maxOutputLength: number = DEFAULT_MAX_OUTPUT_LENGTH): LlmOutputParseResult {
  if (raw === null || raw === undefined) return { ok: false, reason: "EMPTY_OUTPUT" };

  if (typeof raw === "object") {
    return { ok: true, value: raw };
  }

  if (typeof raw !== "string") return { ok: false, reason: "UNSUPPORTED_OUTPUT_TYPE" };

  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "EMPTY_OUTPUT" };
  if (trimmed.length > maxOutputLength) return { ok: false, reason: "OUTPUT_TOO_LONG" };

  const fenceMatch = JSON_FENCE_REGEX.exec(trimmed);
  const jsonText = fenceMatch ? fenceMatch[1]! : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }
  return { ok: true, value: parsed };
}

// --- validação de campos -----------------------------------------------------

type FieldOk<T> = { ok: true; value: T };
type FieldFail = { ok: false; reason: string };

function fieldOk<T>(value: T): FieldOk<T> {
  return { ok: true, value };
}
function fieldFail(reason: string): FieldFail {
  return { ok: false, reason };
}

function isValidQuantity(quantity: unknown): quantity is number {
  return typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_ITEM_QUANTITY;
}

// productId deve vir exatamente do contexto; productName só resolve quando
// há correspondência exata normalizada única (nunca fuzzy, nunca a primeira
// de vários resultados).
function resolveProductId(
  context: LlmInterpreterContext | undefined,
  rawProductId: unknown,
  rawProductName: unknown,
): FieldOk<string> | FieldFail {
  const products: LlmInterpreterPublicProduct[] = Array.isArray(context?.products) ? context!.products! : [];

  if (typeof rawProductId === "string" && rawProductId.length > 0) {
    const found = products.some(product => product.id === rawProductId);
    return found ? fieldOk(rawProductId) : fieldFail("PRODUCT_NOT_FOUND");
  }

  if (typeof rawProductName === "string" && rawProductName.trim().length > 0) {
    const normalized = normalizeInterpreterText(rawProductName);
    const matches = products.filter(product => normalizeInterpreterText(product.name) === normalized);
    if (matches.length === 1) return fieldOk(matches[0]!.id);
    if (matches.length === 0) return fieldFail("PRODUCT_NOT_FOUND");
    return fieldFail("PRODUCT_AMBIGUOUS");
  }

  return fieldFail("PRODUCT_NOT_FOUND");
}

function normalizePickupCandidate(raw: string): string | undefined {
  const hourOnly = /^(\d{1,2})\s*h$/i.exec(raw.trim());
  if (hourOnly) return `${hourOnly[1]!.padStart(2, "0")}:00`;
  return undefined;
}

// Só aceita "19h" -> "19:00" quando "19:00" existe exatamente na lista.
// Nunca arredonda, nunca escolhe o horário mais próximo, nunca inventa slot.
function resolvePickupTime(context: LlmInterpreterContext | undefined, raw: unknown): FieldOk<string> | FieldFail {
  if (typeof raw !== "string" || !raw.trim()) return fieldFail("INVALID_PICKUP_OPTION");
  const slots: string[] = Array.isArray(context?.pickupSlots) ? context!.pickupSlots! : [];
  const trimmed = raw.trim();
  if (slots.includes(trimmed)) return fieldOk(trimmed);
  const normalized = normalizePickupCandidate(trimmed);
  if (normalized && slots.includes(normalized)) return fieldOk(normalized);
  return fieldFail("INVALID_PICKUP_OPTION");
}

function normalizePaymentCandidate(text: string): string {
  return normalizeInterpreterText(text.replace(/_/g, " "));
}

// Comparação normalizada (caixa, acentos, espaços, underscore vs espaço) —
// o valor final é sempre o valor canônico presente em context.paymentOptions.
function resolvePaymentMethod(context: LlmInterpreterContext | undefined, raw: unknown): FieldOk<string> | FieldFail {
  if (typeof raw !== "string" || !raw.trim()) return fieldFail("PAYMENT_NOT_ALLOWED");
  const options: string[] = Array.isArray(context?.paymentOptions) ? context!.paymentOptions! : [];
  const normalizedRaw = normalizePaymentCandidate(raw);
  const match = options.find(option => normalizePaymentCandidate(option) === normalizedRaw);
  return match ? fieldOk(match) : fieldFail("PAYMENT_NOT_ALLOWED");
}

const ONLY_DIGITS_LIKE_REGEX = /^[\d\s()+-]+$/;

function validateCustomerName(raw: unknown): FieldOk<string> | FieldFail {
  if (typeof raw !== "string") return fieldFail("INVALID_CUSTOMER_NAME");
  const trimmed = raw.trim();
  if (!trimmed) return fieldFail("INVALID_CUSTOMER_NAME");
  if (trimmed.length > MAX_CUSTOMER_NAME_LENGTH) return fieldFail("INVALID_CUSTOMER_NAME");
  if (ONLY_DIGITS_LIKE_REGEX.test(trimmed)) return fieldFail("INVALID_CUSTOMER_NAME");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fieldFail("INVALID_CUSTOMER_NAME");
  return fieldOk(trimmed);
}

const PHONE_CHARS_REGEX = /^[+()\-\s\d]+$/;

function validateCustomerPhone(raw: unknown): FieldOk<string> | FieldFail {
  if (typeof raw !== "string") return fieldFail("INVALID_CUSTOMER_PHONE");
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PHONE_LENGTH) return fieldFail("INVALID_CUSTOMER_PHONE");
  if (!PHONE_CHARS_REGEX.test(trimmed)) return fieldFail("INVALID_CUSTOMER_PHONE");
  const digitCount = trimmed.replace(/\D/g, "").length;
  if (digitCount < MIN_PHONE_DIGITS || digitCount > MAX_PHONE_DIGITS) return fieldFail("INVALID_CUSTOMER_PHONE");
  return fieldOk(trimmed);
}

function validateCustomerNotes(raw: unknown): FieldOk<string> | FieldFail {
  if (typeof raw !== "string") return fieldFail("INVALID_CUSTOMER_NOTES");
  const trimmed = raw.trim();
  if (!trimmed) return fieldFail("INVALID_CUSTOMER_NOTES");
  if (trimmed.length > MAX_CUSTOMER_NOTES_LENGTH) return fieldFail("INVALID_CUSTOMER_NOTES");
  // O texto é preservado como observação, nunca interpretado como comando —
  // nenhuma instrução embutida aqui pode gerar ação adicional.
  return fieldOk(trimmed);
}

// --- validação de uma ação ---------------------------------------------------

type ActionValidationResult = { ok: true; action: AgentConversationAction } | { ok: false; reason: string };

function validateAction(
  rawAction: unknown,
  session: AgentSession,
  context: LlmInterpreterContext | undefined,
): ActionValidationResult {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return { ok: false, reason: "INVALID_ACTION_SHAPE" };
  }
  // Leitura só de chaves nomeadas específicas — nunca spread/Object.assign do
  // objeto bruto, o que também evita qualquer efeito de poluição de protótipo
  // via uma chave "__proto__" presente no JSON.
  const a = rawAction as Record<string, unknown>;
  const type = a.type;

  if (typeof type !== "string" || !ALLOWED_ACTION_TYPES.has(type as AgentConversationAction["type"])) {
    return { ok: false, reason: "ACTION_NOT_ALLOWED" };
  }

  if (!allowedActionsForSession(session).has(type)) {
    return { ok: false, reason: "ACTION_NOT_ALLOWED_FOR_STEP" };
  }

  switch (type as AgentConversationAction["type"]) {
    case "START_CONVERSATION":
      return { ok: true, action: { type: "START_CONVERSATION" } };
    case "SHOW_MENU":
      return { ok: true, action: { type: "SHOW_MENU" } };
    case "ADD_ITEM": {
      const resolved = resolveProductId(context, a.productId, a.productName);
      if (resolved.ok === false) return { ok: false, reason: resolved.reason };
      if (!isValidQuantity(a.quantity)) return { ok: false, reason: "INVALID_QUANTITY" };
      return { ok: true, action: { type: "ADD_ITEM", productId: resolved.value, quantity: a.quantity } };
    }
    case "UPDATE_ITEM_QUANTITY": {
      const resolved = resolveProductId(context, a.productId, a.productName);
      if (resolved.ok === false) return { ok: false, reason: resolved.reason };
      if (!isValidQuantity(a.quantity)) return { ok: false, reason: "INVALID_QUANTITY" };
      return { ok: true, action: { type: "UPDATE_ITEM_QUANTITY", productId: resolved.value, quantity: a.quantity } };
    }
    case "REMOVE_ITEM": {
      const resolved = resolveProductId(context, a.productId, a.productName);
      if (resolved.ok === false) return { ok: false, reason: resolved.reason };
      return { ok: true, action: { type: "REMOVE_ITEM", productId: resolved.value } };
    }
    case "CLEAR_CART":
      return { ok: true, action: { type: "CLEAR_CART" } };
    case "FINISH_CART":
      return { ok: true, action: { type: "FINISH_CART" } };
    case "SET_CUSTOMER_NAME": {
      const validated = validateCustomerName(a.customerName);
      if (validated.ok === false) return { ok: false, reason: validated.reason };
      return { ok: true, action: { type: "SET_CUSTOMER_NAME", customerName: validated.value } };
    }
    case "SET_CUSTOMER_PHONE": {
      const validated = validateCustomerPhone(a.customerPhone);
      if (validated.ok === false) return { ok: false, reason: validated.reason };
      return { ok: true, action: { type: "SET_CUSTOMER_PHONE", customerPhone: validated.value } };
    }
    case "SET_FULFILLMENT": {
      // Único valor aceito é "RETIRADA" — mesmo que o LLM afirme que o
      // cliente pediu entrega, ENTREGA/DELIVERY/MOTOBOY nunca chegam ao Engine.
      if (a.fulfillmentType !== "RETIRADA") return { ok: false, reason: "FULFILLMENT_NOT_ALLOWED" };
      return { ok: true, action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" } };
    }
    case "SET_PICKUP_TIME": {
      const resolved = resolvePickupTime(context, a.pickupTime);
      if (resolved.ok === false) return { ok: false, reason: resolved.reason };
      return { ok: true, action: { type: "SET_PICKUP_TIME", pickupTime: resolved.value } };
    }
    case "SET_CUSTOMER_NOTES": {
      const validated = validateCustomerNotes(a.customerNotes);
      if (validated.ok === false) return { ok: false, reason: validated.reason };
      return { ok: true, action: { type: "SET_CUSTOMER_NOTES", customerNotes: validated.value } };
    }
    case "SKIP_CUSTOMER_NOTES":
      return { ok: true, action: { type: "SKIP_CUSTOMER_NOTES" } };
    case "SET_PAYMENT_METHOD": {
      const resolved = resolvePaymentMethod(context, a.paymentMethod);
      if (resolved.ok === false) return { ok: false, reason: resolved.reason };
      return { ok: true, action: { type: "SET_PAYMENT_METHOD", paymentMethod: resolved.value } };
    }
    case "REVIEW_ORDER":
      return { ok: true, action: { type: "REVIEW_ORDER" } };
    case "CONFIRM_ORDER":
      return { ok: true, action: { type: "CONFIRM_ORDER" } };
    case "GO_BACK":
      return { ok: true, action: { type: "GO_BACK" } };
    case "CANCEL_CONVERSATION":
      return { ok: true, action: { type: "CANCEL_CONVERSATION" } };
    case "RESET_CONVERSATION":
      return { ok: true, action: { type: "RESET_CONVERSATION" } };
    case "REQUEST_HUMAN":
      return { ok: true, action: { type: "REQUEST_HUMAN" } };
    default:
      return { ok: false, reason: "ACTION_NOT_ALLOWED" };
  }
}

// --- validação do lote completo ----------------------------------------------

function extractSuggestions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const suggestions = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim());
  return suggestions.length > 0 ? suggestions : undefined;
}

export type LlmOutputCandidate = { action: AgentConversationAction; label?: string };

// Candidatos de AMBIGUOUS nunca são executados — inválidos são apenas
// descartados, sem rejeitar o resultado AMBIGUOUS inteiro por causa deles.
function extractCandidates(
  raw: unknown,
  session: AgentSession,
  context: LlmInterpreterContext | undefined,
): LlmOutputCandidate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const candidates: LlmOutputCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const validated = validateAction(obj.action, session, context);
    if (validated.ok === false) continue;
    const label = typeof obj.label === "string" ? obj.label : undefined;
    candidates.push(label ? { action: validated.action, label } : { action: validated.action });
  }
  return candidates.length > 0 ? candidates : undefined;
}

export type ValidateLlmOutputInput = {
  raw: unknown;
  session: AgentSession;
  context?: LlmInterpreterContext;
  maxOutputLength?: number;
};

export type ValidatedLlmOutput =
  | { status: "MATCHED"; actions: AgentConversationAction[] }
  | { status: "NOT_UNDERSTOOD"; reason: string; suggestions?: string[] }
  | { status: "AMBIGUOUS"; reason: string; candidates?: LlmOutputCandidate[] }
  | { status: "REJECTED"; reason: string };

export function validateLlmOutput(input: ValidateLlmOutputInput): ValidatedLlmOutput {
  const parsed = parseLlmOutput(input.raw, input.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH);
  if (parsed.ok === false) return { status: "REJECTED", reason: parsed.reason };

  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "REJECTED", reason: "INVALID_SCHEMA" };
  }
  const raw = value as Record<string, unknown>;
  const { session, context } = input;

  if (raw.status === "MATCHED") {
    const rawActions = raw.actions;
    if (!Array.isArray(rawActions) || rawActions.length === 0) {
      return { status: "REJECTED", reason: "ACTIONS_REQUIRED" };
    }
    if (rawActions.length > MAX_ACTIONS_PER_MESSAGE) {
      return { status: "REJECTED", reason: "TOO_MANY_ACTIONS" };
    }

    // Lote é atômico: uma ação inválida rejeita o lote inteiro, nunca
    // executa parcialmente.
    const actions: AgentConversationAction[] = [];
    for (const rawAction of rawActions) {
      const validated = validateAction(rawAction, session, context);
      if (validated.ok === false) return { status: "REJECTED", reason: validated.reason };
      actions.push(validated.action);
    }

    const hasConfirm = actions.some(action => action.type === "CONFIRM_ORDER");
    if (hasConfirm && actions.length > 1) {
      return { status: "REJECTED", reason: "CONFIRM_ORDER_MUST_BE_ALONE" };
    }

    return { status: "MATCHED", actions };
  }

  if (raw.status === "NOT_UNDERSTOOD") {
    const reason = raw.reason;
    if (typeof reason !== "string" || !reason.trim()) return { status: "REJECTED", reason: "REASON_REQUIRED" };
    if (Array.isArray(raw.actions) && raw.actions.length > 0) {
      return { status: "REJECTED", reason: "ACTIONS_NOT_ALLOWED" };
    }
    const suggestions = extractSuggestions(raw.suggestions);
    return suggestions ? { status: "NOT_UNDERSTOOD", reason, suggestions } : { status: "NOT_UNDERSTOOD", reason };
  }

  if (raw.status === "AMBIGUOUS") {
    const reason = raw.reason;
    if (typeof reason !== "string" || !reason.trim()) return { status: "REJECTED", reason: "REASON_REQUIRED" };
    const candidates = extractCandidates(raw.candidates, session, context);
    return candidates ? { status: "AMBIGUOUS", reason, candidates } : { status: "AMBIGUOUS", reason };
  }

  return { status: "REJECTED", reason: "UNKNOWN_STATUS" };
}
