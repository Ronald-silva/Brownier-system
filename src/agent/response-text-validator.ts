// Response Text Validator — grounding check fail-closed que roda depois de
// toda VerbalizationResult.status === "VERBALIZED", antes de qualquer envio.
// Mesma filosofia que llm-output-validator.ts já aplica a actions[] (allowlist
// fechada, nunca fuzzy): aqui a "allowlist" é o conjunto de AllowedFact[] do
// turno. Qualquer falha em qualquer checagem rejeita o texto inteiro — nunca
// um envio parcial ou "quase certo". Rejeição sempre cai no template
// (fallbackMessageKey do TurnOutcome).
import { normalizeInterpreterText } from "./deterministic-interpreter.ts";
import { VERBALIZER_RESPONSE_TEXT_MAX_LENGTH } from "./providers/verbalizer-response-schema.ts";
import type { AllowedFact } from "./conversation-intelligence.types.ts";

export type ValidateResponseTextInput = {
  text: string;
  usedFactIds: string[];
  facts: AllowedFact[];
  // Nomes reais do catálogo completo (não só os autorizados neste turno) —
  // opcional; quando presente, permite rejeitar a citação de um produto real
  // do cardápio que não foi autorizado neste turno (defesa extra, além da
  // checagem contra os PRODUCT facts do próprio turno).
  catalogProductNames?: string[];
};

export type ResponseTextValidationResult = { ok: true } | { ok: false; reason: string };

function ok(): ResponseTextValidationResult {
  return { ok: true };
}
function fail(reason: string): ResponseTextValidationResult {
  return { ok: false, reason };
}

// Mesma forma de proteção já usada em text-conversation.service.ts para
// sugestões públicas — telefone (4+ dígitos seguidos), URL e handle nunca
// passam, autorizados ou não.
const UNSAFE_CONTACT_PATTERN = /\d{4,}|http|www\.|@/i;
// Promessas operacionais não verificáveis fazem a conversa parecer atendida,
// mas não acionam nenhuma ação real. O texto do LLM deve cair no template
// seguro em vez de prometer retorno, equipe ou confirmação.
const UNSUPPORTED_PROMISE_PATTERN = /\b(vou verificar|vou confirmar|te passo|aguarde|a equipe|nossa equipe)\b/i;

const MONEY_PATTERN = /R\$\s?(\d{1,4}(?:[.,]\d{2})?)/g;
const TIME_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const OPEN_CLOSED_PATTERN = /\b(abert[ao]s?|fechad[ao]s?|funcionando|funcionamos)\b/i;
const ADDRESS_LIKE_PATTERN = /\b(rua|av\.|avenida|alameda|travessa|estrada|rodovia)\b/i;

function parseMoneyToCents(raw: string): number {
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  return Math.round(Number(normalized) * 100);
}

function priceValuesInCents(fact: AllowedFact): number[] {
  if (fact.key !== "PRODUCT") return [];
  const values = [Math.round(fact.price * 100)];
  if (fact.promotionalPrice !== null) values.push(Math.round(fact.promotionalPrice * 100));
  return values;
}

function normalizeTimeMatch(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute}`;
}

function authorizedTimes(referenced: AllowedFact[]): Set<string> {
  const times = new Set<string>();
  for (const fact of referenced) {
    if (fact.key === "OPERATING_STATUS" && fact.status.known) {
      if (fact.status.currentClose) times.add(fact.status.currentClose);
      if (fact.status.nextOpen) times.add(fact.status.nextOpen.time);
    }
    if (fact.key === "PICKUP_SLOTS") {
      for (const slot of fact.slots) times.add(slot);
    }
  }
  return times;
}

export function validateResponseText(input: ValidateResponseTextInput): ResponseTextValidationResult {
  try {
    const { text, usedFactIds, facts, catalogProductNames } = input;

    if (typeof text !== "string" || !text.trim()) return fail("EMPTY_TEXT");
    if (text.length > VERBALIZER_RESPONSE_TEXT_MAX_LENGTH) return fail("TEXT_TOO_LONG");
    if (UNSAFE_CONTACT_PATTERN.test(text)) return fail("UNSAFE_CONTACT_MENTION");
    if (UNSUPPORTED_PROMISE_PATTERN.test(text)) return fail("UNSUPPORTED_OPERATIONAL_PROMISE");

    const factsById = new Map(facts.map(fact => [fact.factId, fact] as const));
    for (const id of usedFactIds) {
      if (!factsById.has(id)) return fail("UNKNOWN_USED_FACT_ID");
    }
    const referenced = usedFactIds.map(id => factsById.get(id)!).filter(Boolean);

    // --- valores monetários -------------------------------------------------
    const authorizedCents = new Set(referenced.flatMap(priceValuesInCents));
    for (const match of text.matchAll(MONEY_PATTERN)) {
      const cents = parseMoneyToCents(match[1]!);
      if (!authorizedCents.has(cents)) return fail("UNAUTHORIZED_PRICE");
    }

    // --- produtos citados -----------------------------------------------------
    const normalizedText = normalizeInterpreterText(text);
    const referencedProductIds = new Set(referenced.filter(f => f.key === "PRODUCT").map(f => f.id));
    for (const fact of facts) {
      if (fact.key !== "PRODUCT") continue;
      const normalizedName = normalizeInterpreterText(fact.name);
      if (normalizedName.length < 3) continue;
      if (normalizedText.includes(normalizedName) && !referencedProductIds.has(fact.id)) {
        return fail("UNAUTHORIZED_PRODUCT_CITATION");
      }
    }
    if (Array.isArray(catalogProductNames)) {
      const authorizedProductNames = new Set(facts.filter(f => f.key === "PRODUCT").map(f => normalizeInterpreterText(f.name)));
      for (const rawName of catalogProductNames) {
        const normalizedName = normalizeInterpreterText(rawName);
        if (normalizedName.length < 3 || authorizedProductNames.has(normalizedName)) continue;
        if (normalizedText.includes(normalizedName)) return fail("UNAUTHORIZED_PRODUCT_CITATION");
      }
    }

    // --- endereço ---------------------------------------------------------
    const addressFact = referenced.find((f): f is Extract<AllowedFact, { key: "BUSINESS_ADDRESS" }> => f.key === "BUSINESS_ADDRESS");
    if (addressFact) {
      if (!text.includes(addressFact.address)) return fail("ADDRESS_MISMATCH");
    } else if (ADDRESS_LIKE_PATTERN.test(text)) {
      return fail("UNAUTHORIZED_ADDRESS_MENTION");
    }

    // --- aberto/fechado -----------------------------------------------------
    if (OPEN_CLOSED_PATTERN.test(text)) {
      const statusFact = referenced.find((f): f is Extract<AllowedFact, { key: "OPERATING_STATUS" }> => f.key === "OPERATING_STATUS");
      if (!statusFact || !statusFact.status.known) return fail("UNAUTHORIZED_OPERATING_STATUS_CLAIM");
    }

    // --- horários específicos ------------------------------------------------
    const authorizedTimeSet = authorizedTimes(referenced);
    for (const match of text.matchAll(TIME_PATTERN)) {
      const normalized = normalizeTimeMatch(match[1]!, match[2]!);
      if (!authorizedTimeSet.has(normalized)) return fail("UNAUTHORIZED_TIME");
    }

    return ok();
  } catch {
    // Fail-closed: qualquer erro inesperado rejeita o texto, nunca deixa
    // passar por omissão.
    return fail("VALIDATION_ERROR");
  }
}
