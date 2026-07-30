import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresConversationState } from "../src/agent/postgres-conversation-state.ts";
import type { AgentSession } from "../src/agent/session.types.ts";

function session(): AgentSession {
  return {
    sessionKey: "whatsapp:contact", channel: "whatsapp", contactId: "contact", step: "BROWSING_MENU", items: [],
    processedMessageIds: ["inbound-1"], underHumanHandoff: false, misunderstandingCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z",
  };
}

test("estado conversacional Postgres reserva, persiste sessão e marca a resposta entregue", async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let inserted = false;
  const database = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("INSERT INTO agent_conversation_messages")) {
        if (!inserted) { inserted = true; return { rows: [{ message_id: "inbound-1" }] }; }
        return { rows: [] };
      }
      if (text.includes("SELECT delivery_status")) return { rows: [{ delivery_status: "READY", response_messages: [{ type: "text", text: "resposta" }] }] };
      if (text.includes("SELECT session")) return { rows: [{ session: session() }] };
      return { rows: [] };
    },
  };
  const state = createPostgresConversationState(database);
  assert.deepEqual(await state.reserveIncoming({ channel: "whatsapp", contactId: "contact", messageId: "inbound-1" }), { state: "NEW" });
  await state.saveSession({ session: session(), lastIntent: "MENU_READY" });
  await state.saveResponse({ channel: "whatsapp", contactId: "contact", messageId: "inbound-1", messages: [{ type: "text", text: "resposta" }] });
  await state.markResponseDelivered({ channel: "whatsapp", contactId: "contact", messageId: "inbound-1" });
  assert.deepEqual(await state.loadSession({ channel: "whatsapp", contactId: "contact" }), session());
  assert.deepEqual(await state.reserveIncoming({ channel: "whatsapp", contactId: "contact", messageId: "inbound-1" }), { state: "READY", messages: [{ type: "text", text: "resposta" }] });
  assert.ok(queries.some(entry => entry.text.includes("CREATE TABLE IF NOT EXISTS agent_conversation_sessions")));
  assert.ok(queries.some(entry => entry.text.includes("ON CONFLICT (channel, contact_id) DO UPDATE")));
  assert.ok(queries.some(entry => entry.text.includes("delivery_status = 'DELIVERED'")));
});
