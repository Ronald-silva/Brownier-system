import type { AgentSession } from "./session.types.ts";

export type ConversationDatabase = {
  query(queryText: string, values?: unknown[]): Promise<{ rows?: Array<Record<string, unknown>> }>;
};

export type StoredInboundMessage =
  | { state: "NEW" }
  | { state: "DELIVERED" }
  | { state: "READY"; messages: Array<{ type: "text"; text: string }> };

export type PostgresConversationState = {
  reserveIncoming(input: { channel: string; contactId: string; messageId: string }): Promise<StoredInboundMessage>;
  loadSession(input: { channel: string; contactId: string }): Promise<AgentSession | undefined>;
  saveSession(input: { session: AgentSession; lastIntent?: string }): Promise<void>;
  saveResponse(input: { channel: string; contactId: string; messageId: string; messages: Array<{ type: "text"; text: string }> }): Promise<void>;
  markResponseDelivered(input: { channel: string; contactId: string; messageId: string }): Promise<void>;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_conversation_sessions (
  channel TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  session JSONB NOT NULL,
  last_intent TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, contact_id)
);
CREATE TABLE IF NOT EXISTS agent_conversation_messages (
  channel TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  response_messages JSONB,
  delivery_status TEXT NOT NULL DEFAULT 'PROCESSING',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (channel, contact_id, message_id)
);
CREATE INDEX IF NOT EXISTS agent_conversation_messages_received_at_idx
  ON agent_conversation_messages (received_at);
`;

function isSession(value: unknown): value is AgentSession {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { sessionKey?: unknown }).sessionKey === "string"
    && typeof (value as { step?: unknown }).step === "string";
}

function safeMessages(value: unknown): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [{ type: "text" as const, text: candidate.text }] : [];
  });
}

export function createPostgresConversationState(database: ConversationDatabase): PostgresConversationState {
  let initialized: Promise<void> | undefined;
  const ensureSchema = () => initialized ??= database.query(SCHEMA_SQL).then(() => undefined);

  return {
    async reserveIncoming(input) {
      await ensureSchema();
      const inserted = await database.query(
        `INSERT INTO agent_conversation_messages (channel, contact_id, message_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id`,
        [input.channel, input.contactId, input.messageId],
      );
      if ((inserted.rows?.length ?? 0) > 0) return { state: "NEW" };
      const existing = await database.query(
        `SELECT delivery_status, response_messages FROM agent_conversation_messages
         WHERE channel = $1 AND contact_id = $2 AND message_id = $3`,
        [input.channel, input.contactId, input.messageId],
      );
      const row = existing.rows?.[0];
      if (!row || row.delivery_status === "DELIVERED") return { state: "DELIVERED" };
      const messages = safeMessages(row.response_messages);
      return messages.length > 0 ? { state: "READY", messages } : { state: "DELIVERED" };
    },
    async loadSession(input) {
      await ensureSchema();
      const result = await database.query(
        `SELECT session FROM agent_conversation_sessions WHERE channel = $1 AND contact_id = $2`,
        [input.channel, input.contactId],
      );
      const session = result.rows?.[0]?.session;
      return isSession(session) ? structuredClone(session) : undefined;
    },
    async saveSession(input) {
      await ensureSchema();
      await database.query(
        `INSERT INTO agent_conversation_sessions (channel, contact_id, session, last_intent)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (channel, contact_id) DO UPDATE
         SET session = EXCLUDED.session, last_intent = EXCLUDED.last_intent, updated_at = NOW()`,
        [input.session.channel, input.session.contactId, JSON.stringify(input.session), input.lastIntent ?? null],
      );
    },
    async saveResponse(input) {
      await ensureSchema();
      await database.query(
        `UPDATE agent_conversation_messages SET response_messages = $4::jsonb, delivery_status = 'READY'
         WHERE channel = $1 AND contact_id = $2 AND message_id = $3`,
        [input.channel, input.contactId, input.messageId, JSON.stringify(input.messages)],
      );
    },
    async markResponseDelivered(input) {
      await ensureSchema();
      await database.query(
        `UPDATE agent_conversation_messages SET delivery_status = 'DELIVERED', delivered_at = NOW()
         WHERE channel = $1 AND contact_id = $2 AND message_id = $3`,
        [input.channel, input.contactId, input.messageId],
      );
    },
  };
}
