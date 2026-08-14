// Cobre a tradução de OperatingStatus -> messageKey/texto dentro do Text
// Conversation Service (pickupAvailabilityPolicyResult), ponta a ponta desde
// o texto do cliente até a mensagem renderizada — sempre com relógio
// injetado (nunca o real), para os quatro casos pedidos pelo produto:
// aberto, fechado hoje, fechado em outro dia, sem cadastro.
import assert from "node:assert/strict";
import test from "node:test";
import { createTextConversationService } from "../src/agent/text-conversation.service.ts";
import { createAgentConversationService } from "../src/agent/conversation.service.ts";
import { InMemoryAgentSessionStore } from "../src/agent/session.store.ts";
import { createAgentTools, type AgentDomainStore } from "../src/agent/tools.ts";
import { INITIAL_OPERATING_HOURS, type StructuredWeeklyHours } from "../src/lib/business-hours.ts";

const CH = "simulator";

function makeDomainStore(operatingHours: StructuredWeeklyHours | undefined): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", pickupEnabled: true, deliveryEnabled: false, deliveryFee: 0,
      pickupSlots: [], availabilityNotice: "", paymentMethods: ["PIX"],
      ...(operatingHours ? { operatingHours } : {}),
    },
    products: [],
    orders: [],
  };
}

function makeStack(operatingHours: StructuredWeeklyHours | undefined, now: () => Date) {
  const domainStore = makeDomainStore(operatingHours);
  const tools = createAgentTools({ store: domainStore, now });
  const sessionStore = new InMemoryAgentSessionStore();
  const conversationService = createAgentConversationService({ sessionStore, tools });
  const textService = createTextConversationService({ conversationService, sessionStore, tools });
  return { textService };
}

test('aberto agora: "Sim, estamos abertos agora. Você pode retirar até às 22h."', async () => {
  const { textService } = makeStack(INITIAL_OPERATING_HOURS, () => new Date("2026-08-03T15:00:00-03:00"));
  const result = await textService.processText({ channel: CH, contactId: "hours-open", text: "Posso retirar pedido agora?" });
  assert.equal(result.policyResult?.messageKey, "BUSINESS_OPEN_NOW");
  assert.equal(result.messages[0]?.text, "Sim, estamos abertos agora. Você pode retirar até às 22h.");
});

test('fechado, abre mais tarde hoje: "No momento estamos fechados. Abrimos hoje às 14h."', async () => {
  const { textService } = makeStack(INITIAL_OPERATING_HOURS, () => new Date("2026-08-04T01:00:00-03:00"));
  const result = await textService.processText({ channel: CH, contactId: "hours-closed-today", text: "Vocês estão abertos?" });
  assert.equal(result.policyResult?.messageKey, "BUSINESS_CLOSED_TODAY");
  assert.equal(result.messages[0]?.text, "No momento estamos fechados. Abrimos hoje às 14h.");
});

test('fechado, próxima abertura em outro dia: "...Nosso próximo horário de atendimento é segunda-feira, às 14h."', async () => {
  const { textService } = makeStack(INITIAL_OPERATING_HOURS, () => new Date("2026-08-02T10:00:00-03:00")); // domingo
  const result = await textService.processText({ channel: CH, contactId: "hours-closed-other-day", text: "Que horas vocês abrem?" });
  assert.equal(result.policyResult?.messageKey, "BUSINESS_CLOSED_OTHER_DAY");
  assert.equal(result.messages[0]?.text, "No momento estamos fechados. Nosso próximo horário de atendimento é segunda-feira, às 14h.");
});

test("pergunta composta de entrega e retirada amanhã responde os dois pontos", async () => {
  const { textService } = makeStack(INITIAL_OPERATING_HOURS, () => new Date("2026-08-07T15:00:00-03:00")); // sexta-feira; amanhã é sábado
  const result = await textService.processText({
    channel: CH,
    contactId: "delivery-and-tomorrow",
    text: "ok. que horas eu poso passa pra pegar amanha? ou vcs fazem entregas?",
  });
  assert.equal(result.policyResult?.messageKey, "BUSINESS_DELIVERY_UNAVAILABLE");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.text, "No momento, os pedidos são para retirada no local. Você pode buscar pessoalmente ou enviar um Uber Moto por sua conta.");
  assert.equal(result.messages[1]?.text, "Amanhã, sábado, não teremos retirada.");
});

test("pergunta só sobre entrega continua respondendo uma única mensagem", async () => {
  const { textService } = makeStack(INITIAL_OPERATING_HOURS, () => new Date("2026-08-07T15:00:00-03:00"));
  const result = await textService.processText({ channel: CH, contactId: "delivery-only", text: "vocês fazem entregas?" });
  assert.equal(result.policyResult?.messageKey, "BUSINESS_DELIVERY_UNAVAILABLE");
  assert.deepEqual(result.messages.map(message => message.text), [
    "No momento, os pedidos são para retirada no local. Você pode buscar pessoalmente ou enviar um Uber Moto por sua conta.",
  ]);
});

test('sem configuração: "Ainda não tenho a confirmação do horário de retirada. Posso chamar um atendente para confirmar."', async () => {
  const { textService } = makeStack(undefined, () => new Date("2026-08-03T10:00:00-03:00"));
  const result = await textService.processText({ channel: CH, contactId: "hours-unconfigured", text: "Posso buscar hoje?" });
  assert.equal(result.policyResult?.messageKey, "BUSINESS_PICKUP_HOURS_UNAVAILABLE");
  assert.equal(result.messages[0]?.text, "Ainda não tenho a confirmação do horário de retirada. Posso chamar um atendente para confirmar.");
});

test("pergunta de horário nunca aciona o Conversation Engine nem passa pelo LLM (finalSource é POLICY)", async () => {
  const { textService } = makeStack(INITIAL_OPERATING_HOURS, () => new Date("2026-08-03T10:00:00-03:00"));
  const result = await textService.processText({ channel: CH, contactId: "hours-policy-source", text: "Está aberto?" });
  assert.equal(result.interpretation?.finalSource, "POLICY");
  assert.equal(result.interpretation?.llm, undefined);
  assert.equal(result.result, undefined);
});
