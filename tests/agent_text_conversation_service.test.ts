import assert from "node:assert/strict";
import test from "node:test";
import {
  createTextConversationService,
  TextConversationServiceError,
  type CreateTextConversationServiceDependencies,
} from "../src/agent/text-conversation.service.ts";
import { createAgentConversationService } from "../src/agent/conversation.service.ts";
import { InMemoryAgentSessionStore, buildAgentSessionKey, type AgentSessionStore } from "../src/agent/session.store.ts";
import { createAgentTools, type AgentDomainStore } from "../src/agent/tools.ts";
import type { DeterministicInterpretationResult } from "../src/agent/interpreter.types.ts";

// --- fábricas de teste (mesmo padrão de tests/agent_conversation_service.test.ts) ---

function product(overrides: Partial<AgentDomainStore["products"][number]> = {}) {
  return {
    id: "brownie-brigadeiro", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "Descrição",
    category: "Brownies", basePrice: 5, promotionalPrice: null, minimumPromotionalQuantity: null,
    isActive: true, isAvailable: true, displayOrder: 1, ingredients: "Chocolate", allergens: "Glúten",
    ...overrides,
  };
}

function makeDomainStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888",
      pickupEnabled: true, deliveryEnabled: false, deliveryFee: 0,
      pickupSlots: ["18:00", "19:00"], availabilityNotice: "",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [product()],
    orders: [],
    ...overrides,
  };
}

function wrapCountingUpdates(base: AgentSessionStore): { store: AgentSessionStore; state: { calls: number } } {
  const state = { calls: 0 };
  const store: AgentSessionStore = {
    get: key => base.get(key),
    create: input => base.create(input),
    getOrCreate: input => base.getOrCreate(input),
    update: (key, updater) => {
      state.calls += 1;
      return base.update(key, updater);
    },
    delete: key => base.delete(key),
    touch: key => base.touch(key),
    markMessageProcessed: (key, id) => base.markMessageProcessed(key, id),
    hasProcessedMessage: (key, id) => base.hasProcessedMessage(key, id),
    clearExpired: () => base.clearExpired(),
    size: () => base.size(),
  };
  return { store, state };
}

function wrapUpdateFailingOnCall(base: AgentSessionStore, failOnCall: number): AgentSessionStore {
  let calls = 0;
  return {
    get: key => base.get(key),
    create: input => base.create(input),
    getOrCreate: input => base.getOrCreate(input),
    update: (key, updater) => {
      calls += 1;
      if (calls === failOnCall) throw new Error("falha de persistência simulada");
      return base.update(key, updater);
    },
    delete: key => base.delete(key),
    touch: key => base.touch(key),
    markMessageProcessed: (key, id) => base.markMessageProcessed(key, id),
    hasProcessedMessage: (key, id) => base.hasProcessedMessage(key, id),
    clearExpired: () => base.clearExpired(),
    size: () => base.size(),
  };
}

function makeStack(
  opts: Partial<CreateTextConversationServiceDependencies> & {
    domainStore?: AgentDomainStore;
    sessionStore?: AgentSessionStore;
    generateOrderIdempotencyKey?: () => string;
  } = {},
) {
  const domainStore = opts.domainStore ?? makeDomainStore();
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = opts.sessionStore ?? new InMemoryAgentSessionStore();
  const conversationService = createAgentConversationService({
    sessionStore,
    tools,
    generateOrderIdempotencyKey: opts.generateOrderIdempotencyKey,
  });
  const textService = createTextConversationService({
    conversationService,
    sessionStore,
    tools,
    maxMisunderstandings: opts.maxMisunderstandings,
    interpretMessage: opts.interpretMessage,
  });
  return { domainStore, tools, sessionStore, conversationService, textService };
}

function notUnderstood(reason: string, suggestions?: string[]): DeterministicInterpretationResult {
  return suggestions
    ? { status: "NOT_UNDERSTOOD", reason, normalizedText: "texto", suggestions }
    : { status: "NOT_UNDERSTOOD", reason, normalizedText: "texto" };
}

function ambiguous(reason: string, withCandidates = false): DeterministicInterpretationResult {
  return withCandidates
    ? {
        status: "AMBIGUOUS",
        reason,
        normalizedText: "texto",
        candidates: [
          { action: { type: "ADD_ITEM", productId: "brownie-secreto-1", quantity: 1 }, label: "Brownie A" },
          { action: { type: "ADD_ITEM", productId: "brownie-secreto-2", quantity: 1 }, label: "Brownie B" },
        ],
      }
    : { status: "AMBIGUOUS", reason, normalizedText: "texto" };
}

const CH = "simulator";

// --- 1-6: configuração de maxMisunderstandings ---

test("limite padrão de não compreensões é 3", async () => {
  const { textService } = makeStack({ interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "cfg-default";
  await textService.processText({ channel: CH, contactId, text: "a" });
  await textService.processText({ channel: CH, contactId, text: "b" });
  const third = await textService.processText({ channel: CH, contactId, text: "c" });
  assert.equal(third.policy.handoffTriggered, true);
  assert.equal(third.policy.misunderstandingCountAfter, 3);
});

test("limite customizado funciona", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 1, interpretMessage: () => notUnderstood("GENERIC") });
  const result = await textService.processText({ channel: CH, contactId: "cfg-custom", text: "a" });
  assert.equal(result.policy.handoffTriggered, true);
  assert.equal(result.policy.misunderstandingCountAfter, 1);
});

test("limite zero é rejeitado na criação do service", () => {
  assert.throws(() => makeStack({ maxMisunderstandings: 0 }), TextConversationServiceError);
});

test("limite negativo é rejeitado na criação do service", () => {
  assert.throws(() => makeStack({ maxMisunderstandings: -1 }), TextConversationServiceError);
});

test("limite decimal é rejeitado na criação do service", () => {
  assert.throws(() => makeStack({ maxMisunderstandings: 2.5 }), TextConversationServiceError);
});

test("limite acima do máximo permitido é rejeitado na criação do service", () => {
  assert.throws(() => makeStack({ maxMisunderstandings: 11 }), TextConversationServiceError);
});

test("dependências obrigatórias ausentes lançam erro técnico", () => {
  const domainStore = makeDomainStore();
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = new InMemoryAgentSessionStore();
  const conversationService = createAgentConversationService({ sessionStore, tools });
  assert.throws(
    () => createTextConversationService({ conversationService, sessionStore, tools: undefined as never }),
    TextConversationServiceError,
  );
});

// --- 7-13: MATCHED ---

test("MATCHED chama o Conversation Service e devolve o resultado do Engine", async () => {
  const { textService } = makeStack();
  const result = await textService.processText({ channel: CH, contactId: "matched-1", text: "oi" });
  assert.equal(result.interpretation?.status, "MATCHED");
  assert.equal(result.result?.event, "WELCOME");
});

test("MATCHED processado zera misunderstandingCount", async () => {
  const { sessionStore } = makeStack();
  const contactId = "matched-reset";
  const { textService: failer } = makeStack({ sessionStore, maxMisunderstandings: 5, interpretMessage: () => notUnderstood("GENERIC") });
  await failer.processText({ channel: CH, contactId, text: "a" });
  const afterFailures = await failer.processText({ channel: CH, contactId, text: "b" });
  assert.equal(afterFailures.policy.misunderstandingCountAfter, 2);

  const { textService: realService } = makeStack({ sessionStore });
  const matched = await realService.processText({ channel: CH, contactId, text: "oi" });
  assert.equal(matched.policy.counterReset, true);
  assert.equal(matched.policy.misunderstandingCountAfter, 0);
  assert.equal(matched.sessionAfter.misunderstandingCount, 0);
});

test("MATCHED com misunderstandingCount já zero não gera update de sessão desnecessário", async () => {
  const base = new InMemoryAgentSessionStore();
  const { store, state } = wrapCountingUpdates(base);
  const { textService } = makeStack({ sessionStore: store });
  const contactId = "matched-no-extra-update";
  await textService.processText({ channel: CH, contactId, text: "oi" });
  // Uma única chamada a update(): a persistência do Engine feita pelo
  // Conversation Service. Nenhuma chamada extra da política, pois o
  // contador já estava em zero.
  assert.equal(state.calls, 1);
});

test("MATCHED com validação de domínio inválida (ex.: INVALID_QUANTITY) ainda zera o contador", async () => {
  const { sessionStore } = makeStack();
  const contactId = "matched-domain-invalid";
  const { textService: failer } = makeStack({ sessionStore, maxMisunderstandings: 5, interpretMessage: () => notUnderstood("GENERIC") });
  await failer.processText({ channel: CH, contactId, text: "a" });
  await failer.processText({ channel: CH, contactId, text: "b" });

  const sessionKey = buildAgentSessionKey(CH, contactId);
  assert.equal(sessionStore.get(sessionKey)?.misunderstandingCount, 2);
  // Move a sessão direto pra BROWSING_MENU sem passar pelo Text Conversation
  // Service, pra não zerar o contador antes da hora e comprometer o teste.
  sessionStore.update(sessionKey, s => ({ ...s, step: "BROWSING_MENU" }));

  const { textService: withInvalidQty } = makeStack({
    sessionStore,
    maxMisunderstandings: 5,
    interpretMessage: () => ({
      status: "MATCHED",
      action: { type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 0 },
      confidence: 1,
      source: "TEST",
      normalizedText: "0 brownie",
    }),
  });

  const result = await withInvalidQty.processText({ channel: CH, contactId, text: "0 brownie" });
  assert.equal(result.result?.messageKey, "INVALID_QUANTITY");
  assert.equal(result.policy.counterReset, true);
  assert.equal(result.policy.misunderstandingCountAfter, 0);
});

test("MATCHED resultando em INVALID_ACTION preserva o contador atual", async () => {
  const { sessionStore } = makeStack();
  const contactId = "matched-invalid-action";
  const { textService: bumpTwice } = makeStack({
    sessionStore,
    maxMisunderstandings: 5,
    interpretMessage: () => notUnderstood("GENERIC"),
  });
  await bumpTwice.processText({ channel: CH, contactId, text: "a" });
  await bumpTwice.processText({ channel: CH, contactId, text: "b" });

  const { textService: sendGoBack } = makeStack({
    sessionStore,
    maxMisunderstandings: 5,
    interpretMessage: () => ({
      status: "MATCHED",
      action: { type: "GO_BACK" },
      confidence: 1,
      source: "TEST",
      normalizedText: "voltar",
    }),
  });
  const result = await sendGoBack.processText({ channel: CH, contactId, text: "voltar" });
  assert.equal(result.result?.messageKey, "INVALID_ACTION");
  assert.equal(result.policy.counterReset, false);
  assert.equal(result.policy.misunderstandingCountAfter, 2);
  assert.equal(result.sessionAfter.misunderstandingCount, 2);
});

test("erro técnico do Engine não zera nem altera o contador e propaga o erro", async () => {
  const { sessionStore, tools } = makeStack();
  const contactId = "matched-technical-error";
  const conversationService = createAgentConversationService({
    sessionStore,
    tools,
    generateOrderIdempotencyKey: () => "chave invalida com espaco",
  });
  const textService = createTextConversationService({
    conversationService,
    sessionStore,
    tools,
    interpretMessage: input => {
      if (input.session.step === "START") return { status: "MATCHED", action: { type: "START_CONVERSATION" }, confidence: 1, source: "T", normalizedText: "oi" };
      if (input.session.step === "BROWSING_MENU") return { status: "MATCHED", action: { type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 1 }, confidence: 1, source: "T", normalizedText: "1" };
      if (input.session.step === "BUILDING_ORDER") return { status: "MATCHED", action: { type: "FINISH_CART" }, confidence: 1, source: "T", normalizedText: "finalizar" };
      if (input.session.step === "COLLECTING_NAME") return { status: "MATCHED", action: { type: "SET_CUSTOMER_NAME", customerName: "Maria" }, confidence: 1, source: "T", normalizedText: "maria" };
      if (input.session.step === "COLLECTING_FULFILLMENT") return { status: "MATCHED", action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" }, confidence: 1, source: "T", normalizedText: "fone" };
      return { status: "MATCHED", action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, confidence: 1, source: "T", normalizedText: "retirada" };
    },
  });
  for (const text of ["oi", "1", "finalizar", "maria", "fone"]) {
    await textService.processText({ channel: CH, contactId, text });
  }
  // Pula direto pra confirmação simplificada: seta pickupTime/notes/payment via ações diretas no engine.
  const sessionKey = buildAgentSessionKey(CH, contactId);
  sessionStore.update(sessionKey, s => ({
    ...s,
    fulfillmentType: "RETIRADA",
    pickupTime: "18:00",
    customerNotes: undefined,
    paymentMethod: "PIX",
    step: "AWAITING_CONFIRMATION",
  }));

  const confirmService = createTextConversationService({
    conversationService,
    sessionStore,
    tools,
    interpretMessage: () => ({ status: "MATCHED", action: { type: "CONFIRM_ORDER" }, confidence: 1, source: "T", normalizedText: "confirmar" }),
  });
  const before = sessionStore.get(sessionKey)?.misunderstandingCount;
  await assert.rejects(() => confirmService.processText({ channel: CH, contactId, messageId: "confirm-x", text: "confirmar" }));
  assert.equal(sessionStore.get(sessionKey)?.misunderstandingCount, before);
  assert.equal(sessionStore.hasProcessedMessage(sessionKey, "confirm-x"), false);
});

test("MATCHED duplicado (mesmo messageId) não processa novamente", async () => {
  const { textService, domainStore } = makeStack();
  const contactId = "matched-dup";
  await textService.processText({ channel: CH, contactId, messageId: "m1", text: "oi" });
  const before = JSON.parse(JSON.stringify(domainStore));
  const replay = await textService.processText({ channel: CH, contactId, messageId: "m1", text: "oi" });
  assert.equal(replay.duplicateMessage, true);
  assert.deepEqual(domainStore, before);
  assert.equal(replay.messages.length, 0);
});

// --- 14-20: NOT_UNDERSTOOD ---

test("primeira falha incrementa misunderstandingCount para 1", async () => {
  const { textService } = makeStack({ interpretMessage: () => notUnderstood("GENERIC") });
  const result = await textService.processText({ channel: CH, contactId: "nu-first", text: "???" });
  assert.equal(result.policy.misunderstandingCountBefore, 0);
  assert.equal(result.policy.misunderstandingCountAfter, 1);
  assert.equal(result.policyResult?.messageKey, "INTERPRETATION_NOT_UNDERSTOOD");
});

test("segunda falha incrementa misunderstandingCount para 2", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 5, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "nu-second";
  await textService.processText({ channel: CH, contactId, text: "a" });
  const second = await textService.processText({ channel: CH, contactId, text: "b" });
  assert.equal(second.policy.misunderstandingCountAfter, 2);
});

test("falha sem messageId ainda incrementa o contador", async () => {
  const { textService } = makeStack({ interpretMessage: () => notUnderstood("GENERIC") });
  const result = await textService.processText({ channel: CH, contactId: "nu-no-id", text: "???" });
  assert.equal(result.policy.misunderstandingCountAfter, 1);
  assert.deepEqual(result.sessionAfter.processedMessageIds, []);
});

test("falha com messageId registra o id como processado", async () => {
  const { textService, sessionStore } = makeStack({ interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "nu-with-id";
  const result = await textService.processText({ channel: CH, contactId, messageId: "u1", text: "???" });
  const sessionKey = buildAgentSessionKey(CH, contactId);
  assert.equal(sessionStore.hasProcessedMessage(sessionKey, "u1"), true);
  assert.deepEqual(result.sessionAfter.processedMessageIds, ["u1"]);
});

test("falha duplicada (mesmo messageId) não incrementa o contador de novo", async () => {
  const { textService } = makeStack({ interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "nu-dup";
  await textService.processText({ channel: CH, contactId, messageId: "u1", text: "???" });
  const replay = await textService.processText({ channel: CH, contactId, messageId: "u1", text: "???" });
  assert.equal(replay.duplicateMessage, true);
  assert.equal(replay.policy.misunderstandingCountAfter, 1);
  assert.equal(replay.messages.length, 0);
});

test("falha não chama o Engine (sessão de negócio não muda de etapa)", async () => {
  const { textService } = makeStack({ interpretMessage: () => notUnderstood("GENERIC") });
  const result = await textService.processText({ channel: CH, contactId: "nu-no-engine", text: "???" });
  assert.equal(result.result, undefined);
  assert.equal(result.sessionAfter.step, "START");
  assert.deepEqual(result.sessionAfter.items, []);
});

test("sugestões públicas de NOT_UNDERSTOOD são preservadas e deduplicadas na mensagem", async () => {
  const { textService } = makeStack({
    interpretMessage: () => notUnderstood("INVALID_PAYMENT_OPTION", ["PIX", "DINHEIRO", "PIX", "  "]),
  });
  const result = await textService.processText({ channel: CH, contactId: "nu-suggestions", text: "bitcoin" });
  assert.deepEqual(result.policyResult?.data?.suggestions, ["PIX", "DINHEIRO"]);
  assert.match(result.messages[0].text, /Escolha uma destas opções: PIX, DINHEIRO\./);
});

test("sugestões públicas são limitadas a 5 opções", async () => {
  const many = ["A", "B", "C", "D", "E", "F", "G"];
  const { textService } = makeStack({ interpretMessage: () => notUnderstood("INVALID_PAYMENT_OPTION", many) });
  const result = await textService.processText({ channel: CH, contactId: "nu-suggestions-cap", text: "x" });
  assert.equal((result.policyResult?.data?.suggestions as string[]).length, 5);
});

// --- 21-25: AMBIGUOUS ---

test("AMBIGUOUS incrementa o contador", async () => {
  const { textService } = makeStack({ interpretMessage: () => ambiguous("AMBIGUOUS_PRODUCT") });
  const result = await textService.processText({ channel: CH, contactId: "amb-count", text: "brownie" });
  assert.equal(result.policy.misunderstandingCountAfter, 1);
  assert.equal(result.policyResult?.messageKey, "INTERPRETATION_AMBIGUOUS");
});

test("AMBIGUOUS não executa candidatos nem expõe productId na mensagem", async () => {
  const { textService } = makeStack({ interpretMessage: () => ambiguous("AMBIGUOUS_PRODUCT", true) });
  const result = await textService.processText({ channel: CH, contactId: "amb-no-exec", text: "brownie" });
  assert.equal(result.result, undefined);
  assert.deepEqual(result.sessionAfter.items, []);
  assert.doesNotMatch(result.messages[0].text, /brownie-secreto/);
});

test("AMBIGUOUS não chama o Engine", async () => {
  const { textService } = makeStack({ interpretMessage: () => ambiguous("AMBIGUOUS_PRODUCT") });
  const result = await textService.processText({ channel: CH, contactId: "amb-no-engine", text: "brownie" });
  assert.equal(result.result, undefined);
});

test("AMBIGUOUS duplicado não incrementa novamente", async () => {
  const { textService } = makeStack({ interpretMessage: () => ambiguous("AMBIGUOUS_PRODUCT") });
  const contactId = "amb-dup";
  await textService.processText({ channel: CH, contactId, messageId: "a1", text: "brownie" });
  const replay = await textService.processText({ channel: CH, contactId, messageId: "a1", text: "brownie" });
  assert.equal(replay.duplicateMessage, true);
  assert.equal(replay.policy.misunderstandingCountAfter, 1);
});

// --- 26-36: handoff automático ---

test("limite atingido dispara REQUEST_HUMAN pelo Conversation Service", async () => {
  const { textService, sessionStore } = makeStack({ maxMisunderstandings: 2, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "handoff-basic";
  await textService.processText({ channel: CH, contactId, text: "a" });
  const second = await textService.processText({ channel: CH, contactId, text: "b" });
  assert.equal(second.policy.handoffTriggered, true);
  assert.equal(second.sessionAfter.underHumanHandoff, true);
  assert.equal(second.sessionAfter.step, "HUMAN_HANDOFF");
  const sessionKey = buildAgentSessionKey(CH, contactId);
  assert.equal(sessionStore.get(sessionKey)?.step, "HUMAN_HANDOFF");
});

test("handoff automático preserva o carrinho e não cria pedido", async () => {
  const { sessionStore } = makeStack();
  const contactId = "handoff-preserves-cart";
  const { textService: addToCart } = makeStack({ sessionStore });
  await addToCart.processText({ channel: CH, contactId, text: "oi" });
  await addToCart.processText({ channel: CH, contactId, text: "1" });

  const { textService: failTwice } = makeStack({
    sessionStore,
    maxMisunderstandings: 2,
    interpretMessage: () => notUnderstood("GENERIC"),
  });
  await failTwice.processText({ channel: CH, contactId, text: "a" });
  const result = await failTwice.processText({ channel: CH, contactId, text: "b" });

  assert.equal(result.policy.handoffTriggered, true);
  assert.deepEqual(result.sessionAfter.items, [{ productId: "brownie-brigadeiro", quantity: 1 }]);
  assert.equal(result.sessionAfter.createdOrderId, undefined);
});

test("contador permanece no valor do limite após o handoff automático", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 2, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "handoff-count-stays";
  await textService.processText({ channel: CH, contactId, text: "a" });
  const result = await textService.processText({ channel: CH, contactId, text: "b" });
  assert.equal(result.policy.misunderstandingCountAfter, 2);
  assert.equal(result.sessionAfter.misunderstandingCount, 2);
});

test("mensagem original que disparou o handoff é registrada como processada", async () => {
  const { textService, sessionStore } = makeStack({ maxMisunderstandings: 1, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "handoff-registers-id";
  await textService.processText({ channel: CH, contactId, messageId: "trigger-1", text: "a" });
  const sessionKey = buildAgentSessionKey(CH, contactId);
  assert.equal(sessionStore.hasProcessedMessage(sessionKey, "trigger-1"), true);
});

test("replay da mensagem que disparou o handoff não dispara um segundo handoff", async () => {
  const { textService, sessionStore } = makeStack({ maxMisunderstandings: 1, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "handoff-no-double";
  await textService.processText({ channel: CH, contactId, messageId: "trigger-1", text: "a" });
  const replay = await textService.processText({ channel: CH, contactId, messageId: "trigger-1", text: "a" });
  assert.equal(replay.duplicateMessage, true);
  const sessionKey = buildAgentSessionKey(CH, contactId);
  assert.equal(sessionStore.get(sessionKey)?.misunderstandingCount, 1);
  assert.equal(replay.messages.length, 0);
});

test("falha técnica no handoff automático não finge sucesso e preserva o limite documentado", async () => {
  const base = new InMemoryAgentSessionStore();
  // A 1ª chamada a update() é o incremento do contador (sucesso); a 2ª é a
  // persistência do REQUEST_HUMAN dentro do Conversation Service (falha).
  const broken = wrapUpdateFailingOnCall(base, 2);
  const { textService } = makeStack({ sessionStore: broken, maxMisunderstandings: 1, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "handoff-tech-failure";
  await assert.rejects(() => textService.processText({ channel: CH, contactId, messageId: "trigger-x", text: "a" }));
  const sessionKey = buildAgentSessionKey(CH, contactId);
  assert.equal(base.get(sessionKey)?.misunderstandingCount, 1);
  assert.equal(base.get(sessionKey)?.underHumanHandoff, false);
  assert.equal(base.hasProcessedMessage(sessionKey, "trigger-x"), false);
});

// --- 37-44: handoff ativo ---
//
// Estes testes usam o interpretador determinístico real (sem stub), pois a
// política confia no contrato já implementado por ele: enquanto
// session.underHumanHandoff for true, o interpretador só resolve
// RESET_CONVERSATION como MATCHED — qualquer outro texto vira NOT_UNDERSTOOD
// com reason "HUMAN_HANDOFF_ACTIVE". Um stub artificial não reproduz esse
// contrato, então usar o interpretador de verdade é o que de fato exercita a
// política de handoff ativo.

test("mensagem comum durante handoff ativo não chama o Engine nem incrementa o contador", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 1 });
  const contactId = "active-common";
  const first = await textService.processText({ channel: CH, contactId, text: "sjdfkjhaskdjfh" });
  assert.equal(first.policy.handoffTriggered, true);

  const result = await textService.processText({ channel: CH, contactId, text: "qualquer coisa" });
  assert.equal(result.result, undefined);
  assert.equal(result.policy.misunderstandingCountAfter, 1);
  assert.equal(result.policyResult?.messageKey, "HUMAN_HANDOFF_ACTIVE");
  assert.match(result.messages[0].text, /atendimento já foi encaminhado/);
});

test("RESET_CONVERSATION é permitido durante handoff ativo e sai do handoff", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 1 });
  const contactId = "active-reset";
  await textService.processText({ channel: CH, contactId, text: "sjdfkjhaskdjfh" });

  const result = await textService.processText({ channel: CH, contactId, text: "recomeçar" });
  assert.equal(result.interpretation?.status, "MATCHED");
  assert.equal(result.sessionAfter.underHumanHandoff, false);
  assert.equal(result.sessionAfter.step, "START");
});

test("RESET_CONVERSATION durante handoff ativo zera o misunderstandingCount", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 1 });
  const contactId = "active-reset-zeroes";
  await textService.processText({ channel: CH, contactId, text: "sjdfkjhaskdjfh" });

  const result = await textService.processText({ channel: CH, contactId, text: "recomeçar" });
  assert.equal(result.policy.counterReset, true);
  assert.equal(result.sessionAfter.misunderstandingCount, 0);
});

test("depois do reset, um novo fluxo pode começar normalmente", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 1 });
  const contactId = "active-reset-then-flow";
  await textService.processText({ channel: CH, contactId, text: "sjdfkjhaskdjfh" });
  await textService.processText({ channel: CH, contactId, text: "recomeçar" });

  const result = await textService.processText({ channel: CH, contactId, text: "oi" });
  assert.equal(result.interpretation?.status, "MATCHED");
  assert.equal(result.result?.event, "WELCOME");
  assert.equal(result.sessionAfter.step, "BROWSING_MENU");
  assert.equal(result.sessionAfter.misunderstandingCount, 0);
});

test("REQUEST_HUMAN repetido durante handoff ativo não gera nova alteração", async () => {
  const { textService } = makeStack({ maxMisunderstandings: 1 });
  const contactId = "active-repeated-human";
  await textService.processText({ channel: CH, contactId, text: "sjdfkjhaskdjfh" });

  const result = await textService.processText({ channel: CH, contactId, text: "atendente" });
  assert.equal(result.interpretation?.status, "NOT_UNDERSTOOD");
  assert.equal((result.interpretation as { reason?: string }).reason, "HUMAN_HANDOFF_ACTIVE");
  assert.equal(result.sessionAfter.underHumanHandoff, true);
  assert.equal(result.policy.misunderstandingCountAfter, 1);
});

// --- 45-48: persistência e cópias defensivas ---

test("sessionBefore é uma cópia defensiva", async () => {
  const { textService, sessionStore } = makeStack();
  const contactId = "defensive-before";
  const result = await textService.processText({ channel: CH, contactId, text: "oi" });
  (result.sessionBefore as { step: string }).step = "ORDER_CREATED";
  const stored = sessionStore.get(result.sessionKey);
  assert.notEqual(stored?.step, "ORDER_CREATED");
});

test("sessionAfter é uma cópia defensiva", async () => {
  const { textService, sessionStore } = makeStack();
  const contactId = "defensive-after";
  const result = await textService.processText({ channel: CH, contactId, text: "oi" });
  result.sessionAfter.items.push({ productId: "injetado", quantity: 1 });
  const stored = sessionStore.get(result.sessionKey);
  assert.equal(stored?.items.length, 0);
});

test("falha de persistência do contador não registra o messageId e propaga o erro", async () => {
  const base = new InMemoryAgentSessionStore();
  const broken = wrapUpdateFailingOnCall(base, 1);
  const { textService } = makeStack({ sessionStore: broken, interpretMessage: () => notUnderstood("GENERIC") });
  const contactId = "defensive-update-failure";
  await assert.rejects(() => textService.processText({ channel: CH, contactId, messageId: "u1", text: "???" }));
  assert.equal(broken.hasProcessedMessage(buildAgentSessionKey(CH, contactId), "u1"), false);
});

test("messageId vazio é rejeitado com erro técnico controlado", async () => {
  const { textService } = makeStack();
  await assert.rejects(
    () => textService.processText({ channel: CH, contactId: "invalid-message-id", messageId: "   ", text: "oi" }),
    TextConversationServiceError,
  );
});
