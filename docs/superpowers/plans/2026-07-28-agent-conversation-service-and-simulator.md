# Agent Conversation Service & Local Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a thin application layer (`AgentConversationService`) that coordinates the existing `AgentSessionStore` and `handleConversationAction` engine — handling session load/create, messageId deduplication, and persistence — plus a local stdin/stdout simulator that exercises this layer against the real product/order domain, entirely isolated from HTTP, WhatsApp, and AI.

**Architecture:** `src/agent/conversation.service.ts` exposes `createAgentConversationService({ sessionStore, tools, now?, generateOrderIdempotencyKey? })` with a single `processAction({ channel, contactId, messageId?, action })` method. It never touches the session store's internal Map — only its public interface (`getOrCreate`, `update`, `markMessageProcessed`, `hasProcessedMessage`, `get`) — and never duplicates the Conversation Engine's transition rules. `src/agent/simulator.ts` is a standalone Node script: it loads the real domain store via `src/lib/store.ts` (respecting `BF_STORE_PATH`), wires `createAgentTools` + `InMemoryAgentSessionStore` + the new service, reads newline-delimited JSON actions from stdin, and writes newline-delimited JSON results to stdout. Sessions live only in memory; the domain store file is only re-saved when an action's `event` is `ORDER_CREATED`.

**Tech Stack:** TypeScript (Node's `--experimental-strip-types`, no compilation step), `node:test` + `node:assert/strict` (existing project test runner), `node:readline` for stdin, `node:child_process` for black-box simulator tests. No new dependencies.

## Global Constraints

- Do not implement AI, WhatsApp, natural-language parsing, or any system prompt. Structured actions only.
- Do not modify `src/lib/orders.ts`, `src/agent/tools.ts`, `server.ts`, any frontend/`/equipe` panel code, or real JSON data files (`data/brownies-fortal.demo.json`).
- Only touch `src/agent/conversation.engine.ts` for a minimal, indispensable fix — expected: no changes at all.
- Do not install dependencies. Do not open an HTTP port. Do not create a webhook or singleton.
- Tests must never read/write `data/brownies-fortal.demo.json` — use in-memory fixtures or a temp file via `BF_STORE_PATH`.
- Follow existing test conventions: `node:test`, `node:assert/strict`, local `product()`/`makeStore()`-style fixtures per file (see `tests/agent_conversation_engine.test.ts`, `tests/agent_tools.test.ts`).
- The engine (`handleConversationAction`) and session store (`InMemoryAgentSessionStore`) APIs are frozen inputs for this plan — treat their current signatures (read below) as fixed contracts, not something to redesign.
- New npm script (if added) must not require installing `tsx`/`ts-node`; use `node --experimental-strip-types` like the existing `test` script does.
- Do not create a git commit (per task instructions) unless the user explicitly asks for it later.

### Frozen contracts this plan builds on

`src/agent/session.store.ts`:
```ts
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
export function buildAgentSessionKey(channel: string, contactId: string): string;
export class AgentSessionError extends Error { code: string; }
```
`update()` always overwrites `sessionKey`, `channel`, `contactId`, `createdAt` from the currently stored session and recomputes `updatedAt`/`expiresAt` — whatever the updater returns for those fields is ignored. `markMessageProcessed` throws `AgentSessionError` on an empty/whitespace messageId or a missing session.

`src/agent/conversation.engine.ts`:
```ts
export function handleConversationAction(input: HandleConversationActionInput): AgentConversationResult;
// HandleConversationActionInput = { session: AgentSession; action: AgentConversationAction; tools: AgentTools; now?: () => Date; generateOrderIdempotencyKey?: () => string }
// AgentConversationResult = { session: AgentSession; previousStep; currentStep; event: string; messageKey: string; data?: Record<string, unknown> }
```
Never mutates the input session. Throws `AgentConversationError` only for genuine technical failures (invalid generated idempotency key, unexpected `createOrder` error); all conversational failures come back as a structured result (e.g. `INVALID_ACTION`), never a throw.

`src/agent/tools.ts` / `src/lib/store.ts` / `src/lib/orders.ts`: unchanged, used as-is. `resolveStorePath()`, `loadStoreFile()`, `saveStoreFile()` come from `src/lib/store.ts`.

---

## Task 1: Agent Conversation Service

**Files:**
- Create: `src/agent/conversation.service.ts`
- Test: `tests/agent_conversation_service.test.ts`

**Interfaces:**
- Consumes: `AgentSessionStore`, `buildAgentSessionKey` from `src/agent/session.store.ts`; `handleConversationAction` from `src/agent/conversation.engine.ts`; `AgentConversationAction`, `AgentConversationResult` from `src/agent/conversation.types.ts`; `AgentTools` from `src/agent/tools.ts`; `AgentSession` from `src/agent/session.types.ts`.
- Produces (for Task 2/3 and the simulator):
  ```ts
  export class AgentConversationServiceError extends Error { code: string; }
  export type AgentConversationServiceDependencies = {
    sessionStore: AgentSessionStore;
    tools: AgentTools;
    now?: () => Date;
    generateOrderIdempotencyKey?: () => string;
  };
  export type ProcessActionInput = {
    channel: string;
    contactId: string;
    messageId?: string;
    action: AgentConversationAction;
  };
  export type AgentConversationServiceResult = {
    sessionKey: string;
    sessionBefore: AgentSession;
    result: AgentConversationResult;
    sessionAfter: AgentSession;
    duplicateMessage: boolean;
  };
  export type AgentConversationService = { processAction(input: ProcessActionInput): AgentConversationServiceResult };
  export function createAgentConversationService(deps: AgentConversationServiceDependencies): AgentConversationService;
  ```

- [ ] **Step 1: Write the failing test file**

Create `tests/agent_conversation_service.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentConversationService,
  AgentConversationServiceError,
  type AgentConversationServiceDependencies,
} from "../src/agent/conversation.service.ts";
import { InMemoryAgentSessionStore, buildAgentSessionKey, type AgentSessionStore } from "../src/agent/session.store.ts";
import { createAgentTools, type AgentDomainStore, type AgentTools } from "../src/agent/tools.ts";
import { AgentConversationError, type AgentConversationAction } from "../src/agent/conversation.types.ts";
import type { AgentSession } from "../src/agent/session.types.ts";

// --- fábricas de teste (mesmo padrão de tests/agent_conversation_engine.test.ts) ---

function product(overrides: Partial<AgentDomainStore["products"][number]> = {}) {
  return {
    id: "p1", slug: "brigadeiro", name: "Brownie de Brigadeiro", description: "Descrição do brigadeiro",
    category: "Brownies", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20,
    isActive: true, isAvailable: true, displayOrder: 1, ingredients: "Chocolate", allergens: "Glúten",
    ...overrides,
  };
}

function makeDomainStore(overrides: Partial<AgentDomainStore> = {}): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal", phone: "8530000000", whatsapp: "85999998888",
      pickupEnabled: true, deliveryEnabled: true, deliveryFee: 5,
      pickupSlots: ["19:00", "18:00"], availabilityNotice: "Sabores podem variar.",
      paymentMethods: ["PIX", "DINHEIRO"],
    },
    products: [product()],
    orders: [],
    ...overrides,
  };
}

function makeClock(startIso: string) {
  let current = new Date(startIso).getTime();
  return { now: () => new Date(current), advance(ms: number) { current += ms; } };
}

function makeService(overrides: Partial<AgentConversationServiceDependencies & { domainStore: AgentDomainStore }> = {}) {
  const domainStore = overrides.domainStore ?? makeDomainStore();
  const sessionStore = overrides.sessionStore ?? new InMemoryAgentSessionStore();
  const tools = overrides.tools ?? createAgentTools({ store: domainStore });
  const service = createAgentConversationService({
    sessionStore,
    tools,
    now: overrides.now,
    generateOrderIdempotencyKey: overrides.generateOrderIdempotencyKey,
  });
  return { service, sessionStore, tools, domainStore };
}

function wrapWithBrokenUpdate(base: AgentSessionStore): AgentSessionStore {
  return {
    get: sessionKey => base.get(sessionKey),
    create: input => base.create(input),
    getOrCreate: input => base.getOrCreate(input),
    update: () => { throw new Error("falha de persistência simulada"); },
    delete: sessionKey => base.delete(sessionKey),
    touch: sessionKey => base.touch(sessionKey),
    markMessageProcessed: (sessionKey, messageId) => base.markMessageProcessed(sessionKey, messageId),
    hasProcessedMessage: (sessionKey, messageId) => base.hasProcessedMessage(sessionKey, messageId),
    clearExpired: () => base.clearExpired(),
    size: () => base.size(),
  };
}

const START: AgentConversationAction = { type: "START_CONVERSATION" };
const SHOW_MENU: AgentConversationAction = { type: "SHOW_MENU" };

// --- 1-3: sessionKey e criação/reuso de sessão ---

test("gera sessionKey determinístico a partir de channel e contactId", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "(85) 99999-9999", action: START });
  assert.equal(result.sessionKey, buildAgentSessionKey("whatsapp", "85999999999"));
});

test("cria sessão inexistente em START, com step inicial START", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  assert.equal(result.sessionBefore.step, "START");
  assert.equal(result.sessionBefore.channel, "whatsapp");
  assert.equal(result.sessionBefore.contactId, "111");
  assert.deepEqual(result.sessionBefore.items, []);
});

test("reutiliza sessão existente em vez de recriar", () => {
  const { service } = makeService();
  const first = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  const second = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU });
  assert.equal(second.sessionBefore.createdAt, first.sessionAfter.createdAt);
  assert.equal(second.sessionBefore.step, "BROWSING_MENU");
});

// --- 4-6: chamada ao engine e persistência ---

test("chama o engine com a sessão atual e devolve o resultado dele", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  assert.equal(result.result.event, "WELCOME");
  assert.equal(result.result.currentStep, "BROWSING_MENU");
});

test("persiste a sessão retornada pelo engine no Session Store", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  const stored = sessionStore.get(result.sessionKey);
  assert.equal(stored?.step, "BROWSING_MENU");
});

test("sessionAfter reflete a sessão realmente persistida, não apenas o objeto do engine", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  const stored = sessionStore.get(result.sessionKey);
  assert.deepEqual(result.sessionAfter, stored);
  assert.deepEqual(result.result.session, stored);
});

// --- 7-10: messageId e deduplicação ---

test("mensagem sem messageId é processada normalmente e duplicateMessage é false", () => {
  const { service } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  assert.equal(result.duplicateMessage, false);
  assert.equal(result.sessionAfter.processedMessageIds.length, 0);
});

test("messageId inédito é registrado como processado", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  assert.equal(sessionStore.hasProcessedMessage(result.sessionKey, "m1"), true);
  assert.deepEqual(result.sessionAfter.processedMessageIds, ["m1"]);
});

test("messageId repetido não chama o engine nem altera o estado de negócio", () => {
  const { service, domainStore } = makeService();
  service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  const before = JSON.parse(JSON.stringify(domainStore));
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m1" });
  assert.equal(result.duplicateMessage, true);
  assert.deepEqual(domainStore, before);
  assert.equal(result.sessionAfter.step, "BROWSING_MENU");
});

test("messageId repetido devolve MESSAGE_ALREADY_PROCESSED com a sessão atual, sem alterar o passo", () => {
  const { service } = makeService();
  const first = service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m1" });
  assert.equal(result.result.event, "MESSAGE_ALREADY_PROCESSED");
  assert.equal(result.result.messageKey, "MESSAGE_ALREADY_PROCESSED");
  assert.equal(result.result.previousStep, first.sessionAfter.step);
  assert.equal(result.result.currentStep, first.sessionAfter.step);
  assert.deepEqual(result.result.data, { messageId: "m1" });
});

// --- 11: mensagem repetida não cria segundo pedido (fluxo de confirmação) ---

function readySessionPayload(): { channel: string; contactId: string } {
  return { channel: "whatsapp", contactId: "222" };
}

function advanceToAwaitingConfirmation(service: ReturnType<typeof makeService>["service"]) {
  const { channel, contactId } = readySessionPayload();
  service.processAction({ channel, contactId, action: START });
  service.processAction({ channel, contactId, action: { type: "ADD_ITEM", productId: "p1", quantity: 2 } });
  service.processAction({ channel, contactId, action: { type: "FINISH_CART" } });
  service.processAction({ channel, contactId, action: { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" } });
  service.processAction({ channel, contactId, action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" } });
  service.processAction({ channel, contactId, action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" } });
  service.processAction({ channel, contactId, action: { type: "SET_PICKUP_TIME", pickupTime: "18:00" } });
  service.processAction({ channel, contactId, action: { type: "SKIP_CUSTOMER_NOTES" } });
  const last = service.processAction({ channel, contactId, action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" } });
  return last.sessionKey;
}

test("CONFIRM_ORDER repetido com o mesmo messageId cria apenas um pedido", () => {
  const { service, domainStore } = makeService();
  advanceToAwaitingConfirmation(service);
  const { channel, contactId } = readySessionPayload();
  const first = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-1" });
  const second = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-1" });
  assert.equal(first.result.event, "ORDER_CREATED");
  assert.equal(second.duplicateMessage, true);
  assert.equal(domainStore.orders.length, 1);
});

test("CONFIRM_ORDER com messageIds diferentes na mesma sessão reaproveita a orderIdempotencyKey e não cria um segundo pedido", () => {
  const { service, domainStore } = makeService();
  advanceToAwaitingConfirmation(service);
  const { channel, contactId } = readySessionPayload();
  const first = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-a" });
  const second = service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-b" });
  assert.equal(first.result.event, "ORDER_CREATED");
  assert.equal(second.duplicateMessage, false);
  assert.equal(second.result.event, "ORDER_ALREADY_CREATED");
  assert.equal(second.result.data?.orderId, first.result.data?.orderId);
  assert.equal(domainStore.orders.length, 1);
});

// --- 12-13: erros técnicos não registram messageId ---

test("erro técnico do engine não registra messageId nem persiste sessão parcial", () => {
  const { service, sessionStore } = makeService({ generateOrderIdempotencyKey: () => "chave com espaço inválida" });
  const { channel, contactId } = readySessionPayload();
  service.processAction({ channel, contactId, action: START });
  service.processAction({ channel, contactId, action: { type: "ADD_ITEM", productId: "p1", quantity: 2 } });
  service.processAction({ channel, contactId, action: { type: "FINISH_CART" } });
  service.processAction({ channel, contactId, action: { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" } });
  service.processAction({ channel, contactId, action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" } });
  service.processAction({ channel, contactId, action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" } });
  service.processAction({ channel, contactId, action: { type: "SET_PICKUP_TIME", pickupTime: "18:00" } });
  service.processAction({ channel, contactId, action: { type: "SKIP_CUSTOMER_NOTES" } });
  const beforeConfirm = service.processAction({ channel, contactId, action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" } });
  assert.throws(
    () => service.processAction({ channel, contactId, action: { type: "CONFIRM_ORDER" }, messageId: "confirm-x" }),
    AgentConversationError,
  );
  assert.equal(sessionStore.hasProcessedMessage(beforeConfirm.sessionKey, "confirm-x"), false);
  const stored = sessionStore.get(beforeConfirm.sessionKey);
  assert.equal(stored?.step, "AWAITING_CONFIRMATION");
  assert.equal(stored?.createdOrderId, undefined);
});

test("erro de persistência não registra messageId e propaga o erro", () => {
  const base = new InMemoryAgentSessionStore();
  const broken = wrapWithBrokenUpdate(base);
  const { service } = makeService({ sessionStore: broken });
  assert.throws(() => service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" }));
  assert.equal(broken.hasProcessedMessage(buildAgentSessionKey("whatsapp", "111"), "m1"), false);
});

// --- 14-15: isolamento entre canais e contatos ---

test("canais diferentes para o mesmo contato ficam isolados", () => {
  const { service } = makeService();
  service.processAction({ channel: "whatsapp", contactId: "558500000001", action: START });
  const telegram = service.processAction({ channel: "telegram", contactId: "558500000001", action: START });
  assert.notEqual(telegram.sessionKey, buildAgentSessionKey("whatsapp", "558500000001"));
  assert.equal(telegram.sessionBefore.step, "START");
});

test("contatos diferentes no mesmo canal ficam isolados", () => {
  const { service } = makeService();
  service.processAction({ channel: "whatsapp", contactId: "558500000001", action: START });
  const other = service.processAction({ channel: "whatsapp", contactId: "558500000002", action: START });
  assert.equal(other.sessionBefore.step, "START");
  assert.equal(other.sessionBefore.items.length, 0);
});

// --- 16-18: cópias defensivas ---

test("sessionBefore é uma cópia defensiva", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  (result.sessionBefore as AgentSession).step = "ORDER_CREATED";
  const stored = sessionStore.get(result.sessionKey);
  assert.notEqual(stored?.step, "ORDER_CREATED");
});

test("sessionAfter é uma cópia defensiva e mutá-la não afeta o Session Store", () => {
  const { service, sessionStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  result.sessionAfter.items.push({ productId: "injetado", quantity: 1 });
  const stored = sessionStore.get(result.sessionKey);
  assert.equal(stored?.items.length, 0);
});

test("mutar o resultado devolvido não altera o domain store internamente", () => {
  const { service, domainStore } = makeService();
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  (result.result.data as { products: unknown[] }).products.push({ id: "fake" });
  assert.equal(domainStore.products.length, 1);
});

// --- 19: expiresAt continua sob responsabilidade do Session Store ---

test("expiresAt é renovado pelo Session Store, não calculado pelo service", () => {
  const clock = makeClock("2026-07-28T10:00:00.000Z");
  const sessionStore = new InMemoryAgentSessionStore({ now: clock.now });
  const { service } = makeService({ sessionStore });
  const first = service.processAction({ channel: "whatsapp", contactId: "111", action: START });
  clock.advance(1000);
  const second = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU });
  assert.ok(new Date(second.sessionAfter.expiresAt).getTime() > new Date(first.sessionAfter.expiresAt).getTime());
});

// --- 20: limite de processedMessageIds já implementado no store é respeitado ---

test("processedMessageIds respeita o limite configurado no Session Store", () => {
  const sessionStore = new InMemoryAgentSessionStore({ maxProcessedMessageIds: 3 });
  const { service } = makeService({ sessionStore });
  service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "m1" });
  service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m2" });
  service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m3" });
  const result = service.processAction({ channel: "whatsapp", contactId: "111", action: SHOW_MENU, messageId: "m4" });
  assert.deepEqual(result.sessionAfter.processedMessageIds, ["m2", "m3", "m4"]);
});

// --- messageId inválido é rejeitado sem tocar o engine ---

test("messageId vazio ou apenas espaços é rejeitado com erro técnico controlado", () => {
  const { service } = makeService();
  assert.throws(
    () => service.processAction({ channel: "whatsapp", contactId: "111", action: START, messageId: "   " }),
    AgentConversationServiceError,
  );
});

// --- fluxo completo até ORDER_CREATED ---

test("fluxo completo START..CONFIRM_ORDER cria um pedido e preserva todos os messageIds", () => {
  const { service, sessionStore, domainStore } = makeService();
  const channel = "whatsapp";
  const contactId = "333";
  const steps: Array<{ action: AgentConversationAction; messageId: string }> = [
    { action: { type: "START_CONVERSATION" }, messageId: "msg-1" },
    { action: { type: "SHOW_MENU" }, messageId: "msg-2" },
    { action: { type: "ADD_ITEM", productId: "p1", quantity: 2 }, messageId: "msg-3" },
    { action: { type: "FINISH_CART" }, messageId: "msg-4" },
    { action: { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" }, messageId: "msg-5" },
    { action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" }, messageId: "msg-6" },
    { action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" }, messageId: "msg-7" },
    { action: { type: "SET_PICKUP_TIME", pickupTime: "18:00" }, messageId: "msg-8" },
    { action: { type: "SKIP_CUSTOMER_NOTES" }, messageId: "msg-9" },
    { action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" }, messageId: "msg-10" },
    { action: { type: "REVIEW_ORDER" }, messageId: "msg-11" },
    { action: { type: "CONFIRM_ORDER" }, messageId: "msg-12" },
  ];
  let last: ReturnType<typeof service.processAction> | undefined;
  const sessionKeys = new Set<string>();
  for (const step of steps) {
    last = service.processAction({ channel, contactId, action: step.action, messageId: step.messageId });
    sessionKeys.add(last.sessionKey);
  }
  assert.equal(sessionKeys.size, 1);
  assert.equal(last?.sessionAfter.step, "ORDER_CREATED");
  assert.ok(last?.sessionAfter.createdOrderPublicCode);
  assert.deepEqual(
    last?.sessionAfter.processedMessageIds,
    steps.map(s => s.messageId),
  );
  assert.equal(domainStore.orders.length, 1);
  const stored = sessionStore.get(last!.sessionKey);
  assert.equal(stored?.step, "ORDER_CREATED");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/agent_conversation_service.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/conversation.service.ts'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/agent/conversation.service.ts`:

```ts
// Agent Conversation Service — camada fina entre um futuro canal (WhatsApp,
// simulador, etc.) e o Conversation Engine. Monta a sessionKey, carrega ou
// cria a sessão pelo Session Store, evita reprocessar mensagens repetidas,
// delega toda a lógica de conversa para handleConversationAction() e
// persiste o resultado — sem conhecer Express, WhatsApp ou linguagem
// natural, e sem acessar o armazenamento interno do Session Store.
import type { AgentSession } from "./session.types.ts";
import { buildAgentSessionKey, type AgentSessionStore } from "./session.store.ts";
import { handleConversationAction } from "./conversation.engine.ts";
import type { AgentConversationAction, AgentConversationResult } from "./conversation.types.ts";
import type { AgentTools } from "./tools.ts";

export class AgentConversationServiceError extends Error {
  code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export type AgentConversationServiceDependencies = {
  sessionStore: AgentSessionStore;
  tools: AgentTools;
  now?: () => Date;
  generateOrderIdempotencyKey?: () => string;
};

export type ProcessActionInput = {
  channel: string;
  contactId: string;
  messageId?: string;
  action: AgentConversationAction;
};

export type AgentConversationServiceResult = {
  sessionKey: string;
  sessionBefore: AgentSession;
  result: AgentConversationResult;
  sessionAfter: AgentSession;
  duplicateMessage: boolean;
};

export type AgentConversationService = {
  processAction(input: ProcessActionInput): AgentConversationServiceResult;
};

function validateMessageId(messageId: string | undefined): void {
  if (messageId === undefined) return;
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw new AgentConversationServiceError(
      "invalid_message_id",
      "messageId deve ser uma string não vazia quando informado.",
    );
  }
}

export function createAgentConversationService(
  deps: AgentConversationServiceDependencies,
): AgentConversationService {
  if (!deps || !deps.sessionStore || !deps.tools) {
    throw new AgentConversationServiceError(
      "missing_dependencies",
      "sessionStore e tools são obrigatórios para criar o Agent Conversation Service.",
    );
  }
  const { sessionStore, tools, now, generateOrderIdempotencyKey } = deps;

  return {
    processAction(input: ProcessActionInput): AgentConversationServiceResult {
      const { channel, contactId, messageId, action } = input;
      validateMessageId(messageId);

      const sessionKey = buildAgentSessionKey(channel, contactId);
      const sessionBefore: AgentSession = structuredClone(sessionStore.getOrCreate({ channel, contactId }));

      if (messageId && sessionStore.hasProcessedMessage(sessionKey, messageId)) {
        const duplicateResult: AgentConversationResult = {
          session: structuredClone(sessionBefore),
          previousStep: sessionBefore.step,
          currentStep: sessionBefore.step,
          event: "MESSAGE_ALREADY_PROCESSED",
          messageKey: "MESSAGE_ALREADY_PROCESSED",
          data: { messageId },
        };
        return {
          sessionKey,
          sessionBefore: structuredClone(sessionBefore),
          result: duplicateResult,
          sessionAfter: structuredClone(sessionBefore),
          duplicateMessage: true,
        };
      }

      // Nenhum try/catch aqui de propósito: se o engine ou a persistência
      // lançarem, a execução para antes de markMessageProcessed — a mensagem
      // nunca é marcada como processada em caso de falha técnica.
      const engineResult = handleConversationAction({
        session: sessionBefore,
        action,
        tools,
        now,
        generateOrderIdempotencyKey,
      });

      let persisted: AgentSession = sessionStore.update(sessionKey, () => engineResult.session);

      if (messageId) {
        sessionStore.markMessageProcessed(sessionKey, messageId);
        persisted = sessionStore.get(sessionKey)!;
      }

      return {
        sessionKey,
        sessionBefore,
        result: { ...engineResult, session: structuredClone(persisted) },
        sessionAfter: structuredClone(persisted),
        duplicateMessage: false,
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/agent_conversation_service.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Type-check**

Run: `npm run lint`
Expected: no TypeScript errors from the new file or its test.

- [ ] **Step 6: Commit**

```bash
git add src/agent/conversation.service.ts tests/agent_conversation_service.test.ts
git commit -m "feat: add Agent Conversation Service coordinating session store and engine"
```

---

## Task 2: Local Simulator

**Files:**
- Create: `src/agent/simulator.ts`
- Test: `tests/agent_simulator.test.ts`

**Interfaces:**
- Consumes: `createAgentConversationService`, `AgentConversationServiceResult` from `src/agent/conversation.service.ts` (Task 1); `InMemoryAgentSessionStore` from `src/agent/session.store.ts`; `createAgentTools`, `type AgentDomainStore` from `src/agent/tools.ts`; `resolveStorePath`, `loadStoreFile`, `saveStoreFile` from `src/lib/store.ts`.
- Produces (exported for the pure-logic tests in Step 1, importable without triggering the stdin loop):
  ```ts
  export const KNOWN_ACTION_TYPES: ReadonlySet<string>;
  export type SimulatorErrorResponse = { ok: false; error: { code: string; message: string } };
  export type ParsedSimulatorLine =
    | { kind: "action"; channel: string; contactId: string; messageId?: string; action: { type: string; [key: string]: unknown } }
    | { kind: "command"; command: "GET_SESSION"; channel: string; contactId: string };
  export function parseSimulatorLine(raw: string): { ok: true; value: ParsedSimulatorLine } | SimulatorErrorResponse;
  export function buildSeedDomainStore(): AgentDomainStore;
  ```
  The main stdin/stdout loop runs only when the file is executed directly (`node src/agent/simulator.ts`), guarded so importing the module for unit tests has no side effects (no stdin reading, no file I/O).

- [ ] **Step 1: Write the failing test file**

Create `tests/agent_simulator.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_ACTION_TYPES,
  parseSimulatorLine,
  buildSeedDomainStore,
} from "../src/agent/simulator.ts";

// --- validação pura (sem processo filho) -----------------------------------

test("KNOWN_ACTION_TYPES inclui as ações estruturadas do Conversation Engine", () => {
  for (const type of [
    "START_CONVERSATION", "SHOW_MENU", "ADD_ITEM", "FINISH_CART", "SET_CUSTOMER_NAME",
    "SET_CUSTOMER_PHONE", "SET_FULFILLMENT", "SET_PICKUP_TIME", "SKIP_CUSTOMER_NOTES",
    "SET_PAYMENT_METHOD", "REVIEW_ORDER", "CONFIRM_ORDER", "GO_BACK", "CANCEL_CONVERSATION",
    "REQUEST_HUMAN", "RESET_CONVERSATION",
  ]) {
    assert.ok(KNOWN_ACTION_TYPES.has(type), `esperava ${type} em KNOWN_ACTION_TYPES`);
  }
});

test("parseSimulatorLine aceita uma linha de ação válida", () => {
  const parsed = parseSimulatorLine(
    JSON.stringify({ channel: "simulator", contactId: "cliente-001", messageId: "msg-001", action: { type: "START_CONVERSATION" } }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.kind, "action");
});

test("parseSimulatorLine rejeita JSON inválido", () => {
  const parsed = parseSimulatorLine("{ isto não é json");
  assert.equal(parsed.ok, false);
  assert.equal(!parsed.ok && parsed.error.code, "INVALID_SIMULATOR_INPUT");
});

test("parseSimulatorLine rejeita ausência de channel", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ contactId: "c1", action: { type: "START_CONVERSATION" } }));
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine rejeita ausência de contactId", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ channel: "simulator", action: { type: "START_CONVERSATION" } }));
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine rejeita ausência de action", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ channel: "simulator", contactId: "c1" }));
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine rejeita action sem type", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ channel: "simulator", contactId: "c1", action: {} }));
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine rejeita tipo de ação desconhecido", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ channel: "simulator", contactId: "c1", action: { type: "FAZER_MAGICA" } }));
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine rejeita messageId que não seja string", () => {
  const parsed = parseSimulatorLine(
    JSON.stringify({ channel: "simulator", contactId: "c1", messageId: 123, action: { type: "START_CONVERSATION" } }),
  );
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine aceita comando GET_SESSION", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ command: "GET_SESSION", channel: "simulator", contactId: "c1" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.kind, "command");
});

test("buildSeedDomainStore produz uma loja com ao menos um produto ativo e disponível", () => {
  const seed = buildSeedDomainStore();
  assert.ok(seed.products.some(p => p.isActive && p.isAvailable));
  assert.equal(Array.isArray(seed.orders), true);
  assert.equal(seed.orders.length, 0);
});

// --- execução real do processo (stdin/stdout) -------------------------------

async function withTempStore(run: (storePath: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-agent-sim-"));
  const storePath = path.join(dir, "store.json");
  try {
    await run(storePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

type SimulatorHandle = {
  sendLine(line: unknown): void;
  nextOutput(): Promise<unknown>;
  close(): Promise<number | null>;
};

function startSimulator(storePath: string): SimulatorHandle {
  const child = spawn("node", ["--experimental-strip-types", "src/agent/simulator.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, BF_STORE_PATH: storePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pendingLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else pendingLines.push(line);
    }
  });
  return {
    sendLine(line: unknown) {
      child.stdin.write(JSON.stringify(line) + "\n");
    },
    nextOutput(): Promise<unknown> {
      return new Promise(resolve => {
        const deliver = (line: string) => resolve(JSON.parse(line));
        const pending = pendingLines.shift();
        if (pending) deliver(pending);
        else waiters.push(deliver);
      });
    },
    close(): Promise<number | null> {
      return new Promise(resolve => {
        child.on("close", code => resolve(code));
        child.stdin.end();
      });
    },
  };
}

test("processa uma linha JSON válida e produz uma linha JSON de saída", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-001", messageId: "msg-001", action: { type: "START_CONVERSATION" } });
    const output = (await sim.nextOutput()) as { sessionKey: string; duplicateMessage: boolean; result: { event: string } };
    assert.equal(output.duplicateMessage, false);
    assert.equal(output.result.event, "WELCOME");
    await sim.close();
  });
});

test("mantém a mesma sessão entre duas linhas processadas em sequência", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-002", messageId: "msg-001", action: { type: "START_CONVERSATION" } });
    const first = (await sim.nextOutput()) as { sessionKey: string };
    sim.sendLine({ channel: "simulator", contactId: "cliente-002", messageId: "msg-002", action: { type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 1 } });
    const second = (await sim.nextOutput()) as { sessionKey: string; sessionBefore: { step: string } };
    assert.equal(second.sessionKey, first.sessionKey);
    assert.equal(second.sessionBefore.step, "BROWSING_MENU");
    await sim.close();
  });
});

test("uma linha JSON inválida não encerra o processamento das linhas seguintes", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine("isto não é um objeto JSON válido {{{");
    const errorOutput = (await sim.nextOutput()) as { ok: false; error: { code: string } };
    assert.equal(errorOutput.ok, false);
    assert.equal(errorOutput.error.code, "INVALID_SIMULATOR_INPUT");
    sim.sendLine({ channel: "simulator", contactId: "cliente-003", messageId: "msg-001", action: { type: "START_CONVERSATION" } });
    const okOutput = (await sim.nextOutput()) as { result: { event: string } };
    assert.equal(okOutput.result.event, "WELCOME");
    await sim.close();
  });
});

test("ação desconhecida gera erro estruturado", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-004", action: { type: "TELEPORTAR" } });
    const output = (await sim.nextOutput()) as { ok: false; error: { code: string } };
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "INVALID_SIMULATOR_INPUT");
    await sim.close();
  });
});

test("ausência de channel gera erro estruturado", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ contactId: "cliente-005", action: { type: "START_CONVERSATION" } });
    const output = (await sim.nextOutput()) as { ok: false };
    assert.equal(output.ok, false);
    await sim.close();
  });
});

test("EOF encerra o processo de forma limpa", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-006", action: { type: "START_CONVERSATION" } });
    await sim.nextOutput();
    const code = await sim.close();
    assert.equal(code, 0);
  });
});

test("fluxo completo cria pedido pela Tool oficial e persiste somente após ORDER_CREATED", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-fluxo";
    const flow: Array<{ messageId: string; action: Record<string, unknown> }> = [
      { messageId: "f1", action: { type: "START_CONVERSATION" } },
      { messageId: "f2", action: { type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 2 } },
      { messageId: "f3", action: { type: "FINISH_CART" } },
      { messageId: "f4", action: { type: "SET_CUSTOMER_NAME", customerName: "Maria Silva" } },
      { messageId: "f5", action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" } },
      { messageId: "f6", action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" } },
      { messageId: "f7", action: { type: "SKIP_CUSTOMER_NOTES" } },
      { messageId: "f8", action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" } },
      { messageId: "f9", action: { type: "CONFIRM_ORDER" } },
    ];

    let fileExistedBeforeOrder = true;
    try {
      await fs.access(storePath);
    } catch {
      fileExistedBeforeOrder = false;
    }
    assert.equal(fileExistedBeforeOrder, false);

    let last: { result: { event: string } } | undefined;
    for (const step of flow) {
      sim.sendLine({ channel: "simulator", contactId, messageId: step.messageId, action: step.action });
      last = (await sim.nextOutput()) as { result: { event: string } };
    }
    assert.equal(last?.result.event, "ORDER_CREATED");

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(persisted.orders.length, 1);

    // replay técnico: reenviar a última mensagem com o mesmo messageId não cria um segundo pedido
    sim.sendLine({ channel: "simulator", contactId, messageId: "f9", action: { type: "CONFIRM_ORDER" } });
    const replay = (await sim.nextOutput()) as { duplicateMessage: boolean };
    assert.equal(replay.duplicateMessage, true);

    const persistedAfterReplay = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(persistedAfterReplay.orders.length, 1);

    await sim.close();
  });
});

test("comando GET_SESSION devolve a sessão atual usando a API pública do Session Store", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-get", messageId: "g1", action: { type: "START_CONVERSATION" } });
    await sim.nextOutput();
    sim.sendLine({ command: "GET_SESSION", channel: "simulator", contactId: "cliente-get" });
    const output = (await sim.nextOutput()) as { ok: true; session: { step: string } };
    assert.equal(output.ok, true);
    assert.equal(output.session.step, "BROWSING_MENU");
    await sim.close();
  });
});

test("arquivo real de demonstração permanece inalterado durante os testes do simulador", async () => {
  const realDemoPath = path.resolve(import.meta.dirname, "..", "data", "brownies-fortal.demo.json");
  const before = await fs.readFile(realDemoPath, "utf8");
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-real-file-check", action: { type: "START_CONVERSATION" } });
    await sim.nextOutput();
    await sim.close();
  });
  const after = await fs.readFile(realDemoPath, "utf8");
  assert.equal(after, before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/agent_simulator.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/simulator.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/agent/simulator.ts`:

```ts
// Simulador local do agente — lê ações estruturadas (JSON, uma por linha) do
// stdin e escreve o resultado (JSON, uma linha) no stdout. Não sobe servidor
// HTTP, não abre porta, não interpreta linguagem natural e não conhece
// WhatsApp: serve só para inspecionar sessão/ação/resultado durante o
// desenvolvimento local, antes da integração com IA e WhatsApp.
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { resolveStorePath, loadStoreFile, saveStoreFile } from "../lib/store.ts";
import { createAgentTools, type AgentDomainStore } from "./tools.ts";
import { InMemoryAgentSessionStore, buildAgentSessionKey } from "./session.store.ts";
import { createAgentConversationService, type AgentConversationServiceResult } from "./conversation.service.ts";

// Lista pequena e explícita das ações estruturadas aceitas pelo Conversation
// Engine (src/agent/conversation.types.ts). Mantida aqui só para validação
// de forma na borda do simulador — a validação de conteúdo de cada ação
// continua sendo responsabilidade exclusiva do engine.
export const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  "START_CONVERSATION",
  "SHOW_MENU",
  "ADD_ITEM",
  "UPDATE_ITEM_QUANTITY",
  "REMOVE_ITEM",
  "CLEAR_CART",
  "FINISH_CART",
  "SET_CUSTOMER_NAME",
  "SET_CUSTOMER_PHONE",
  "SET_FULFILLMENT",
  "SET_PICKUP_TIME",
  "SET_CUSTOMER_NOTES",
  "SKIP_CUSTOMER_NOTES",
  "SET_PAYMENT_METHOD",
  "REVIEW_ORDER",
  "CONFIRM_ORDER",
  "GO_BACK",
  "CANCEL_CONVERSATION",
  "REQUEST_HUMAN",
  "RESET_CONVERSATION",
]);

export type SimulatorErrorResponse = { ok: false; error: { code: string; message: string } };

export type ParsedSimulatorLine =
  | {
      kind: "action";
      channel: string;
      contactId: string;
      messageId?: string;
      action: { type: string; [key: string]: unknown };
    }
  | { kind: "command"; command: "GET_SESSION"; channel: string; contactId: string };

function invalidInput(message: string): SimulatorErrorResponse {
  return { ok: false, error: { code: "INVALID_SIMULATOR_INPUT", message } };
}

// Validação runtime mínima da forma da linha recebida — o Conversation
// Engine já valida o conteúdo específico de cada ação, então aqui só
// confirmamos a "casca" (channel/contactId/action/type conhecido) que o
// TypeScript não pode garantir vindo de uma linha de texto externa.
export function parseSimulatorLine(raw: string): { ok: true; value: ParsedSimulatorLine } | SimulatorErrorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidInput("Linha não é um JSON válido.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return invalidInput("A linha precisa ser um objeto JSON.");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.command === "string") {
    if (obj.command !== "GET_SESSION") {
      return invalidInput(`Comando desconhecido: ${obj.command}`);
    }
    if (typeof obj.channel !== "string" || obj.channel.trim().length === 0) {
      return invalidInput("channel é obrigatório para GET_SESSION.");
    }
    if (typeof obj.contactId !== "string" || obj.contactId.trim().length === 0) {
      return invalidInput("contactId é obrigatório para GET_SESSION.");
    }
    return { ok: true, value: { kind: "command", command: "GET_SESSION", channel: obj.channel, contactId: obj.contactId } };
  }

  if (typeof obj.channel !== "string" || obj.channel.trim().length === 0) {
    return invalidInput("channel é obrigatório.");
  }
  if (typeof obj.contactId !== "string" || obj.contactId.trim().length === 0) {
    return invalidInput("contactId é obrigatório.");
  }
  if (typeof obj.action !== "object" || obj.action === null) {
    return invalidInput("action é obrigatória.");
  }
  const action = obj.action as Record<string, unknown>;
  if (typeof action.type !== "string" || !KNOWN_ACTION_TYPES.has(action.type)) {
    return invalidInput(`action.type desconhecido ou ausente: ${String(action.type)}`);
  }
  if (obj.messageId !== undefined && typeof obj.messageId !== "string") {
    return invalidInput("messageId, quando informado, deve ser uma string.");
  }

  return {
    ok: true,
    value: {
      kind: "action",
      channel: obj.channel,
      contactId: obj.contactId,
      messageId: obj.messageId as string | undefined,
      action: action as { type: string; [key: string]: unknown },
    },
  };
}

// Semente usada apenas quando BF_STORE_PATH aponta para um arquivo que ainda
// não existe (ex.: primeira execução local, ou um caminho temporário de
// teste). Nunca é usada para sobrescrever dados reais já presentes no
// arquivo — loadStoreFile só chama isto quando a leitura falha.
export function buildSeedDomainStore(): AgentDomainStore {
  return {
    business: {
      name: "Brownieria Fortal (simulador)",
      pickupEnabled: true,
      deliveryEnabled: false,
      deliveryFee: 0,
      pickupSlots: [],
      paymentMethods: ["PIX", "DINHEIRO", "A_COMBINAR"],
      availabilityNotice: "Loja de simulação local.",
    },
    products: [
      {
        id: "brownie-brigadeiro",
        slug: "brigadeiro",
        name: "Brownie de Brigadeiro",
        description: "Brownie artesanal finalizado com brigadeiro cremoso.",
        category: "Brownies",
        basePrice: 5,
        promotionalPrice: null,
        minimumPromotionalQuantity: null,
        isActive: true,
        isAvailable: true,
        displayOrder: 1,
        ingredients: "Chocolate, brigadeiro, farinha, ovos e manteiga",
        allergens: "Contém glúten, leite e ovos",
      },
    ],
    orders: [],
  };
}

async function runSimulator(): Promise<void> {
  const storePath = resolveStorePath();
  const domainStore = await loadStoreFile<AgentDomainStore>(storePath, buildSeedDomainStore);
  const tools = createAgentTools({ store: domainStore });
  const sessionStore = new InMemoryAgentSessionStore();
  const service = createAgentConversationService({ sessionStore, tools });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    const parsed = parseSimulatorLine(line);
    if (!parsed.ok) {
      console.log(JSON.stringify(parsed));
      continue;
    }

    try {
      if (parsed.value.kind === "command") {
        const sessionKey = buildAgentSessionKey(parsed.value.channel, parsed.value.contactId);
        const session = sessionStore.get(sessionKey) ?? null;
        console.log(JSON.stringify({ ok: true, session }));
        continue;
      }

      const { channel, contactId, messageId, action } = parsed.value;
      const serviceResult: AgentConversationServiceResult = service.processAction({
        channel,
        contactId,
        messageId,
        action: action as never,
      });

      if (!serviceResult.duplicateMessage && serviceResult.result.event === "ORDER_CREATED") {
        await saveStoreFile(storePath, domainStore);
      }

      console.log(JSON.stringify(serviceResult));
    } catch (error) {
      console.error(error);
      console.log(
        JSON.stringify({
          ok: false,
          error: { code: "SIMULATOR_TECHNICAL_ERROR", message: error instanceof Error ? error.message : "Erro técnico inesperado." },
        }),
      );
    }
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runSimulator().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/agent_simulator.test.ts`
Expected: PASS — all tests green. (This spawns real child processes; allow extra time.)

- [ ] **Step 5: Type-check**

Run: `npm run lint`
Expected: no TypeScript errors.

- [ ] **Step 6: Manual smoke check with a temp store**

Run:
```bash
mkdir -p /tmp/bf-agent-sim-demo
export BF_STORE_PATH=/tmp/bf-agent-sim-demo/store.json
printf '%s\n' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m1","action":{"type":"START_CONVERSATION"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m2","action":{"type":"ADD_ITEM","productId":"brownie-brigadeiro","quantity":2}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m3","action":{"type":"FINISH_CART"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m4","action":{"type":"SET_CUSTOMER_NAME","customerName":"Maria Silva"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m5","action":{"type":"SET_CUSTOMER_PHONE","customerPhone":"85999998888"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m6","action":{"type":"SET_FULFILLMENT","fulfillmentType":"RETIRADA"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m7","action":{"type":"SKIP_CUSTOMER_NOTES"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m8","action":{"type":"SET_PAYMENT_METHOD","paymentMethod":"PIX"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m9","action":{"type":"CONFIRM_ORDER"}}' \
  '{"channel":"simulator","contactId":"cliente-demo","messageId":"m9","action":{"type":"CONFIRM_ORDER"}}' \
  | node --experimental-strip-types src/agent/simulator.ts
cat /tmp/bf-agent-sim-demo/store.json | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('orders:', s.orders.length);"
unset BF_STORE_PATH
rm -rf /tmp/bf-agent-sim-demo
```
Expected: 9 JSON output lines then a 10th with `"duplicateMessage": true`; final printed step is `ORDER_CREATED`; `orders: 1` (not 2) after the replayed `CONFIRM_ORDER`.

- [ ] **Step 7: Commit**

```bash
git add src/agent/simulator.ts tests/agent_simulator.test.ts
git commit -m "feat: add local stdin/stdout simulator for the Agent Conversation Service"
```

---

## Task 3: Wire up npm script, README section, and final validation

**Files:**
- Modify: `package.json` (add one script, no dependency changes)
- Modify: `README.md` (append one short section, no other edits)

**Interfaces:**
- Consumes: `src/agent/simulator.ts` (Task 2) as the script's entry point.
- Produces: `npm run agent:simulate` for local, manual use.

- [ ] **Step 1: Add the npm script**

In `package.json`, inside `"scripts"`, add (keep every existing script unchanged):

```json
    "agent:simulate": "node --experimental-strip-types src/agent/simulator.ts",
```

Place it after `"test:nim"` so the scripts block reads:
```json
  "scripts": {
    "dev": "tsx server.ts",
    "build": "vite build --configLoader runner",
    "preview": "vite preview",
    "clean": "rm -rf dist",
    "lint": "tsc --noEmit",
    "test": "node --experimental-strip-types --test tests/**/*.test.ts",
    "test:nim": "node scripts/test-nvidia-nim.mjs",
    "agent:simulate": "node --experimental-strip-types src/agent/simulator.ts"
  },
```

- [ ] **Step 2: Verify the script runs**

Run: `BF_STORE_PATH=/tmp/bf-agent-sim-script-check.json bash -c 'echo "{\"channel\":\"simulator\",\"contactId\":\"c1\",\"action\":{\"type\":\"START_CONVERSATION\"}}" | npm run --silent agent:simulate'`
Expected: one JSON line on stdout with `"event":"WELCOME"`. Then `rm -f /tmp/bf-agent-sim-script-check.json`.

- [ ] **Step 3: Add the README section**

Read `README.md` first to find a natural insertion point (e.g. near existing "how to run tests" or "development" content), then append a short section such as:

```markdown
## Simulador local do agente

Executa ações estruturadas do Conversation Engine pelo terminal, sem IA e sem WhatsApp — só para desenvolvimento local. Lê uma ação JSON por linha do stdin e imprime o resultado (sessão antes/depois, resultado do engine) em JSON por linha no stdout.

```bash
BF_STORE_PATH=/tmp/brownies-sim.json npm run agent:simulate
```

Exemplo de entrada (uma linha):

```json
{"channel": "simulator", "contactId": "cliente-001", "messageId": "msg-001", "action": {"type": "START_CONVERSATION"}}
```

Defina sempre `BF_STORE_PATH` para um arquivo temporário ao experimentar — sem essa variável, o simulador usa o mesmo arquivo de dados que o servidor real (`data/brownies-fortal.demo.json`).
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/agent_conversation_service.test.ts` and `tests/agent_simulator.test.ts`, and every pre-existing test file unaffected.

- [ ] **Step 5: Run lint and build**

Run: `npm run lint && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 6: Confirm no real data was touched**

Run: `git status --porcelain data/ src/lib/orders.ts src/agent/tools.ts src/agent/conversation.engine.ts server.ts`
Expected: empty output (no changes to any of these paths).

- [ ] **Step 7: Commit**

```bash
git add package.json README.md
git commit -m "chore: add agent:simulate script and local simulator README section"
```

---

## Self-Review Notes (for the implementer to re-check before declaring done)

- Every spec requirement under "TESTES DO CONVERSATION SERVICE" (1–20) and "TESTES DO SIMULADOR" (1–16) has a corresponding test above; the two dedicated scenarios ("TESTE DE FLUXO COMPLETO PELO SERVICE" and "TESTE DE DUPLICAÇÃO DE MENSAGEM DE CONFIRMAÇÃO") are covered by the full-flow test in Task 1 and the `CONFIRM_ORDER` replay tests in Task 1 and Task 2.
- `conversation.engine.ts` is not modified by this plan — the frozen contract above matches what Task 1's service code calls.
- `tools.ts`, `orders.ts`, `server.ts`, and the real demo JSON file are never imported, modified, or written by anything in this plan.
- The service and simulator are fully synchronous/async-only where the underlying store already is — `AgentSessionStore` and `handleConversationAction` are synchronous; only `loadStoreFile`/`saveStoreFile` (file I/O) are async, matching `src/lib/store.ts`'s existing signatures.
