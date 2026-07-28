import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentSessionKey,
  InMemoryAgentSessionStore,
  type AgentSession,
} from "../src/agent/session.store.ts";

const TTL_MS = 30 * 60 * 1000;

function makeClock(startIso: string) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

function makeStore(overrides: Partial<{ ttlMs: number; now: () => Date; maxProcessedMessageIds: number }> = {}) {
  const clock = makeClock("2026-07-28T10:00:00.000Z");
  const store = new InMemoryAgentSessionStore({
    ttlMs: TTL_MS,
    now: clock.now,
    ...overrides,
  });
  return { store, clock };
}

// --- criação e leitura básicas ---

test("cria uma sessão nova para canal e contato", () => {
  const { store } = makeStore();
  const session = store.create({ channel: "whatsapp", contactId: "5585999999999" });
  assert.equal(session.channel, "whatsapp");
  assert.equal(session.contactId, "5585999999999");
  assert.equal(session.step, "START");
  assert.deepEqual(session.items, []);
});

test("lê uma sessão existente pela chave", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const read = store.get(created.sessionKey);
  assert.ok(read);
  assert.equal(read?.sessionKey, created.sessionKey);
});

test("duas chaves diferentes possuem sessões isoladas", () => {
  const { store } = makeStore();
  store.create({ channel: "whatsapp", contactId: "111" });
  store.create({ channel: "whatsapp", contactId: "222" });
  const a = store.get(buildAgentSessionKey("whatsapp", "111"));
  const b = store.get(buildAgentSessionKey("whatsapp", "222"));
  assert.notEqual(a?.sessionKey, b?.sessionKey);
});

test("getOrCreate não duplica sessão existente", () => {
  const { store } = makeStore();
  const first = store.getOrCreate({ channel: "whatsapp", contactId: "111" });
  const second = store.getOrCreate({ channel: "whatsapp", contactId: "111" });
  assert.equal(first.createdAt, second.createdAt);
  assert.equal(store.size(), 1);
});

test("create rejeita chave duplicada", () => {
  const { store } = makeStore();
  store.create({ channel: "whatsapp", contactId: "111" });
  assert.throws(() => store.create({ channel: "whatsapp", contactId: "111" }));
});

// --- update / touch ---

test("update altera dados da sessão", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const updated = store.update(created.sessionKey, s => ({ ...s, step: "BROWSING_MENU" }));
  assert.equal(updated.step, "BROWSING_MENU");
});

test("update renova updatedAt", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(1000);
  const updated = store.update(created.sessionKey, s => s);
  assert.notEqual(updated.updatedAt, created.updatedAt);
});

test("update renova expiresAt", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(1000);
  const updated = store.update(created.sessionKey, s => s);
  assert.ok(new Date(updated.expiresAt).getTime() > new Date(created.expiresAt).getTime());
});

test("createdAt permanece igual após update", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(1000);
  const updated = store.update(created.sessionKey, s => ({ ...s, step: "BROWSING_MENU" }));
  assert.equal(updated.createdAt, created.createdAt);
});

test("touch renova expiração sem exigir update completo", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(1000);
  const touched = store.touch(created.sessionKey);
  assert.ok(touched);
  assert.ok(new Date(touched!.expiresAt).getTime() > new Date(created.expiresAt).getTime());
});

test("delete remove a sessão definitivamente", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const removed = store.delete(created.sessionKey);
  assert.equal(removed, true);
  assert.equal(store.get(created.sessionKey), undefined);
});

// --- expiração ---

test("sessão expirada não é retornada por get", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(TTL_MS + 1);
  assert.equal(store.get(created.sessionKey), undefined);
});

test("getOrCreate substitui sessão expirada por uma nova", () => {
  const { store, clock } = makeStore();
  const first = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(TTL_MS + 1);
  const second = store.getOrCreate({ channel: "whatsapp", contactId: "111" });
  assert.notEqual(second.createdAt, first.createdAt);
});

test("clearExpired remove somente sessões expiradas", () => {
  const { store, clock } = makeStore();
  store.create({ channel: "whatsapp", contactId: "expira" });
  clock.advance(TTL_MS + 1);
  store.create({ channel: "whatsapp", contactId: "viva" });
  const removed = store.clearExpired();
  assert.equal(removed, 1);
  assert.equal(store.size(), 1);
});

test("size reflete apenas sessões válidas", () => {
  const { store, clock } = makeStore();
  store.create({ channel: "whatsapp", contactId: "expira" });
  clock.advance(TTL_MS + 1);
  store.create({ channel: "whatsapp", contactId: "viva" });
  assert.equal(store.size(), 1);
});

test("TTL inválido é rejeitado na construção do store", () => {
  assert.throws(() => new InMemoryAgentSessionStore({ ttlMs: 0 }));
  assert.throws(() => new InMemoryAgentSessionStore({ ttlMs: -10 }));
  assert.throws(() => new InMemoryAgentSessionStore({ ttlMs: NaN }));
});

test("relógio injetado permite testar expiração sem sleep", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(TTL_MS - 1);
  assert.ok(store.get(created.sessionKey));
  clock.advance(2);
  assert.equal(store.get(created.sessionKey), undefined);
});

// --- mensagens processadas ---

test("messageId é registrado como processado", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  store.markMessageProcessed(created.sessionKey, "msg-1");
  assert.equal(store.hasProcessedMessage(created.sessionKey, "msg-1"), true);
});

test("messageId repetido não é duplicado na lista", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  store.markMessageProcessed(created.sessionKey, "msg-1");
  store.markMessageProcessed(created.sessionKey, "msg-1");
  const session = store.get(created.sessionKey);
  assert.equal(session?.processedMessageIds.filter(id => id === "msg-1").length, 1);
});

test("hasProcessedMessage funciona de forma determinística", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  assert.equal(store.hasProcessedMessage(created.sessionKey, "msg-1"), false);
  store.markMessageProcessed(created.sessionKey, "msg-1");
  assert.equal(store.hasProcessedMessage(created.sessionKey, "msg-1"), true);
});

test("limite de IDs processados remove os mais antigos", () => {
  const { store } = makeStore({ maxProcessedMessageIds: 3 });
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  store.markMessageProcessed(created.sessionKey, "msg-1");
  store.markMessageProcessed(created.sessionKey, "msg-2");
  store.markMessageProcessed(created.sessionKey, "msg-3");
  store.markMessageProcessed(created.sessionKey, "msg-4");
  const session = store.get(created.sessionKey);
  assert.deepEqual(session?.processedMessageIds, ["msg-2", "msg-3", "msg-4"]);
});

test("messageId vazio é rejeitado", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  assert.throws(() => store.markMessageProcessed(created.sessionKey, ""));
  assert.throws(() => store.markMessageProcessed(created.sessionKey, "   "));
});

// --- buildAgentSessionKey ---

test("chave normaliza canal para minúsculas", () => {
  const key = buildAgentSessionKey("WhatsApp", "111");
  assert.equal(key, buildAgentSessionKey("whatsapp", "111"));
});

test("chave normaliza telefone com máscara removendo formatação", () => {
  const key = buildAgentSessionKey("whatsapp", "(85) 99999-9999");
  assert.equal(key, buildAgentSessionKey("whatsapp", "85999999999"));
});

test("identificador não telefônico permanece utilizável", () => {
  const key = buildAgentSessionKey("web-chat", "user_abc-123");
  assert.equal(key, "web-chat:user_abc-123");
});

test("channel vazio é rejeitado na construção da chave", () => {
  assert.throws(() => buildAgentSessionKey("", "111"));
  assert.throws(() => buildAgentSessionKey("   ", "111"));
});

test("contactId vazio é rejeitado na construção da chave", () => {
  assert.throws(() => buildAgentSessionKey("whatsapp", ""));
  assert.throws(() => buildAgentSessionKey("whatsapp", "   "));
});

// --- cópias defensivas ---

test("retorno de get é uma cópia defensiva", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const first = store.get(created.sessionKey)!;
  (first as AgentSession).step = "ORDER_CREATED";
  const second = store.get(created.sessionKey)!;
  assert.equal(second.step, "START");
});

test("array items retornado é uma cópia defensiva", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  store.update(created.sessionKey, s => ({ ...s, items: [{ productId: "p1", quantity: 1 }] }));
  const session = store.get(created.sessionKey)!;
  session.items.push({ productId: "p2", quantity: 2 });
  const again = store.get(created.sessionKey)!;
  assert.equal(again.items.length, 1);
});

test("processedMessageIds retornado é uma cópia defensiva", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  store.markMessageProcessed(created.sessionKey, "msg-1");
  const session = store.get(created.sessionKey)!;
  session.processedMessageIds.push("msg-2");
  const again = store.get(created.sessionKey)!;
  assert.equal(again.processedMessageIds.length, 1);
});

// --- invariantes no updater ---

test("updater não consegue alterar sessionKey", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const updated = store.update(created.sessionKey, s => ({ ...s, sessionKey: "outra-chave" }));
  assert.equal(updated.sessionKey, created.sessionKey);
});

test("updater não consegue alterar channel", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const updated = store.update(created.sessionKey, s => ({ ...s, channel: "telegram" }));
  assert.equal(updated.channel, "whatsapp");
});

test("updater não consegue alterar contactId", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  const updated = store.update(created.sessionKey, s => ({ ...s, contactId: "222" }));
  assert.equal(updated.contactId, "111");
});

test("updater não consegue alterar createdAt", () => {
  const { store, clock } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  clock.advance(1000);
  const updated = store.update(created.sessionKey, s => ({ ...s, createdAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(updated.createdAt, created.createdAt);
});

test("quantidade de item inválida é rejeitada pelo update", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  assert.throws(() => store.update(created.sessionKey, s => ({ ...s, items: [{ productId: "p1", quantity: 0 }] })));
  assert.throws(() => store.update(created.sessionKey, s => ({ ...s, items: [{ productId: "p1", quantity: 1.5 }] })));
  assert.throws(() => store.update(created.sessionKey, s => ({ ...s, items: [{ productId: "", quantity: 1 }] })));
});

test("misunderstandingCount negativo é rejeitado pelo update", () => {
  const { store } = makeStore();
  const created = store.create({ channel: "whatsapp", contactId: "111" });
  assert.throws(() => store.update(created.sessionKey, s => ({ ...s, misunderstandingCount: -1 })));
});
