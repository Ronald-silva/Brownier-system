import type { AgentConversationStep, AgentSession } from "./session.types.ts";

export type { AgentConversationStep, AgentSession, AgentCartItem } from "./session.types.ts";

export class AgentSessionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_CHANNEL_LENGTH = 40;
const MAX_CONTACT_ID_LENGTH = 128;

function looksLikePhoneNumber(value: string): boolean {
  return /\d/.test(value) && /^[+()\-.\s\d]+$/.test(value);
}

function normalizeContactId(raw: string): string {
  const trimmed = raw.trim();
  return looksLikePhoneNumber(trimmed) ? trimmed.replace(/[^\d]/g, "") : trimmed;
}

// Chave determinística "<channel>:<contactId>". Não expõe segredo algum —
// é apenas uma combinação normalizada dos dois identificadores públicos.
export function buildAgentSessionKey(channel: string, contactId: string): string {
  if (typeof channel !== "string" || typeof contactId !== "string") {
    throw new AgentSessionError("invalid_session_key", "channel e contactId são obrigatórios.");
  }
  const normalizedChannel = channel.trim().toLowerCase();
  const normalizedContactId = normalizeContactId(contactId);
  if (!normalizedChannel || normalizedChannel.length > MAX_CHANNEL_LENGTH) {
    throw new AgentSessionError("invalid_channel", "channel inválido ou ausente.");
  }
  if (!normalizedContactId || normalizedContactId.length > MAX_CONTACT_ID_LENGTH) {
    throw new AgentSessionError("invalid_contact_id", "contactId inválido ou ausente.");
  }
  return `${normalizedChannel}:${normalizedContactId}`;
}

export type CreateAgentSessionInput = {
  channel: string;
  contactId: string;
  step?: AgentConversationStep;
};

export type AgentSessionUpdater = (session: AgentSession) => AgentSession;

// Interface de armazenamento de sessões. Pensada para ser trocada no futuro
// por uma implementação com Redis ou banco de dados sem alterar quem a usa.
export interface AgentSessionStore {
  get(sessionKey: string): AgentSession | undefined;
  create(input: CreateAgentSessionInput): AgentSession;
  getOrCreate(input: CreateAgentSessionInput): AgentSession;
  update(sessionKey: string, updater: AgentSessionUpdater): AgentSession;
  delete(sessionKey: string): boolean;
  touch(sessionKey: string): AgentSession | undefined;
  markMessageProcessed(sessionKey: string, messageId: string): void;
  hasProcessedMessage(sessionKey: string, messageId: string): boolean;
  clearExpired(): number;
  size(): number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PROCESSED_MESSAGE_IDS = 100;

export type InMemoryAgentSessionStoreOptions = {
  ttlMs?: number;
  now?: () => Date;
  maxProcessedMessageIds?: number;
};

function validateItems(items: unknown): void {
  if (!Array.isArray(items)) {
    throw new AgentSessionError("invalid_items", "items deve ser uma lista.");
  }
  for (const item of items) {
    const productId = (item as { productId?: unknown } | null)?.productId;
    const quantity = (item as { quantity?: unknown } | null)?.quantity;
    if (typeof productId !== "string" || productId.trim().length === 0) {
      throw new AgentSessionError("invalid_item_product_id", "productId do item é obrigatório.");
    }
    if (!Number.isInteger(quantity) || (quantity as number) < 1) {
      throw new AgentSessionError("invalid_item_quantity", "quantity do item deve ser inteiro e positivo.");
    }
  }
}

function validateProcessedMessageIds(ids: unknown): void {
  if (!Array.isArray(ids)) {
    throw new AgentSessionError("invalid_processed_message_ids", "processedMessageIds deve ser uma lista.");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new AgentSessionError("invalid_processed_message_id", "processedMessageIds não pode conter valores vazios.");
    }
  }
}

function validateSession(session: AgentSession): void {
  validateItems(session.items);
  validateProcessedMessageIds(session.processedMessageIds);
  if (!Number.isInteger(session.misunderstandingCount) || session.misunderstandingCount < 0) {
    throw new AgentSessionError("invalid_misunderstanding_count", "misunderstandingCount deve ser inteiro e não negativo.");
  }
}

// Implementação em memória, guardada em um Map do processo. Reiniciar o
// processo perde todas as sessões — é apenas o armazenamento inicial para
// viabilizar o desenvolvimento e os testes; uma futura implementação (Redis,
// banco de dados) deve satisfazer a mesma interface AgentSessionStore.
export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly maxProcessedMessageIds: number;

  constructor(options: InMemoryAgentSessionStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new AgentSessionError("invalid_ttl", "ttlMs deve ser um número finito e positivo.");
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? (() => new Date());
    this.maxProcessedMessageIds = options.maxProcessedMessageIds ?? DEFAULT_MAX_PROCESSED_MESSAGE_IDS;
  }

  private isExpired(session: AgentSession): boolean {
    return new Date(session.expiresAt).getTime() <= this.now().getTime();
  }

  private readValid(sessionKey: string): AgentSession | undefined {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      this.sessions.delete(sessionKey);
      return undefined;
    }
    return session;
  }

  get(sessionKey: string): AgentSession | undefined {
    const session = this.readValid(sessionKey);
    return session ? clone(session) : undefined;
  }

  create(input: CreateAgentSessionInput): AgentSession {
    const sessionKey = buildAgentSessionKey(input.channel, input.contactId);
    if (this.readValid(sessionKey)) {
      throw new AgentSessionError("session_already_exists", `Já existe uma sessão para ${sessionKey}.`);
    }
    const timestamp = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    const session: AgentSession = {
      sessionKey,
      channel: sessionKey.split(":")[0]!,
      contactId: sessionKey.slice(sessionKey.indexOf(":") + 1),
      step: input.step ?? "START",
      items: [],
      processedMessageIds: [],
      underHumanHandoff: false,
      misunderstandingCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt,
    };
    this.sessions.set(sessionKey, clone(session));
    return clone(session);
  }

  getOrCreate(input: CreateAgentSessionInput): AgentSession {
    const sessionKey = buildAgentSessionKey(input.channel, input.contactId);
    const existing = this.readValid(sessionKey);
    if (existing) return clone(existing);
    return this.create(input);
  }

  update(sessionKey: string, updater: AgentSessionUpdater): AgentSession {
    const current = this.readValid(sessionKey);
    if (!current) {
      throw new AgentSessionError("session_not_found", `Sessão ${sessionKey} não encontrada ou expirada.`);
    }
    const proposed = updater(clone(current));
    const next: AgentSession = {
      ...proposed,
      sessionKey: current.sessionKey,
      channel: current.channel,
      contactId: current.contactId,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
    };
    validateSession(next);
    this.sessions.set(sessionKey, clone(next));
    return clone(next);
  }

  delete(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey);
  }

  touch(sessionKey: string): AgentSession | undefined {
    const current = this.readValid(sessionKey);
    if (!current) return undefined;
    const touched: AgentSession = {
      ...current,
      expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
    };
    this.sessions.set(sessionKey, clone(touched));
    return clone(touched);
  }

  markMessageProcessed(sessionKey: string, messageId: string): void {
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      throw new AgentSessionError("invalid_message_id", "messageId é obrigatório.");
    }
    const current = this.readValid(sessionKey);
    if (!current) {
      throw new AgentSessionError("session_not_found", `Sessão ${sessionKey} não encontrada ou expirada.`);
    }
    if (current.processedMessageIds.includes(messageId)) return;
    const processedMessageIds = [...current.processedMessageIds, messageId];
    while (processedMessageIds.length > this.maxProcessedMessageIds) {
      processedMessageIds.shift();
    }
    this.sessions.set(sessionKey, clone({ ...current, processedMessageIds }));
  }

  hasProcessedMessage(sessionKey: string, messageId: string): boolean {
    const current = this.readValid(sessionKey);
    if (!current) return false;
    return current.processedMessageIds.includes(messageId);
  }

  clearExpired(): number {
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    this.clearExpired();
    return this.sessions.size;
  }
}
