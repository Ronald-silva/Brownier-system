// Deterministic Message Interpreter — converte texto simples e inequívoco em
// uma AgentConversationAction estruturada, considerando a etapa atual da
// sessão e dados públicos de apresentação (produtos, formas de pagamento,
// horários de retirada). Nenhuma IA, nenhuma consulta a Agent Tools e
// nenhum fuzzy matching: apenas comparações exatas contra listas fechadas de
// frases e padrões estruturais simples. Quando não há correspondência segura,
// devolve NOT_UNDERSTOOD ou AMBIGUOUS — nunca escolhe por adivinhação.
import { randomUUID } from "node:crypto";
import type { AgentConversationAction } from "./conversation.types.ts";
import type { AgentSession, AgentConversationStep } from "./session.types.ts";
import type { AgentPresentationProduct } from "./presentation.ts";
import type { AgentChatMessage } from "./renderer.ts";
import type {
  DeterministicInterpretationAmbiguous,
  DeterministicInterpretationCandidate,
  DeterministicInterpretationMatched,
  DeterministicInterpretationNotUnderstood,
  DeterministicInterpretationResult,
  DeterministicInterpreterContext,
  InterpretDeterministicMessageInput,
} from "./interpreter.types.ts";

const MAX_CUSTOMER_NAME_LENGTH = 120;
const MAX_ITEM_QUANTITY = 100;

// --- normalização --------------------------------------------------------

// Normalização apenas para COMPARAÇÃO — nunca usada para gravar nome,
// telefone ou observação (que preservam o texto original com trim).
export function normalizeInterpreterText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[.,!?;…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- construtores de resultado --------------------------------------------

function matched(action: AgentConversationAction, source: string, normalizedText: string): DeterministicInterpretationMatched {
  return { status: "MATCHED", action, confidence: 1, source, normalizedText };
}

function notUnderstood(reason: string, normalizedText: string, suggestions?: string[]): DeterministicInterpretationNotUnderstood {
  return suggestions ? { status: "NOT_UNDERSTOOD", reason, normalizedText, suggestions } : { status: "NOT_UNDERSTOOD", reason, normalizedText };
}

function ambiguous(
  reason: string,
  normalizedText: string,
  candidates?: DeterministicInterpretationCandidate[],
): DeterministicInterpretationAmbiguous {
  return candidates ? { status: "AMBIGUOUS", reason, normalizedText, candidates } : { status: "AMBIGUOUS", reason, normalizedText };
}

function isValidQuantity(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_ITEM_QUANTITY;
}

// --- comandos globais ------------------------------------------------------

const GLOBAL_COMMAND_PHRASES: Record<string, AgentConversationAction> = {
  menu: { type: "SHOW_MENU" },
  cardapio: { type: "SHOW_MENU" },
  "ver menu": { type: "SHOW_MENU" },
  "ver cardapio": { type: "SHOW_MENU" },
  "quero ver o cardapio": { type: "SHOW_MENU" },
  "poderia mandar o menu": { type: "SHOW_MENU" },
  "manda o menu": { type: "SHOW_MENU" },
  "quero o menu": { type: "SHOW_MENU" },
  "quais sao os sabores": { type: "SHOW_MENU" },
  "o que tem hoje": { type: "SHOW_MENU" },
  produtos: { type: "SHOW_MENU" },
  opcoes: { type: "SHOW_MENU" },

  cancelar: { type: "CANCEL_CONVERSATION" },
  cancela: { type: "CANCEL_CONVERSATION" },
  desistir: { type: "CANCEL_CONVERSATION" },
  "parar pedido": { type: "CANCEL_CONVERSATION" },
  "cancelar pedido": { type: "CANCEL_CONVERSATION" },

  atendente: { type: "REQUEST_HUMAN" },
  "atendimento humano": { type: "REQUEST_HUMAN" },
  "falar com atendente": { type: "REQUEST_HUMAN" },
  "falar com uma pessoa": { type: "REQUEST_HUMAN" },
  humano: { type: "REQUEST_HUMAN" },
  suporte: { type: "REQUEST_HUMAN" },

  recomecar: { type: "RESET_CONVERSATION" },
  "comecar novamente": { type: "RESET_CONVERSATION" },
  "novo pedido": { type: "RESET_CONVERSATION" },
  reiniciar: { type: "RESET_CONVERSATION" },

  voltar: { type: "GO_BACK" },
  volta: { type: "GO_BACK" },
  anterior: { type: "GO_BACK" },
  retornar: { type: "GO_BACK" },
  "corrigir anterior": { type: "GO_BACK" },
};

function matchGlobalCommand(normalizedText: string): AgentConversationAction | undefined {
  return GLOBAL_COMMAND_PHRASES[normalizedText];
}

// --- telefone --------------------------------------------------------------

const PHONE_PREFIX_REGEX = /^\s*(meu telefone (e|é)|whatsapp)\s*:?\s*/i;
const PHONE_CHARS_REGEX = /^[+()\-\s\d]+$/;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

function tryExtractPhone(originalTrimmed: string): string | undefined {
  const candidate = originalTrimmed.replace(PHONE_PREFIX_REGEX, "").trim();
  if (!candidate || !PHONE_CHARS_REGEX.test(candidate)) return undefined;
  const digitCount = candidate.replace(/\D/g, "").length;
  if (digitCount < MIN_PHONE_DIGITS || digitCount > MAX_PHONE_DIGITS) return undefined;
  return candidate;
}

const PHONE_ELIGIBLE_STEPS: ReadonlySet<AgentConversationStep> = new Set([
  "COLLECTING_NAME",
  "COLLECTING_FULFILLMENT",
  "COLLECTING_PICKUP_TIME",
  "COLLECTING_NOTES",
  "COLLECTING_PAYMENT",
]);

// --- START -----------------------------------------------------------------

const START_GREETINGS: ReadonlySet<string> = new Set([
  "oi",
  "ola",
  "bom dia",
  "boa tarde",
  "boa noite",
  "ola boa noite",
  "iniciar",
  "comecar",
  "fazer pedido",
  "quero fazer um pedido",
]);

function interpretStart(normalizedText: string): DeterministicInterpretationResult {
  if (START_GREETINGS.has(normalizedText)) {
    return matched({ type: "START_CONVERSATION" }, "START_GREETING", normalizedText);
  }
  return notUnderstood("GENERIC", normalizedText);
}

// --- produtos e carrinho -----------------------------------------------

const FINISH_CART_PHRASES: ReadonlySet<string> = new Set([
  "finalizar",
  "continuar",
  "fechar pedido",
  "concluir itens",
  "pronto",
  "so isso",
  "e so",
]);

const CLEAR_CART_PHRASES: ReadonlySet<string> = new Set(["limpar carrinho", "remover tudo", "zerar carrinho"]);

function resolveProductByPosition(products: AgentPresentationProduct[], position: number): AgentPresentationProduct | undefined {
  if (!Number.isInteger(position) || position < 1 || position > products.length) return undefined;
  return products[position - 1];
}

// Variantes determinísticas do nome normalizado aceitas para comparação:
// o nome tal como está, e o nome com a PRIMEIRA palavra pluralizada com "s"
// (ex.: "brownie ninho" -> também aceita "brownies ninho"). Não é
// similaridade aproximada: é uma regra fixa, sempre a mesma transformação.
function productNameVariants(name: string): string[] {
  const normalized = normalizeInterpreterText(name);
  const words = normalized.split(" ");
  const variants = [normalized];
  if (words.length > 0 && words[0]) {
    variants.push([`${words[0]}s`, ...words.slice(1)].join(" "));
  }
  return variants;
}

function resolveProductsByNameTail(
  products: AgentPresentationProduct[],
  tail: string,
  allowPluralFirstWord: boolean,
): AgentPresentationProduct[] {
  return products.filter(product => {
    const variants = allowPluralFirstWord ? productNameVariants(product.name) : [normalizeInterpreterText(product.name)];
    return variants.includes(tail);
  });
}

function resolveAddByPosition(
  products: AgentPresentationProduct[],
  quantityRaw: string,
  positionRaw: string,
  normalizedText: string,
  source: string,
): DeterministicInterpretationResult {
  const quantity = Number(quantityRaw);
  const position = Number(positionRaw);
  const product = resolveProductByPosition(products, position);
  if (!product) return notUnderstood("INVALID_PRODUCT_POSITION", normalizedText);
  if (!isValidQuantity(quantity)) return notUnderstood("INVALID_QUANTITY", normalizedText);
  return matched({ type: "ADD_ITEM", productId: product.id, quantity }, source, normalizedText);
}

function toCandidates(products: AgentPresentationProduct[], build: (product: AgentPresentationProduct) => AgentConversationAction): DeterministicInterpretationCandidate[] {
  return products.map(product => ({ action: build(product), label: product.name }));
}

function interpretProductsAndCart(
  step: "BROWSING_MENU" | "BUILDING_ORDER",
  normalizedText: string,
  context: DeterministicInterpreterContext | undefined,
): DeterministicInterpretationResult {
  const products = context?.products ?? [];

  if (step === "BUILDING_ORDER" && CLEAR_CART_PHRASES.has(normalizedText)) {
    return matched({ type: "CLEAR_CART" }, "CLEAR_CART_COMMAND", normalizedText);
  }

  if (FINISH_CART_PHRASES.has(normalizedText)) {
    return matched({ type: "FINISH_CART" }, "FINISH_CART_COMMAND", normalizedText);
  }

  if (step === "BUILDING_ORDER") {
    if (/^tira\s+\d+$/.test(normalizedText)) {
      return ambiguous("AMBIGUOUS_REMOVE_TARGET", normalizedText);
    }

    const removePositionMatch = /^(?:remover|tirar opcao)\s+(\d+)$/.exec(normalizedText);
    if (removePositionMatch) {
      const product = resolveProductByPosition(products, Number(removePositionMatch[1]));
      if (!product) return notUnderstood("INVALID_PRODUCT_POSITION", normalizedText);
      return matched({ type: "REMOVE_ITEM", productId: product.id }, "REMOVE_BY_POSITION", normalizedText);
    }

    const removeNameMatch = /^remover\s+(.+)$/.exec(normalizedText);
    if (removeNameMatch) {
      const matches = resolveProductsByNameTail(products, removeNameMatch[1]!, false);
      if (matches.length === 0) return notUnderstood("PRODUCT_NOT_FOUND", normalizedText);
      if (matches.length > 1) {
        return ambiguous("AMBIGUOUS_PRODUCT", normalizedText, toCandidates(matches, p => ({ type: "REMOVE_ITEM", productId: p.id })));
      }
      return matched({ type: "REMOVE_ITEM", productId: matches[0]!.id }, "REMOVE_BY_NAME", normalizedText);
    }

    const positionUpdateMatch =
      /^alterar opcao (\d+) para (\d+)$/.exec(normalizedText) ?? /^opcao (\d+) quantidade (\d+)$/.exec(normalizedText);
    if (positionUpdateMatch) {
      const product = resolveProductByPosition(products, Number(positionUpdateMatch[1]));
      if (!product) return notUnderstood("INVALID_PRODUCT_POSITION", normalizedText);
      const quantity = Number(positionUpdateMatch[2]);
      if (!isValidQuantity(quantity)) return notUnderstood("INVALID_QUANTITY", normalizedText);
      return matched({ type: "UPDATE_ITEM_QUANTITY", productId: product.id, quantity }, "UPDATE_BY_POSITION", normalizedText);
    }

    const deixarMatch = /^deixar (\d+) (.+)$/.exec(normalizedText);
    if (deixarMatch) {
      const matches = resolveProductsByNameTail(products, deixarMatch[2]!, true);
      if (matches.length === 0) return notUnderstood("PRODUCT_NOT_FOUND", normalizedText);
      if (matches.length > 1) {
        return ambiguous("AMBIGUOUS_PRODUCT", normalizedText);
      }
      const quantity = Number(deixarMatch[1]);
      if (!isValidQuantity(quantity)) return notUnderstood("INVALID_QUANTITY", normalizedText);
      return matched({ type: "UPDATE_ITEM_QUANTITY", productId: matches[0]!.id, quantity }, "UPDATE_BY_NAME", normalizedText);
    }
  }

  const withoutQuero = normalizedText.replace(/^quero\s+/, "");

  const unidadesMatch = /^(\d+)\s*unidades?\s*da\s*opcao\s*(\d+)$/.exec(withoutQuero);
  if (unidadesMatch) return resolveAddByPosition(products, unidadesMatch[1]!, unidadesMatch[2]!, normalizedText, "ADD_BY_POSITION");

  const doNumeroMatch = /^(\d+)\s*do\s*numero\s*(\d+)$/.exec(withoutQuero);
  if (doNumeroMatch) return resolveAddByPosition(products, doNumeroMatch[1]!, doNumeroMatch[2]!, normalizedText, "ADD_BY_POSITION");

  const xMatch = /^(\d+)\s*x\s*(\d+)$/.exec(withoutQuero);
  if (xMatch) return resolveAddByPosition(products, xMatch[1]!, xMatch[2]!, normalizedText, "ADD_BY_POSITION");

  const pureNumberMatch = /^(\d+)$/.exec(withoutQuero);
  if (pureNumberMatch) return resolveAddByPosition(products, "1", pureNumberMatch[1]!, normalizedText, "ADD_BY_POSITION");

  const qtyNameMatch = /^(\d+)\s+(.+)$/.exec(withoutQuero);
  if (qtyNameMatch) {
    const matches = resolveProductsByNameTail(products, qtyNameMatch[2]!, true);
    if (matches.length === 0) return notUnderstood("PRODUCT_NOT_FOUND", normalizedText);
    if (matches.length > 1) return ambiguous("AMBIGUOUS_PRODUCT", normalizedText);
    const quantity = Number(qtyNameMatch[1]);
    if (!isValidQuantity(quantity)) return notUnderstood("INVALID_QUANTITY", normalizedText);
    return matched({ type: "ADD_ITEM", productId: matches[0]!.id, quantity }, "ADD_BY_NAME_WITH_QUANTITY", normalizedText);
  }

  const nameOnlyMatches = resolveProductsByNameTail(products, withoutQuero, false);
  if (nameOnlyMatches.length === 1) {
    return matched({ type: "ADD_ITEM", productId: nameOnlyMatches[0]!.id, quantity: 1 }, "ADD_BY_NAME", normalizedText);
  }
  if (nameOnlyMatches.length > 1) {
    return ambiguous(
      "AMBIGUOUS_PRODUCT",
      normalizedText,
      toCandidates(nameOnlyMatches, p => ({ type: "ADD_ITEM", productId: p.id, quantity: 1 })),
    );
  }

  return notUnderstood("PRODUCT_NOT_FOUND", normalizedText);
}

// --- nome do cliente ------------------------------------------------------

const NAME_PREFIX_REGEX = /^\s*(meu nome (e|é)|me chamo|pode colocar|nome\s*:)\s*/i;
const ONLY_DIGITS_LIKE_REGEX = /^[\d\s()+-]+$/;

function interpretCollectingName(originalTrimmed: string, normalizedText: string): DeterministicInterpretationResult {
  const stripped = originalTrimmed.replace(NAME_PREFIX_REGEX, "").trim();
  if (!stripped) return notUnderstood("INVALID_CUSTOMER_NAME", normalizedText);
  if (ONLY_DIGITS_LIKE_REGEX.test(stripped)) return notUnderstood("INVALID_CUSTOMER_NAME", normalizedText);
  if (stripped.length > MAX_CUSTOMER_NAME_LENGTH) return notUnderstood("INVALID_CUSTOMER_NAME", normalizedText);
  return matched({ type: "SET_CUSTOMER_NAME", customerName: stripped }, "CUSTOMER_NAME", normalizedText);
}

// --- retirada --------------------------------------------------------------

const FULFILLMENT_RETIRADA_PHRASES: ReadonlySet<string> = new Set([
  "retirada",
  "retirar",
  "vou buscar",
  "buscar no local",
  "pego ai",
  "uber moto",
  "vou mandar uber",
  "vou chamar uber moto",
]);

const DELIVERY_PHRASES: ReadonlySet<string> = new Set(["entrega", "delivery", "voces entregam", "manda entregar"]);

function interpretFulfillment(normalizedText: string): DeterministicInterpretationResult {
  if (FULFILLMENT_RETIRADA_PHRASES.has(normalizedText)) {
    return matched({ type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, "FULFILLMENT_RETIRADA", normalizedText);
  }
  if (DELIVERY_PHRASES.has(normalizedText)) {
    return notUnderstood("DELIVERY_NOT_SUPPORTED", normalizedText, ["RETIRADA"]);
  }
  return notUnderstood("GENERIC", normalizedText);
}

// --- horário de retirada -----------------------------------------------

function interpretPickupTime(normalizedText: string, context: DeterministicInterpreterContext | undefined): DeterministicInterpretationResult {
  const slots = context?.pickupSlots ?? [];
  if (slots.length === 0) return notUnderstood("PICKUP_SLOTS_UNAVAILABLE", normalizedText);

  const bySlot = slots.find(slot => normalizeInterpreterText(slot) === normalizedText);
  if (bySlot) return matched({ type: "SET_PICKUP_TIME", pickupTime: bySlot }, "PICKUP_TIME_EXACT", normalizedText);

  const positionMatch = /^(\d+)$/.exec(normalizedText);
  if (positionMatch) {
    const position = Number(positionMatch[1]);
    if (position < 1 || position > slots.length) return notUnderstood("INVALID_PICKUP_OPTION", normalizedText);
    return matched({ type: "SET_PICKUP_TIME", pickupTime: slots[position - 1]! }, "PICKUP_TIME_POSITION", normalizedText);
  }

  const phraseMatch = /^(?:as |a )?(\d{1,2})(?::(\d{2}))?\s*(?:h|horas)?$/.exec(normalizedText);
  if (phraseMatch) {
    const hour = phraseMatch[1]!.padStart(2, "0");
    const minute = phraseMatch[2] ?? "00";
    const candidate = `${hour}:${minute}`;
    const matchedSlot = slots.find(slot => normalizeInterpreterText(slot) === candidate);
    if (matchedSlot) return matched({ type: "SET_PICKUP_TIME", pickupTime: matchedSlot }, "PICKUP_TIME_PHRASE", normalizedText);
    return notUnderstood("INVALID_PICKUP_OPTION", normalizedText);
  }

  return notUnderstood("INVALID_PICKUP_OPTION", normalizedText);
}

// --- observações -------------------------------------------------------

const SKIP_NOTES_PHRASES: ReadonlySet<string> = new Set(["nao", "nenhuma", "sem observacao", "sem observacoes", "nao precisa", "pular"]);

function interpretNotes(originalTrimmed: string, normalizedText: string): DeterministicInterpretationResult {
  if (SKIP_NOTES_PHRASES.has(normalizedText)) {
    return matched({ type: "SKIP_CUSTOMER_NOTES" }, "NOTES_SKIP", normalizedText);
  }
  return matched({ type: "SET_CUSTOMER_NOTES", customerNotes: originalTrimmed }, "NOTES_TEXT", normalizedText);
}

// --- pagamento ------------------------------------------------------------

function normalizePaymentOption(option: string): string {
  return normalizeInterpreterText(option.replace(/_/g, " "));
}

function interpretPayment(normalizedText: string, context: DeterministicInterpreterContext | undefined): DeterministicInterpretationResult {
  const options = context?.paymentOptions ?? [];
  if (options.length === 0) return notUnderstood("PAYMENT_OPTIONS_UNAVAILABLE", normalizedText);

  const exact = options.find(option => normalizePaymentOption(option) === normalizedText);
  if (exact) return matched({ type: "SET_PAYMENT_METHOD", paymentMethod: exact }, "PAYMENT_EXACT", normalizedText);

  const positionMatch = /^(\d+)$/.exec(normalizedText);
  if (positionMatch) {
    const position = Number(positionMatch[1]);
    if (position < 1 || position > options.length) return notUnderstood("INVALID_PAYMENT_OPTION", normalizedText, options);
    return matched({ type: "SET_PAYMENT_METHOD", paymentMethod: options[position - 1]! }, "PAYMENT_POSITION", normalizedText);
  }

  const mentioned = options.filter(option => normalizedText.includes(normalizePaymentOption(option)));
  if (mentioned.length === 1) {
    return matched({ type: "SET_PAYMENT_METHOD", paymentMethod: mentioned[0]! }, "PAYMENT_PHRASE", normalizedText);
  }
  if (mentioned.length > 1) {
    return ambiguous("AMBIGUOUS_PAYMENT_OPTION", normalizedText);
  }

  return notUnderstood("INVALID_PAYMENT_OPTION", normalizedText, options);
}

// --- confirmação ---------------------------------------------------------

const CONFIRM_PHRASES: ReadonlySet<string> = new Set([
  "sim",
  "confirmar",
  "confirmo",
  "pode finalizar",
  "finalizar pedido",
  "tudo certo",
  "correto",
  "pode criar",
  "pode fechar",
]);

const GO_BACK_CONFIRM_PHRASES: ReadonlySet<string> = new Set(["nao", "corrigir", "quero alterar", "alterar pedido"]);

function interpretConfirmation(normalizedText: string): DeterministicInterpretationResult {
  if (CONFIRM_PHRASES.has(normalizedText)) return matched({ type: "CONFIRM_ORDER" }, "CONFIRM", normalizedText);
  if (GO_BACK_CONFIRM_PHRASES.has(normalizedText)) return matched({ type: "GO_BACK" }, "GO_BACK_CONFIRM", normalizedText);
  return notUnderstood("GENERIC", normalizedText);
}

// --- função principal ------------------------------------------------------

export function interpretDeterministicMessage(input: InterpretDeterministicMessageInput): DeterministicInterpretationResult {
  const { session, context } = input;
  const rawText = typeof input.text === "string" ? input.text : "";
  const originalTrimmed = rawText.trim();
  const normalizedText = normalizeInterpreterText(rawText);

  if (!normalizedText) {
    return notUnderstood("EMPTY_MESSAGE", normalizedText);
  }

  const humanHandoffBlocked = session.underHumanHandoff === true;
  const globalAction = matchGlobalCommand(normalizedText);

  if (globalAction) {
    if (humanHandoffBlocked && globalAction.type !== "RESET_CONVERSATION") {
      return notUnderstood("HUMAN_HANDOFF_ACTIVE", normalizedText);
    }
    return matched(globalAction, "GLOBAL_COMMAND", normalizedText);
  }

  if (humanHandoffBlocked) {
    return notUnderstood("HUMAN_HANDOFF_ACTIVE", normalizedText);
  }

  if (PHONE_ELIGIBLE_STEPS.has(session.step)) {
    const phone = tryExtractPhone(originalTrimmed);
    if (phone) {
      return matched({ type: "SET_CUSTOMER_PHONE", customerPhone: phone }, "PHONE_DETECTED", normalizedText);
    }
  }

  switch (session.step) {
    case "START":
      return interpretStart(normalizedText);
    case "BROWSING_MENU":
    case "BUILDING_ORDER":
      return interpretProductsAndCart(session.step, normalizedText, context);
    case "COLLECTING_NAME":
      return interpretCollectingName(originalTrimmed, normalizedText);
    case "COLLECTING_FULFILLMENT":
      return interpretFulfillment(normalizedText);
    case "COLLECTING_PICKUP_TIME":
      return interpretPickupTime(normalizedText, context);
    case "COLLECTING_NOTES":
      return interpretNotes(originalTrimmed, normalizedText);
    case "COLLECTING_PAYMENT":
      return interpretPayment(normalizedText, context);
    case "AWAITING_CONFIRMATION":
      return interpretConfirmation(normalizedText);
    case "ORDER_CREATED":
    case "HUMAN_HANDOFF":
    default:
      return notUnderstood("GENERIC", normalizedText);
  }
}

// --- renderização de falha de interpretação -------------------------------

const INTERPRETATION_FAILURE_MESSAGES: Record<string, string> = {
  DELIVERY_NOT_SUPPORTED: "Trabalhamos apenas com retirada. Você pode buscar no local ou solicitar um Uber Moto por sua conta.",
  HUMAN_HANDOFF_ACTIVE: "Você já está em atendimento humano. Aguarde só um instante.",
  AMBIGUOUS_PRODUCT: "Encontrei mais de uma possibilidade. Pode especificar melhor?",
  AMBIGUOUS_PAYMENT_OPTION: "Encontrei mais de uma possibilidade. Pode especificar melhor?",
  AMBIGUOUS_REMOVE_TARGET: "Encontrei mais de uma possibilidade. Pode especificar melhor?",
};

const GENERIC_NOT_UNDERSTOOD_MESSAGE = "Não consegui entender. Você pode responder usando uma das opções apresentadas?";
const GENERIC_AMBIGUOUS_MESSAGE = "Encontrei mais de uma possibilidade. Pode especificar melhor?";

export function renderInterpretationFailure(
  result: DeterministicInterpretationNotUnderstood | DeterministicInterpretationAmbiguous,
): AgentChatMessage[] {
  let text: string;
  if (result.status === "NOT_UNDERSTOOD" && result.reason === "INVALID_PAYMENT_OPTION" && result.suggestions?.length) {
    text = `Escolha uma das formas de pagamento disponíveis: ${result.suggestions.join(" ou ")}.`;
  } else if (result.status === "AMBIGUOUS") {
    text = INTERPRETATION_FAILURE_MESSAGES[result.reason] ?? GENERIC_AMBIGUOUS_MESSAGE;
  } else {
    text = INTERPRETATION_FAILURE_MESSAGES[result.reason] ?? GENERIC_NOT_UNDERSTOOD_MESSAGE;
  }

  return [
    {
      id: randomUUID(),
      type: "text",
      text,
      metadata: { interpretationStatus: result.status, interpretationReason: result.reason },
    },
  ];
}
