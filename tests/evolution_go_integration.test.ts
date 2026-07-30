import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvolutionGoTextSender,
  createEvolutionGoWebhookHandler,
  parseEvolutionGoWebhook,
  readEvolutionGoConfig,
  readEvolutionWebhookToken,
  type EvolutionGoConfig,
} from "../src/integrations/evolution-go.ts";
import { createWhatsappConversationRuntime } from "../src/agent/whatsapp-conversation.runtime.ts";
import type { AgentDomainStore } from "../src/agent/tools.ts";
import { NvidiaNemotronLlmProviderError } from "../src/agent/providers/nvidia-nemotron-llm-provider.ts";
import type { NvidiaCompatibleClient } from "../src/agent/providers/nvidia-nemotron-llm-provider.ts";
import { BROWNIER_PICKUP_ADDRESS } from "../src/lib/business-defaults.ts";
import type { PostgresConversationState } from "../src/agent/postgres-conversation-state.ts";
import type { AgentSession } from "../src/agent/session.types.ts";

const config: EvolutionGoConfig = {
  baseUrl: "https://evolution.example.test",
  instanceName: "browneria",
  instanceToken: "instance-token-test",
};

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    event: "Message",
    instanceId: "instance-id",
    instanceToken: "event-token-not-used",
    instanceName: "browneria",
    data: {
      Info: {
        ID: "message-001",
        Sender: "5585999999999@s.whatsapp.net",
        Chat: "5585999999999@s.whatsapp.net",
        IsFromMe: false,
        IsGroup: false,
        Type: "text",
      },
      Message: { conversation: "Oi" },
    },
    ...overrides,
  };
}

function responseCapture() {
  const response = {
    statusCode: 0,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) { response.statusCode = code; return response; },
    json(body: Record<string, unknown>) { response.body = body; return response; },
    end() { return response; },
  };
  return response;
}

test("normaliza o payload Message oficial da Evolution Go sem usar o token do evento", () => {
  const parsed = parseEvolutionGoWebhook(incoming());
  assert.deepEqual(parsed, {
    kind: "message",
    message: { instanceName: "browneria", messageId: "message-001", contactId: "5585999999999", text: "Oi" },
  });
});

test("aceita extendedTextMessage e ignora mensagens próprias, grupos, status e eventos não Message", () => {
  const extended = incoming({ data: { Info: { ID: "m2", Sender: "5585999999999@s.whatsapp.net", Chat: "5585999999999@s.whatsapp.net", IsFromMe: false, IsGroup: false, Type: "extendedTextMessage" }, Message: { extendedTextMessage: { text: "quero brownie" } } } });
  assert.equal(parseEvolutionGoWebhook(extended).kind, "message");
  assert.deepEqual(parseEvolutionGoWebhook(incoming({ data: { Info: { ID: "m3", Sender: "5585999999999@s.whatsapp.net", Chat: "5585999999999@s.whatsapp.net", IsFromMe: true, IsGroup: false, Type: "text" }, Message: { conversation: "eco" } } })), { kind: "ignored", reason: "own_message" });
  assert.deepEqual(parseEvolutionGoWebhook(incoming({ data: { Info: { ID: "m4", Sender: "5585999999999@s.whatsapp.net", Chat: "123@g.us", IsFromMe: false, IsGroup: true, Type: "text" }, Message: { conversation: "grupo" } } })), { kind: "ignored", reason: "group" });
  assert.deepEqual(parseEvolutionGoWebhook(incoming({ event: "Connected" })), { kind: "ignored", reason: "unsupported_event" });
});

test("configuração Evolution exige os três valores e não cria segredo de webhook não suportado", () => {
  assert.equal(readEvolutionGoConfig({}), undefined);
  assert.throws(() => readEvolutionGoConfig({ EVOLUTION_BASE_URL: "https://evolution.example.test" }), /devem ser definidos juntos/);
  assert.deepEqual(readEvolutionGoConfig({
    EVOLUTION_BASE_URL: "https://evolution.example.test/",
    EVOLUTION_INSTANCE_NAME: "browneria",
    EVOLUTION_INSTANCE_TOKEN: "token",
  }), { ...config, instanceToken: "token" });
  assert.equal(readEvolutionWebhookToken({}, { production: false, evolutionConfigured: false }), undefined);
  assert.throws(() => readEvolutionWebhookToken({}, { production: true, evolutionConfigured: false }), /EVOLUTION_WEBHOOK_TOKEN/);
  assert.throws(() => readEvolutionWebhookToken({}, { production: false, evolutionConfigured: true }), /EVOLUTION_WEBHOOK_TOKEN/);
});

test("sender usa POST /send/text, apikey da instância e formato JID oficial", async () => {
  let request: Request | undefined;
  const sender = createEvolutionGoTextSender({
    config,
    fetchFn: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ message: "success" }), { status: 200 });
    },
  });
  await sender.sendText({ contactId: "5585999999999", text: "Olá!" });
  assert.equal(request?.url, "https://evolution.example.test/send/text");
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("apikey"), config.instanceToken);
  assert.deepEqual(await request?.json(), { number: "5585999999999", text: "Olá!", formatJid: true });
});

test("webhook encaminha mensagem válida, envia a resposta e não reenvia duplicada", async () => {
  const processed: unknown[] = [];
  const sent: unknown[] = [];
  const handler = createEvolutionGoWebhookHandler({
    config,
    webhookToken: "webhook-secret",
    conversation: { async processText(input) { processed.push(input); return { duplicateMessage: false, messages: [{ type: "text", text: "Como posso ajudar?" }] }; } },
    sender: { async sendText(input) { sent.push(input); } },
  });
  const response = responseCapture();
  await handler({ query: { token: "webhook-secret" }, body: incoming() } as never, response as never, (() => undefined) as never);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(processed, [{ channel: "whatsapp", contactId: "5585999999999", messageId: "message-001", text: "Oi" }]);
  assert.deepEqual(sent, [{ contactId: "5585999999999", text: "Como posso ajudar?" }]);

  const duplicateHandler = createEvolutionGoWebhookHandler({
    config,
    webhookToken: "webhook-secret",
    conversation: { async processText() { return { duplicateMessage: true, messages: [{ type: "text" as const, text: "não enviar" }] }; } },
    sender: { async sendText(input) { sent.push(input); } },
  });
  const duplicateResponse = responseCapture();
  await duplicateHandler({ query: { token: "webhook-secret" }, body: incoming() } as never, duplicateResponse as never, (() => undefined) as never);
  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(sent.length, 1);
});

test("webhook rejeita token ausente ou inválido antes de ler payload, recusa payload inválido e ignora outra instância", async () => {
  let calls = 0;
  const handler = createEvolutionGoWebhookHandler({
    config,
    webhookToken: "webhook-secret",
    conversation: { async processText() { calls += 1; return { duplicateMessage: false, messages: [] }; } },
    sender: { async sendText() {} },
  });
  const unauthorized = responseCapture();
  await handler({ query: { token: "errado" }, body: incoming() } as never, unauthorized as never, (() => undefined) as never);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls, 0);
  const missingToken = responseCapture();
  await handler({ query: {}, body: incoming() } as never, missingToken as never, (() => undefined) as never);
  assert.equal(missingToken.statusCode, 401);
  assert.equal(calls, 0);
  const invalid = responseCapture();
  await handler({ query: { token: "webhook-secret" }, body: { event: "Message" } } as never, invalid as never, (() => undefined) as never);
  assert.equal(invalid.statusCode, 400);
  const other = responseCapture();
  await handler({ query: { token: "webhook-secret" }, body: incoming({ instanceName: "outra" }) } as never, other as never, (() => undefined) as never);
  assert.equal(other.statusCode, 204);
  assert.equal(calls, 0);
});

function domainStore(): AgentDomainStore {
  return {
    business: { name: "Brownieria", pickupEnabled: true, deliveryEnabled: false, deliveryFee: 0, pickupSlots: [], paymentMethods: ["PIX"] },
    products: [{ id: "p1", slug: "brigadeiro", name: "Brownie", description: "", category: "Brownies", basePrice: 5, promotionalPrice: null, minimumPromotionalQuantity: null, isActive: true, isAvailable: true, displayOrder: 1 }],
    orders: [],
  };
}

function acceptanceStore(): AgentDomainStore {
  const store = domainStore();
  store.business.name = "Brownieria Fortal";
  store.business.address = BROWNIER_PICKUP_ADDRESS;
  return store;
}

// Contrato em memória que representa somente a fronteira durável; o adapter
// Postgres é exercitado em teste próprio. Compartilhá-lo entre dois runtimes
// simula o restart sem depender de rede ou banco na suíte de aceitação.
function persistentStateForTest(): PostgresConversationState {
  const sessions = new Map<string, AgentSession>();
  const messages = new Map<string, { delivered: boolean; response?: Array<{ type: "text"; text: string }> }>();
  const key = (input: { channel: string; contactId: string; messageId?: string }) => `${input.channel}:${input.contactId}:${input.messageId ?? ""}`;
  return {
    async reserveIncoming(input) {
      const current = messages.get(key(input));
      if (!current) { messages.set(key(input), { delivered: false }); return { state: "NEW" }; }
      if (current.delivered) return { state: "DELIVERED" };
      return current.response ? { state: "READY", messages: structuredClone(current.response) } : { state: "DELIVERED" };
    },
    async loadSession(input) { return sessions.get(`${input.channel}:${input.contactId}`) && structuredClone(sessions.get(`${input.channel}:${input.contactId}`)!); },
    async saveSession({ session }) { sessions.set(`${session.channel}:${session.contactId}`, structuredClone(session)); },
    async saveResponse(input) { const current = messages.get(key(input)); if (current) current.response = structuredClone(input.messages); },
    async markResponseDelivered(input) { const current = messages.get(key(input)); if (current) current.delivered = true; },
  };
}

async function deliver(handler: ReturnType<typeof createEvolutionGoWebhookHandler>, payload: Record<string, unknown>) {
  const response = responseCapture();
  await handler({ query: { token: "webhook-secret" }, body: payload } as never, response as never, (() => undefined) as never);
  assert.equal(response.statusCode, 200);
}

class FakeNvidiaClient implements NvidiaCompatibleClient {
  calls: Record<string, unknown>[] = [];
  chat: NvidiaCompatibleClient["chat"];
  private readonly outputs: Array<string | Error>;

  constructor(outputs: Array<string | Error>) {
    this.outputs = outputs;
    this.chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          this.calls.push(params);
          const output = this.outputs.shift();
          if (output instanceof Error) throw output;
          return { choices: [{ message: { content: output ?? '{"status":"NOT_UNDERSTOOD","reason":"GENERIC"}' } }] };
        },
      },
    };
  }
}

const NIM_ENV = {
  BF_LLM_MODE: "NVIDIA_NEMOTRON",
  NVIDIA_API_KEY: "nvapi-test-only-not-a-real-key",
  NVIDIA_MODEL: "nvidia/test-model",
  NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
  BF_LLM_MAX_REQUESTS_PER_MINUTE: "10",
  BF_LLM_MAX_CONCURRENT_REQUESTS: "2",
};

test("runtime WhatsApp usa o fluxo real determinístico e a mesma sessão por contato", async () => {
  const store = domainStore();
  let saves = 0;
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => { saves += 1; },
  });
  const first = await runtime.processText({ channel: "whatsapp", contactId: "5585999999999", messageId: "m1", text: "oi" });
  const second = await runtime.processText({ channel: "whatsapp", contactId: "5585999999999", messageId: "m2", text: "cardápio" });
  const replay = await runtime.processText({ channel: "whatsapp", contactId: "5585999999999", messageId: "m2", text: "cardápio" });
  assert.equal(first.result?.event, "WELCOME");
  assert.equal(first.messages.length, 1);
  assert.doesNotMatch(first.messages[0]?.text ?? "", /cardápio/i);
  assert.equal(second.result?.event, "MENU_READY");
  assert.equal(second.sessionBefore.sessionKey, first.sessionAfter.sessionKey);
  assert.equal(replay.duplicateMessage, true);
  assert.deepEqual(replay.messages, []);
  assert.equal(saves, 0);
});

test("runtime WhatsApp responde endereço com dado real do Store e não consulta NVIDIA", async () => {
  const store = domainStore();
  store.business.address = BROWNIER_PICKUP_ADDRESS;
  const nvidiaClient = new FakeNvidiaClient([]);
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => {},
    env: NIM_ENV,
    nvidiaClient,
  });
  const result = await runtime.processText({
    channel: "whatsapp", contactId: "5585777777777", messageId: "address-1", text: "Qual o endereço de coleta?",
  });
  assert.equal(result.policyResult?.event, "BUSINESS_ADDRESS");
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0]?.text ?? "", /Rua Professor Leite Gondim, 896/);
  assert.equal(nvidiaClient.calls.length, 0);
});

test("runtime WhatsApp trata endereço ausente como informação comercial pendente, sem chamar NVIDIA", async () => {
  const store = domainStore();
  const nvidiaClient = new FakeNvidiaClient([]);
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => {},
    env: NIM_ENV,
    nvidiaClient,
  });
  const result = await runtime.processText({
    channel: "whatsapp", contactId: "5585666666666", messageId: "address-2", text: "Onde fica a retirada?",
  });
  assert.equal(result.policyResult?.event, "BUSINESS_ADDRESS_UNAVAILABLE");
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0]?.text ?? "", /atendente/i);
  assert.doesNotMatch(result.messages[0]?.text ?? "", /não consegui processar/i);
  assert.equal(nvidiaClient.calls.length, 0);
});

test("runtime WhatsApp usa NVIDIA como fallback para linguagem natural, mantém contexto e usa o catálogo real", async () => {
  const store = domainStore();
  const nvidiaClient = new FakeNvidiaClient([
    '{"status":"MATCHED","actions":[{"type":"START_CONVERSATION"}]}',
    '{"status":"MATCHED","actions":[{"type":"ADD_ITEM","productId":"p1","quantity":20}]}',
    '{"status":"MATCHED","actions":[{"type":"SHOW_MENU"}]}',
  ]);
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => {},
    env: NIM_ENV,
    nvidiaClient,
  });
  const contactId = "5585999999999";
  const interest = await runtime.processText({ channel: "whatsapp", contactId, messageId: "nim-1", text: "estou querendo uns brownies" });
  const quantity = await runtime.processText({ channel: "whatsapp", contactId, messageId: "nim-2", text: "qro vinte" });
  const price = await runtime.processText({ channel: "whatsapp", contactId, messageId: "nim-3", text: "quanto custa?" });
  const replay = await runtime.processText({ channel: "whatsapp", contactId, messageId: "nim-3", text: "quanto custa?" });

  assert.equal(interest.interpretation?.finalSource, "LLM");
  assert.equal(quantity.interpretation?.finalSource, "LLM");
  assert.equal(quantity.sessionBefore.step, "BROWSING_MENU");
  assert.equal(quantity.sessionAfter.step, "BUILDING_ORDER");
  assert.deepEqual(quantity.sessionAfter.items, [{ productId: "p1", quantity: 20 }]);
  assert.equal(price.result?.event, "MENU_READY");
  assert.match(price.messages[0]?.text ?? "", /Brownie/);
  assert.match(price.messages[0]?.text ?? "", /R\$\s*5,00/);
  assert.equal(replay.duplicateMessage, true);
  assert.equal(nvidiaClient.calls.length, 3);
  assert.ok(!JSON.stringify(nvidiaClient.calls).includes(contactId));
});

test("runtime WhatsApp preserva a sessão quando a saída NVIDIA é inválida ou quando o provider falha", async () => {
  const store = domainStore();
  const nvidiaClient = new FakeNvidiaClient([
    '{"status":"MATCHED","actions":[{"type":"ADD_ITEM","productId":"inventado","quantity":1}]}',
    new NvidiaNemotronLlmProviderError("NVIDIA_TIMEOUT", true),
  ]);
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => {},
    env: NIM_ENV,
    nvidiaClient,
  });
  const invalid = await runtime.processText({ channel: "whatsapp", contactId: "5585888888888", messageId: "nim-invalid", text: "quero um brownie raro" });
  const timeout = await runtime.processText({ channel: "whatsapp", contactId: "5585888888888", messageId: "nim-timeout", text: "me ajuda com isso" });

  assert.equal(invalid.interpretation?.llm?.status, "REJECTED");
  assert.equal(invalid.sessionAfter.step, "START");
  assert.equal(invalid.sessionAfter.items.length, 0);
  assert.equal(timeout.policyResult?.event, "POLICY_LLM_TEMPORARILY_UNAVAILABLE");
  assert.equal(timeout.sessionAfter.step, "START");
  assert.equal(timeout.sessionAfter.items.length, 0);
  assert.match(timeout.messages[0]?.text ?? "", /atendente/i);
  assert.doesNotMatch(timeout.messages[0]?.text ?? "", /cardápio|montar seu pedido/i);
  assert.doesNotMatch(timeout.messages[0]?.text ?? "", /não consegui processar/i);
  const replay = await runtime.processText({ channel: "whatsapp", contactId: "5585888888888", messageId: "nim-timeout", text: "me ajuda com isso" });
  assert.equal(replay.duplicateMessage, true);
});

test("runtime WhatsApp serializa duas mensagens rápidas da mesma sessão", async () => {
  const store = domainStore();
  const nvidiaClient = new FakeNvidiaClient([
    '{"status":"MATCHED","actions":[{"type":"START_CONVERSATION"}]}',
    '{"status":"MATCHED","actions":[{"type":"ADD_ITEM","productId":"p1","quantity":2}]}',
  ]);
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => {},
    env: NIM_ENV,
    nvidiaClient,
  });
  const contactId = "5585555555555";
  const [first, second] = await Promise.all([
    runtime.processText({ channel: "whatsapp", contactId, messageId: "rapid-1", text: "estou pensando em brownies" }),
    runtime.processText({ channel: "whatsapp", contactId, messageId: "rapid-2", text: "quero dois" }),
  ]);
  assert.equal(first.sessionAfter.step, "BROWSING_MENU");
  assert.equal(second.sessionBefore.step, "BROWSING_MENU");
  assert.deepEqual(second.sessionAfter.items, [{ productId: "p1", quantity: 2 }]);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
});

test("aceitação webhook: cada pergunta factual recebe uma única resposta real e na ordem", async () => {
  const store = acceptanceStore();
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store,
    saveDomainStore: async () => {},
    env: NIM_ENV,
    // Se uma dessas quatro perguntas chamar NIM, o teste falha.
    nvidiaClient: new FakeNvidiaClient([]),
  });
  const sent: Array<{ contactId: string; text: string }> = [];
  const handler = createEvolutionGoWebhookHandler({
    config, webhookToken: "webhook-secret", conversation: runtime,
    sender: { async sendText(message) { sent.push(message); } },
  });
  const contactId = "5585444444444";
  const message = (id: string, text: string) => incoming({
    data: { Info: { ID: id, Sender: `${contactId}@s.whatsapp.net`, Chat: `${contactId}@s.whatsapp.net`, IsFromMe: false, IsGroup: false, Type: "text" }, Message: { conversation: text } },
  });

  await deliver(handler, message("accept-greeting", "Boa noite"));
  await deliver(handler, message("accept-address", "Qual o endereço pra coleta?"));
  await deliver(handler, message("accept-pickup", "Posso retirar pedido agora?"));
  await deliver(handler, message("accept-menu", "Poderia me mandar o menu?"));

  assert.equal(sent.length, 4);
  assert.equal(sent[0]?.text, "Boa noite! Seja bem-vindo à Brownieria Fortal 😊 Como posso ajudar?");
  assert.match(sent[1]?.text ?? "", new RegExp(BROWNIER_PICKUP_ADDRESS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(sent[2]?.text, "Ainda não tenho a confirmação do horário de retirada agora. Posso chamar um atendente para confirmar para você.");
  assert.match(sent[3]?.text ?? "", /Brownie/);
  assert.deepEqual(sent.map(entry => entry.contactId), [contactId, contactId, contactId, contactId]);
});

test("aceitação webhook: mensagens rápidas preservam ordem e um replay após restart não reenvia", async () => {
  const store = acceptanceStore();
  const durableState = persistentStateForTest();
  const sent: Array<{ contactId: string; text: string }> = [];
  const createHandler = () => createEvolutionGoWebhookHandler({
    config, webhookToken: "webhook-secret",
    conversation: createWhatsappConversationRuntime({
      loadDomainStore: async () => store, saveDomainStore: async () => {}, persistentState: durableState,
      env: NIM_ENV, nvidiaClient: new FakeNvidiaClient([]),
    }),
    sender: { async sendText(message) { sent.push(message); } },
  });
  const contactId = "5585333333333";
  const payload = (id: string, text: string) => incoming({
    data: { Info: { ID: id, Sender: `${contactId}@s.whatsapp.net`, Chat: `${contactId}@s.whatsapp.net`, IsFromMe: false, IsGroup: false, Type: "text" }, Message: { conversation: text } },
  });
  const firstRuntimeHandler = createHandler();
  await Promise.all([
    deliver(firstRuntimeHandler, payload("rapid-address", "Qual o endereço?")),
    deliver(firstRuntimeHandler, payload("rapid-hours", "Posso retirar agora?")),
  ]);
  assert.equal(sent.length, 2);
  assert.match(sent[0]?.text ?? "", /Rua Professor Leite Gondim/);
  assert.match(sent[1]?.text ?? "", /horário de retirada agora/i);

  const restartedHandler = createHandler();
  await deliver(restartedHandler, payload("rapid-address", "Qual o endereço?"));
  assert.equal(sent.length, 2);
});

test("aceitação webhook: falha NVIDIA não substitui uma pergunta factual por fallback genérico", async () => {
  const store = acceptanceStore();
  const sent: Array<{ contactId: string; text: string }> = [];
  const runtime = createWhatsappConversationRuntime({
    loadDomainStore: async () => store, saveDomainStore: async () => {}, env: NIM_ENV,
    nvidiaClient: new FakeNvidiaClient([new NvidiaNemotronLlmProviderError("NVIDIA_TIMEOUT", true)]),
  });
  const handler = createEvolutionGoWebhookHandler({ config, webhookToken: "webhook-secret", conversation: runtime, sender: { async sendText(message) { sent.push(message); } } });
  await deliver(handler, incoming({ data: { Info: { ID: "nim-factual", Sender: "5585222222222@s.whatsapp.net", Chat: "5585222222222@s.whatsapp.net", IsFromMe: false, IsGroup: false, Type: "text" }, Message: { conversation: "Posso retirar pedido agora?" } } }));
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? "", /confirmação do horário de retirada/i);
  assert.doesNotMatch(sent[0]?.text ?? "", /cardápio|montar seu pedido/i);
});
