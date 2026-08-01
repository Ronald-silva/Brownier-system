// Testes de aceitação conversacional do fluxo híbrido (planejamento ->
// execução -> fatos -> verbalização -> validação -> fallback contextual).
// Verificam o texto final enviado ao WhatsApp (result.messages[0].text),
// nunca só intent/HTTP 200 — mesmo espírito da suíte de 55+ conversas da
// auditoria.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTextConversationService,
  type CreateTextConversationServiceDependencies,
  type VerbalizeWithLlmFn,
} from "../src/agent/text-conversation.service.ts";
import { createAgentConversationService } from "../src/agent/conversation.service.ts";
import { InMemoryAgentSessionStore, type AgentSessionStore } from "../src/agent/session.store.ts";
import { createAgentTools, type AgentDomainStore } from "../src/agent/tools.ts";
import type { DeterministicInterpretationResult } from "../src/agent/interpreter.types.ts";
import type { LlmInterpretationResult } from "../src/agent/llm-interpreter.types.ts";
import type { VerbalizationRequest, VerbalizationResult } from "../src/agent/conversation-intelligence.types.ts";

function product(overrides: Partial<AgentDomainStore["products"][number]> = {}) {
  return {
    id: "brownie-brigadeiro", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "Brownie recheado de brigadeiro",
    category: "Brownies", basePrice: 5, promotionalPrice: null, minimumPromotionalQuantity: null,
    isActive: true, isAvailable: true, displayOrder: 1, ingredients: "Chocolate", allergens: "Glúten",
    ...overrides,
  };
}

function makeDomainStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888", address: "Rua das Flores, 123",
      pickupEnabled: true, deliveryEnabled: false, deliveryFee: 0,
      pickupSlots: ["18:00", "19:00"], availabilityNotice: "",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [product()],
    orders: [],
    ...overrides,
  };
}

function notUnderstood(reason: string): DeterministicInterpretationResult {
  return { status: "NOT_UNDERSTOOD", reason, normalizedText: "texto" };
}

function makeStack(
  opts: Partial<CreateTextConversationServiceDependencies> & { domainStore?: AgentDomainStore; sessionStore?: AgentSessionStore } = {},
) {
  const domainStore = opts.domainStore ?? makeDomainStore();
  const tools = createAgentTools({ store: domainStore, now: opts.now });
  const sessionStore = opts.sessionStore ?? new InMemoryAgentSessionStore();
  const conversationService = createAgentConversationService({ sessionStore, tools });
  const textService = createTextConversationService({
    conversationService,
    sessionStore,
    tools,
    interpretMessage: opts.interpretMessage ?? (() => notUnderstood("GENERIC")),
    llmMode: opts.llmMode ?? "FALLBACK",
    interpretWithLlm: opts.interpretWithLlm,
    verbalizationMode: opts.verbalizationMode,
    verbalizeWithLlm: opts.verbalizeWithLlm,
    maxMisunderstandings: opts.maxMisunderstandings,
    now: opts.now,
  });
  return { domainStore, tools, sessionStore, conversationService, textService };
}

function llmSocial(): LlmInterpretationResult {
  return { status: "NOT_UNDERSTOOD", reason: "SOCIAL", intent: "SOCIAL", responseIntent: { kind: "SOCIAL_ACK" }, confidence: "HIGH", source: "LLM", promptVersion: "test", durationMs: 1 };
}
function llmObjection(): LlmInterpretationResult {
  return { status: "NOT_UNDERSTOOD", reason: "OBJECTION", intent: "OBJECTION", responseIntent: { kind: "ACKNOWLEDGE_OBJECTION" }, confidence: "HIGH", source: "LLM", promptVersion: "test", durationMs: 1 };
}
function llmOutOfScope(): LlmInterpretationResult {
  return { status: "NOT_UNDERSTOOD", reason: "OUT_OF_SCOPE", intent: "OUT_OF_SCOPE", responseIntent: { kind: "DECLINE_OUT_OF_SCOPE" }, confidence: "HIGH", source: "LLM", promptVersion: "test", durationMs: 1 };
}
function llmRequestHuman(): LlmInterpretationResult {
  return { status: "NOT_UNDERSTOOD", reason: "REQUEST_HUMAN", intent: "REQUEST_HUMAN", responseIntent: { kind: "REQUEST_HUMAN_ACK" }, confidence: "HIGH", source: "LLM", promptVersion: "test", durationMs: 1 };
}
function llmAnswerFactual(): LlmInterpretationResult {
  return {
    status: "MATCHED", actions: [{ type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 1 }],
    responseIntent: { kind: "ANSWER_FACTUAL", factKeys: ["PRODUCT"] }, confidence: "HIGH", source: "LLM", promptVersion: "test", durationMs: 1,
  };
}

function verbalizedOk(text: string, usedFactIds: string[] = []): VerbalizeWithLlmFn {
  return async () => ({ status: "VERBALIZED", text, usedFactIds, durationMs: 1 }) satisfies VerbalizationResult;
}

// --- 1. Saudação no meio de uma conversa (SOCIAL) -----------------------

test("saudação no meio de uma conversa é reconhecida como SOCIAL, sem contar como não-entendido e sem empurrar o pedido", async () => {
  const { textService, sessionStore } = makeStack({ interpretWithLlm: async () => llmSocial() });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c1", text: "oi tudo bem?" });
  assert.equal(result.policy.misunderstandingCountAfter, 0);
  assert.equal(result.policy.handoffTriggered, false);
  assert.doesNotMatch(result.messages[0]!.text, /vamos montar seu pedido/i);
  assert.doesNotMatch(result.messages[0]!.text, /não consegui entender/i);
  void sessionStore;
});

test("SOCIAL com verbalização habilitada usa o texto gerado pelo NVIDIA quando aprovado pelo validador", async () => {
  const { textService } = makeStack({
    interpretWithLlm: async () => llmSocial(),
    verbalizationMode: "ENABLED",
    verbalizeWithLlm: verbalizedOk("Oi! Tudo ótimo por aqui. Como posso ajudar?"),
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c2", text: "oi tudo bem?" });
  assert.equal(result.messages[0]!.text, "Oi! Tudo ótimo por aqui. Como posso ajudar?");
});

// --- 2. Objeção de preço --------------------------------------------------

test("objeção de preço reconhece a preocupação sem discutir, sem inventar desconto e sem pressionar", async () => {
  const { textService } = makeStack({ interpretWithLlm: async () => llmObjection() });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c3", text: "está caro demais" });
  assert.match(result.messages[0]!.text, /entendo|preocupação/i);
  assert.doesNotMatch(result.messages[0]!.text, /desconto|R\$/i);
  assert.equal(result.policy.misunderstandingCountAfter, 0);
});

// --- 3. Assunto fora do escopo --------------------------------------------

test("assunto fora do escopo é recusado com naturalidade, sem erro técnico e sem mudar de assunto aleatoriamente", async () => {
  const { textService } = makeStack({ interpretWithLlm: async () => llmOutOfScope() });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c4", text: "vocês fazem entrega de pizza?" });
  assert.match(result.messages[0]!.text, /cardápio|pedido|loja/i);
  assert.equal(result.policy.misunderstandingCountAfter, 0);
});

// --- 4. Solicitação de atendente via linguagem natural --------------------

test("pedido de atendente em linguagem natural (sem frase exata) aciona o handoff real e preserva o carrinho", async () => {
  const domainStore = makeDomainStore();
  const { textService, sessionStore, tools } = makeStack({ domainStore, interpretWithLlm: async () => llmRequestHuman() });
  const key = "whatsapp:c5";
  sessionStore.getOrCreate({ channel: "whatsapp", contactId: "c5" });
  sessionStore.update(key, s => ({ ...s, step: "BUILDING_ORDER", items: [{ productId: "brownie-brigadeiro", quantity: 3 }] }));

  const result = await textService.processText({ channel: "whatsapp", contactId: "c5", text: "posso falar com uma pessoa de verdade?" });
  assert.equal(result.sessionAfter.underHumanHandoff, true);
  assert.equal(result.sessionAfter.step, "HUMAN_HANDOFF");
  const summary = result.result?.data?.handoffSummary as { intent: string; cartItemCount: number; pendingQuestion: string } | undefined;
  assert.ok(summary);
  assert.equal(summary!.intent, "REQUEST_HUMAN");
  assert.equal(summary!.cartItemCount, 3);
  assert.doesNotMatch(result.messages[0]!.text, /\d+\s*(minuto|hora|min)/i);
  void tools;
});

// --- 5. Pergunta factual (preço) respondida com linguagem natural ---------

function browsingMenuStack(contactId: string, opts: Partial<CreateTextConversationServiceDependencies> = {}) {
  const sessionStore = new InMemoryAgentSessionStore();
  sessionStore.getOrCreate({ channel: "whatsapp", contactId });
  sessionStore.update(`whatsapp:${contactId}`, s => ({ ...s, step: "BROWSING_MENU" }));
  return makeStack({ ...opts, sessionStore });
}

test("pergunta de preço com verbalização ligada responde citando o preço real, grounded em AllowedFact", async () => {
  const { textService } = browsingMenuStack("c6", {
    interpretWithLlm: async () => llmAnswerFactual(),
    verbalizationMode: "ENABLED",
    verbalizeWithLlm: async (request: VerbalizationRequest) => {
      const fact = request.facts.find(f => f.key === "PRODUCT");
      return { status: "VERBALIZED", text: `O Brownie de Brigadeiro custa R$ 5,00!`, usedFactIds: fact ? [fact.factId] : [], durationMs: 1 };
    },
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c6", text: "quanto custa o de brigadeiro?" });
  assert.match(result.messages[0]!.text, /R\$\s?5,00/);
});

test("verbalização que inventa um preço não autorizado é rejeitada e cai no template seguro", async () => {
  const { textService } = browsingMenuStack("c7", {
    interpretWithLlm: async () => llmAnswerFactual(),
    verbalizationMode: "ENABLED",
    verbalizeWithLlm: async () => ({ status: "VERBALIZED", text: "Custa R$ 999,00!", usedFactIds: ["product:brownie-brigadeiro"], durationMs: 1 }),
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c7", text: "quanto custa o de brigadeiro?" });
  assert.doesNotMatch(result.messages[0]!.text, /999/);
  assert.match(result.messages[0]!.text, /adicionamos|brownie/i);
});

test("verbalização citando um factId inexistente é rejeitada e cai no template seguro", async () => {
  const { textService } = browsingMenuStack("c8", {
    interpretWithLlm: async () => llmAnswerFactual(),
    verbalizationMode: "ENABLED",
    verbalizeWithLlm: async () => ({ status: "VERBALIZED", text: "Custa R$ 5,00!", usedFactIds: ["product:inexistente"], durationMs: 1 }),
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c8", text: "quanto custa o de brigadeiro?" });
  // Cai no template determinístico de ITEM_ADDED (a ação de negócio ainda
  // executa normalmente — só a verbalização é descartada).
  assert.match(result.messages[0]!.text, /adicionamos|brownie/i);
});

test("timeout/erro do provider na verbalização cai no template, sem travar o turno", async () => {
  const { textService } = browsingMenuStack("c9", {
    interpretWithLlm: async () => llmAnswerFactual(),
    verbalizationMode: "ENABLED",
    verbalizeWithLlm: async () => ({ status: "PROVIDER_ERROR", reason: "TIMEOUT", retryable: true, durationMs: 1 }),
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c9", text: "quanto custa o de brigadeiro?" });
  assert.match(result.messages[0]!.text, /adicionamos|brownie/i);
});

// --- 6. Verbalização desligada (padrão) nunca muda o comportamento --------

test("com BF_VERBALIZATION_MODE ausente (padrão), respostas continuam sempre por template mesmo com responseIntent presente", async () => {
  const { textService } = browsingMenuStack("c10", {
    interpretWithLlm: async () => llmAnswerFactual(),
    // verbalizationMode ausente -> DISABLED
    verbalizeWithLlm: async () => {
      throw new Error("verbalizeWithLlm nunca deveria ser chamado com a flag desligada");
    },
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c10", text: "quanto custa o de brigadeiro?" });
  assert.match(result.messages[0]!.text, /adicionamos|brownie/i);
});

// --- 7. Falha de planejamento nunca muda de assunto -----------------------

test("falha de planejamento (PROVIDER_ERROR) numa etapa intermediária reapresenta o que a etapa já pede, nunca um texto genérico desconectado", async () => {
  const domainStore = makeDomainStore();
  const sessionStore = new InMemoryAgentSessionStore();
  const key = "whatsapp:c11";
  sessionStore.getOrCreate({ channel: "whatsapp", contactId: "c11" });
  sessionStore.update(key, s => ({ ...s, step: "COLLECTING_PAYMENT" }));
  const { textService } = makeStack({
    domainStore,
    sessionStore,
    interpretWithLlm: async () => ({ status: "PROVIDER_ERROR", reason: "TIMEOUT", retryable: true, promptVersion: "test", durationMs: 1 }),
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c11", text: "não sei o que fazer" });
  assert.match(result.messages[0]!.text, /PIX|DINHEIRO|pagamento/i);
  assert.doesNotMatch(result.messages[0]!.text, /Não consegui processar sua mensagem agora/);
});

// --- 8. Confirmação de pedido nunca depende do responseIntent do modelo ---

function llmConfirmOrderMismatched(): LlmInterpretationResult {
  return {
    status: "MATCHED",
    actions: [{ type: "CONFIRM_ORDER" }],
    // responseIntent deliberadamente "errado" (SOCIAL_ACK, não
    // CONFIRM_ACTION_RESULT) — é exatamente o caso que a Regra 0 de
    // response-strategy-policy.ts precisa cobrir, já que esse campo é
    // auto-reportado pelo modelo e não pode ser a única barreira para a
    // confirmação final de um pedido.
    responseIntent: { kind: "SOCIAL_ACK" },
    confidence: "HIGH",
    source: "LLM",
    promptVersion: "test",
    durationMs: 1,
  };
}

test("confirmação de pedido (CONFIRM_ORDER) sempre usa o template determinístico, mesmo com verbalização ligada e responseIntent divergente (SOCIAL_ACK) do modelo", async () => {
  const domainStore = makeDomainStore();
  const sessionStore = new InMemoryAgentSessionStore();
  const key = "whatsapp:c13";
  sessionStore.getOrCreate({ channel: "whatsapp", contactId: "c13" });
  sessionStore.update(key, s => ({
    ...s,
    step: "AWAITING_CONFIRMATION",
    items: [{ productId: "brownie-brigadeiro", quantity: 2 }],
    customerName: "Maria",
    customerPhone: "85999990000",
    fulfillmentType: "RETIRADA",
    pickupTime: "18:00",
    paymentMethod: "PIX",
  }));
  const { textService } = makeStack({
    domainStore,
    sessionStore,
    interpretWithLlm: async () => llmConfirmOrderMismatched(),
    verbalizationMode: "ENABLED",
    verbalizeWithLlm: async () => {
      throw new Error("verbalizeWithLlm nunca deveria ser chamado para confirmação de pedido");
    },
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c13", text: "sim, pode confirmar" });
  assert.match(result.messages[0]!.text, /pedido criado com sucesso/i);
  assert.equal(result.sessionAfter.step, "ORDER_CREATED");
});

test("pergunta de horário é sempre respondida pela checagem factual determinística, mesmo com o planejamento NVIDIA indisponível (nunca depende do LLM)", async () => {
  const domainStore = makeDomainStore({
    business: { ...makeDomainStore().business, operatingHours: { MON: [{ open: "08:00", close: "18:00" }], TUE: [{ open: "08:00", close: "18:00" }], WED: [{ open: "08:00", close: "18:00" }], THU: [{ open: "08:00", close: "18:00" }], FRI: [{ open: "08:00", close: "18:00" }], SAT: [], SUN: [] } },
  });
  const { textService } = makeStack({
    domainStore,
    interpretWithLlm: async () => ({ status: "PROVIDER_ERROR", reason: "TIMEOUT", retryable: true, promptVersion: "test", durationMs: 1 }),
    now: () => new Date("2026-01-05T13:00:00-03:00"), // segunda-feira, dentro do horário
  });
  const result = await textService.processText({ channel: "whatsapp", contactId: "c12", text: "vocês estão abertos agora?" });
  assert.match(result.messages[0]!.text, /abertos/i);
});
