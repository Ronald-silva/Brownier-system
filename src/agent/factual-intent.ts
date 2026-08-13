import { normalizeInterpreterText } from "./deterministic-interpreter.ts";
import type { OperatingStatus } from "./operating-status.ts";

export type FactualIntent =
  | { kind: "ADDRESS"; address?: string }
  | { kind: "PICKUP_AVAILABILITY"; status: OperatingStatus }
  | { kind: "CART_TOTAL" }
  | { kind: "RESPONSIBLE"; name?: string }
  | { kind: "PAYMENT_OPTIONS" }
  | { kind: "PIX_KEY" }
  | { kind: "PAYMENT_PROOF" }
  | { kind: "OPERATING_HOURS" }
  | { kind: "DELIVERY" }
  | { kind: "OUT_OF_SCOPE_PRODUCT" }
  | { kind: "MENU" };

function tokens(text: string): Set<string> {
  return new Set(normalizeInterpreterText(text).split(" ").filter(Boolean));
}

// Palavras que por si só perguntam sobre o estado aberto/fechado, mesmo sem
// menção a "retirada"/"agora" (ex.: "vocês estão abertos?", "que horas
// abre?"). Combinadas com pickupContext+asksNow, cobrem as quatro perguntas
// pedidas: "está aberto?", "posso retirar agora?", "que horas abre?",
// "posso buscar hoje?".
const OPEN_STATE_WORDS = new Set([
  "aberto", "aberta", "abertos", "abertas", "abre", "abrem", "abriu",
  "funciona", "funcionam", "funcionando",
  "fechado", "fechada", "fechados", "fechadas",
]);

// A demo não deve consumir as tentativas do cliente quando ele pergunta por
// itens claramente fora de uma brownieria. Esta lista deliberadamente cobre
// produtos de feira comuns, não nomes de brownies; a resposta não afirma
// disponibilidade de nada, apenas redireciona ao cardápio real.
const OUT_OF_SCOPE_PRODUCE_WORDS = new Set([
  "manga", "uva", "pera", "morango", "banana", "maca", "laranja", "abacaxi",
  "melancia", "mamao", "limao", "goiaba", "acai", "tomate", "batata",
]);

// Intenções factuais são conceitos do domínio, não uma lista de frases. Elas
// têm prioridade porque a resposta vem do Store e não exige inferência nem
// pode ser inventada pelo provider — inclui o cálculo determinístico de
// horário (operating-status.ts), nunca o texto cru interpretado pelo modelo.
export function resolveFactualIntent(input: {
  text: string;
  address?: string;
  operatingStatus?: OperatingStatus;
}): FactualIntent | undefined {
  const words = tokens(input.text);
  const asksLocation = words.has("endereco") || words.has("localizacao") || words.has("onde") || words.has("local");
  const pickupContext = words.has("retirada") || words.has("retirar") || words.has("coleta") || words.has("coletar") || words.has("buscar") || words.has("pegar") || words.has("loja") || words.has("fica") || words.has("ficam");
  // No canal da loja, uma pergunta explícita pelo endereço já se refere ao
  // endereço comercial; os demais termos desambiguam "onde/local".
  if (words.has("endereco") || words.has("localizacao") || (asksLocation && pickupContext)) {
    const address = input.address?.trim();
    return address ? { kind: "ADDRESS", address } : { kind: "ADDRESS" };
  }

  if (words.has("kg") || words.has("quilo") || words.has("kilo") || [...OUT_OF_SCOPE_PRODUCE_WORDS].some(word => words.has(word))) {
    return { kind: "OUT_OF_SCOPE_PRODUCT" };
  }

  const asksNow = words.has("agora") || words.has("hoje") || words.has("horario") || (words.has("ate") && words.has("horas"));
  const asksWeekend = (words.has("fim") || words.has("finais")) && words.has("semana");
  const asksSchedule = (words.has("horario") && (words.has("funcionamento") || words.has("funciona"))) || asksWeekend;
  if (asksSchedule) return { kind: "OPERATING_HOURS" };
  if (words.has("comprovante")) return { kind: "PAYMENT_PROOF" };
  const asksOpenState = [...OPEN_STATE_WORDS].some(word => words.has(word));
  if ((pickupContext && asksNow) || asksOpenState) {
    return { kind: "PICKUP_AVAILABILITY", status: input.operatingStatus ?? { known: false } };
  }

  // "total" é sempre sobre o pedido em andamento. Tratamos antes do
  // cardápio, pois frases como "qual o valor total?" não devem reabrir o
  // menu nem depender de uma chamada ao modelo.
  if (words.has("total") || words.has("subtotal")) {
    return { kind: "CART_TOTAL" };
  }

  if (words.has("responsavel") || (words.has("quem") && (words.has("fala") || words.has("falo")))) {
    return { kind: "RESPONSIBLE" };
  }

  if (words.has("pix") && (words.has("chave") || words.has("qual") || words.has("codigo"))) {
    return { kind: "PIX_KEY" };
  }

  if (words.has("entrega") || words.has("entregas") || words.has("delivery") || (words.has("manda") && words.has("entregar"))) {
    return { kind: "DELIVERY" };
  }

  if (words.has("cartao") || words.has("cartoes") || words.has("pagamento") || words.has("pagar") || words.has("aceita")) {
    return { kind: "PAYMENT_OPTIONS" };
  }

  // Perguntas gerais sobre preço levam ao cardápio real. Perguntas por um
  // item específico ("tem água?", "vende bolo?") seguem para o modelo, que
  // compara o item com o catálogo público e responde sem afirmar uma
  // disponibilidade que não existe.
  const asksPrice = words.has("preco") || words.has("precos") || words.has("dindin");
  if (words.has("menu") || words.has("cardapio") || words.has("sabores") || words.has("preco") || words.has("precos") || asksPrice) {
    return { kind: "MENU" };
  }
  return undefined;
}
