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
  assert.equal(second.result?.event, "MENU_READY");
  assert.equal(second.sessionBefore.sessionKey, first.sessionAfter.sessionKey);
  assert.equal(replay.duplicateMessage, true);
  assert.deepEqual(replay.messages, []);
  assert.equal(saves, 0);
});
