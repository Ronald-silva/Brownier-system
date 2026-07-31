// Response Strategy Policy — a ÚNICA peça do pipeline que decide se um turno
// vira TEMPLATE ou VERBALIZE. Nunca o modelo: função pura, sem acesso a
// provider, rede, sessão ou Tools. O planejamento (chamada NVIDIA #1) só
// entrega confidence + responseIntent (objetivo comunicativo) — decidir o
// canal de saída é sempre desta função.
import type { AllowedFact, RenderStrategy, ResponseIntent } from "./conversation-intelligence.types.ts";

export type DecideRenderStrategyInput = {
  confidence: "HIGH" | "LOW";
  responseIntent: ResponseIntent;
  facts: AllowedFact[];
  // Sinal determinístico do que o Engine realmente executou/produziu neste
  // turno — nunca o que o modelo *declarou* ter feito. Usado só pela Regra
  // 0 (confirmação de pedido), que nunca pode depender exclusivamente de
  // responseIntent (campo auto-reportado pelo planejamento NVIDIA).
  executedActionType?: string;
  messageKey?: string;
};

// Intenções que dependem de fato autorizado para dizer algo verdadeiro —
// sem nenhum AllowedFact, verbalizar significaria ou inventar, ou escrever
// em volta do vazio. Intenções sociais/de recusa/handoff nunca precisam de
// fato: "sem fatos = template" NÃO se aplica a elas.
const RESPONSE_INTENTS_REQUIRING_FACTS: ReadonlySet<ResponseIntent["kind"]> = new Set(["ANSWER_FACTUAL", "OFFER_SUGGESTION"]);

// messageKeys que representam confirmação de pedido bem-sucedida — as duas
// únicas entradas de messages.ts que citam publicCode/"Pedido criado"
// (handleConfirmOrder em conversation.engine.ts nunca produz outro
// messageKey de sucesso). Mantido em sincronia manual com messages.ts.
const ORDER_CONFIRMATION_MESSAGE_KEYS: ReadonlySet<string> = new Set(["ORDER_CREATED", "ORDER_ALREADY_CREATED"]);

export function decideRenderStrategy(input: DecideRenderStrategyInput): RenderStrategy {
  const { confidence, responseIntent, facts, executedActionType, messageKey } = input;

  // Regra 0: confirmação de pedido (CONFIRM_ORDER, em qualquer resultado —
  // sucesso ou falha de negócio — ou um messageKey de sucesso) sempre força
  // template, incondicionalmente e antes de qualquer outra regra. Nunca
  // depende de responseIntent: esse campo é auto-reportado pelo modelo no
  // planejamento e não pode ser a única barreira para a mensagem mais
  // sensível do fluxo comercial.
  if (executedActionType === "CONFIRM_ORDER" || (messageKey !== undefined && ORDER_CONFIRMATION_MESSAGE_KEYS.has(messageKey))) {
    return "TEMPLATE";
  }

  // Regra 1: confiança baixa do planejamento sempre força template, sem
  // exceção — independente do restante do plano.
  if (confidence === "LOW") return "TEMPLATE";

  // Regra 2 (rota de economia): confirmação de uma ação transacional trivial
  // já tem um template específico e inequívoco (ex.: ITEM_ADDED) — verbalizar
  // não agrega nada e só aumenta latência/custo sem benefício de UX.
  if (responseIntent.kind === "CONFIRM_ACTION_RESULT") return "TEMPLATE";

  // Regra 3: intenções que dependem de fato para dizer algo verdadeiro nunca
  // verbalizam sem nenhum AllowedFact autorizado.
  if (RESPONSE_INTENTS_REQUIRING_FACTS.has(responseIntent.kind) && facts.length === 0) return "TEMPLATE";

  // Regra 4: qualquer outro caso (social, esclarecimento, objeção, recusa de
  // fora de escopo, handoff) pode ser verbalizado mesmo sem fatos — são
  // objetivos puramente comunicativos, não afirmações de negócio.
  return "VERBALIZE";
}
