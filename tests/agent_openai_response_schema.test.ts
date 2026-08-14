import assert from "node:assert/strict";
import test from "node:test";
import { OPENAI_LLM_RESPONSE_SCHEMA } from "../src/agent/providers/openai-response-schema.ts";
import { validateLlmOutput } from "../src/agent/llm-output-validator.ts";
import type { AgentSession, AgentConversationStep } from "../src/agent/session.types.ts";
import type { LlmInterpreterContext } from "../src/agent/llm-interpreter.types.ts";

// Os únicos 20 tipos definidos em AgentConversationAction
// (src/agent/conversation.types.ts) — a mesma lista usada como allowlist em
// llm-output-validator.ts. Hardcoded aqui porque o union type do TypeScript
// não existe em runtime; conversation.types.ts é a fonte da verdade.
const REAL_ACTION_TYPES = [
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
];

// Ações proibidas que nunca podem ser produzidas pelo schema (não existem em
// AgentConversationAction, ou foram removidas do domínio, ex.: entrega).
const FORBIDDEN_ACTION_TYPES = ["CREATE_ORDER", "APPLY_DISCOUNT", "DELIVER_ORDER", "SET_DELIVERY_ADDRESS"];

const FORBIDDEN_FIELDS = [
  "orderId",
  "publicCode",
  "price",
  "unitPrice",
  "subtotal",
  "total",
  "discount",
  "idempotencyKey",
  "fingerprint",
  "processedMessageIds",
  "expiresAt",
  "sessionKey",
  "messageId",
  "tool",
  "function",
  "arguments",
  "deliveryAddress",
];

type JsonSchemaObject = {
  type?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, unknown>;
  oneOf?: JsonSchemaObject[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchemaObject;
  maxItems?: number;
  minItems?: number;
};

const schema = OPENAI_LLM_RESPONSE_SCHEMA as unknown as JsonSchemaObject;

function actionsSchema(): JsonSchemaObject {
  return (schema.properties!["actions"] as JsonSchemaObject)!;
}

function actionOneOf(): JsonSchemaObject[] {
  return actionsSchema().items!.oneOf!;
}

function findAction(type: string): JsonSchemaObject | undefined {
  return actionOneOf().find(entry => {
    const typeProp = entry.properties?.["type"] as { const?: unknown } | undefined;
    return typeProp?.const === type;
  });
}

// --- estrutura principal -----------------------------------------------

test("main schema is an object", () => {
  assert.equal(schema.type, "object");
});

test("main schema has additionalProperties false", () => {
  assert.equal(schema.additionalProperties, false);
});

test("main schema requires status, actions, reason and suggestions", () => {
  assert.deepEqual([...schema.required!].sort(), ["actions", "reason", "status", "suggestions"]);
});

test("status accepts only MATCHED, NOT_UNDERSTOOD and AMBIGUOUS", () => {
  const statusProp = schema.properties!["status"] as { enum?: string[] };
  assert.deepEqual([...statusProp.enum!].sort(), ["AMBIGUOUS", "MATCHED", "NOT_UNDERSTOOD"]);
});

test("actions has maxItems 12", () => {
  assert.equal(actionsSchema().maxItems, 12);
});

test("actions items use oneOf", () => {
  assert.ok(Array.isArray(actionOneOf()));
  assert.ok(actionOneOf().length > 0);
});

test("every real action type is represented in the schema", () => {
  const present = actionOneOf().map(entry => (entry.properties?.["type"] as { const?: unknown })?.const);
  for (const type of REAL_ACTION_TYPES) {
    assert.ok(present.includes(type), `missing action ${type}`);
  }
});

test("no unknown action type is present in the schema", () => {
  const present = actionOneOf().map(entry => (entry.properties?.["type"] as { const?: unknown })?.const);
  for (const type of present) {
    assert.ok(REAL_ACTION_TYPES.includes(type as string), `unexpected action ${String(type)} in schema`);
  }
});

// --- ações individuais ---------------------------------------------------

test("ADD_ITEM requires productId and quantity", () => {
  const action = findAction("ADD_ITEM")!;
  assert.deepEqual([...action.required!].sort(), ["productId", "quantity", "type"]);
  assert.equal(action.additionalProperties, false);
});

test("ADD_ITEM quantity is an integer between 1 and 100", () => {
  const action = findAction("ADD_ITEM")!;
  const quantity = action.properties!["quantity"] as { type?: string; minimum?: number; maximum?: number };
  assert.equal(quantity.type, "integer");
  assert.equal(quantity.minimum, 1);
  assert.equal(quantity.maximum, 100);
});

test("REMOVE_ITEM has the real fields", () => {
  const action = findAction("REMOVE_ITEM")!;
  assert.deepEqual([...action.required!].sort(), ["productId", "type"]);
  assert.equal(action.additionalProperties, false);
});

test("UPDATE_ITEM_QUANTITY has the real fields", () => {
  const action = findAction("UPDATE_ITEM_QUANTITY")!;
  assert.deepEqual([...action.required!].sort(), ["productId", "quantity", "type"]);
  assert.equal(action.additionalProperties, false);
});

test("SET_FULFILLMENT only allows RETIRADA", () => {
  const action = findAction("SET_FULFILLMENT")!;
  const fulfillmentType = action.properties!["fulfillmentType"] as { const?: unknown; enum?: unknown[] };
  if (fulfillmentType.enum) {
    assert.deepEqual(fulfillmentType.enum, ["RETIRADA"]);
  } else {
    assert.equal(fulfillmentType.const, "RETIRADA");
  }
});

test("SET_PICKUP_TIME requires a string", () => {
  const action = findAction("SET_PICKUP_TIME")!;
  const pickupTime = action.properties!["pickupTime"] as { type?: string };
  assert.equal(pickupTime.type, "string");
  assert.ok(action.required!.includes("pickupTime"));
});

test("SET_PAYMENT_METHOD requires a string", () => {
  const action = findAction("SET_PAYMENT_METHOD")!;
  const paymentMethod = action.properties!["paymentMethod"] as { type?: string };
  assert.equal(paymentMethod.type, "string");
  assert.ok(action.required!.includes("paymentMethod"));
});

test("SET_CUSTOMER_NAME requires the real field", () => {
  const action = findAction("SET_CUSTOMER_NAME")!;
  assert.ok(action.required!.includes("customerName"));
  assert.equal(action.additionalProperties, false);
});

test("SET_CUSTOMER_PHONE requires the real field", () => {
  const action = findAction("SET_CUSTOMER_PHONE")!;
  assert.ok(action.required!.includes("customerPhone"));
  assert.equal(action.additionalProperties, false);
});

test("SET_CUSTOMER_NOTES requires the real field", () => {
  const action = findAction("SET_CUSTOMER_NOTES")!;
  assert.ok(action.required!.includes("customerNotes"));
  assert.equal(action.additionalProperties, false);
});

test("CONFIRM_ORDER accepts no extra fields", () => {
  const action = findAction("CONFIRM_ORDER")!;
  assert.deepEqual(action.required, ["type"]);
  assert.deepEqual(Object.keys(action.properties!), ["type"]);
  assert.equal(action.additionalProperties, false);
});

test("REQUEST_HUMAN accepts no extra fields", () => {
  const action = findAction("REQUEST_HUMAN")!;
  assert.deepEqual(action.required, ["type"]);
  assert.deepEqual(Object.keys(action.properties!), ["type"]);
  assert.equal(action.additionalProperties, false);
});

test("RESET_CONVERSATION accepts no extra fields", () => {
  const action = findAction("RESET_CONVERSATION")!;
  assert.deepEqual(action.required, ["type"]);
  assert.deepEqual(Object.keys(action.properties!), ["type"]);
  assert.equal(action.additionalProperties, false);
});

// --- reason / suggestions -------------------------------------------------

test("reason accepts string or null", () => {
  const reason = schema.properties!["reason"] as { type?: string[] };
  assert.deepEqual([...reason.type!].sort(), ["null", "string"]);
});

test("suggestions is a limited array of strings", () => {
  const suggestions = schema.properties!["suggestions"] as JsonSchemaObject;
  assert.equal(suggestions.type, "array");
  assert.equal(suggestions.maxItems, 5);
  const items = suggestions.items as { type?: string; minLength?: number };
  assert.equal(items.type, "string");
  assert.ok((items.minLength ?? 0) >= 1);
});

// --- campos e ações proibidos ---------------------------------------------

test("schema does not contain forbidden fields", () => {
  const serialized = JSON.stringify(schema);
  for (const field of FORBIDDEN_FIELDS) {
    assert.ok(!serialized.includes(`"${field}"`), `forbidden field ${field} found in schema`);
  }
});

test("schema does not contain ENTREGA", () => {
  const serialized = JSON.stringify(schema);
  assert.ok(!serialized.includes("ENTREGA"));
});

test("schema does not contain forbidden action types", () => {
  const serialized = JSON.stringify(schema);
  for (const type of FORBIDDEN_ACTION_TYPES) {
    assert.ok(!serialized.includes(`"${type}"`), `forbidden action ${type} found in schema`);
  }
});

// --- compatibilidade com o validator local --------------------------------

const FIXED_ISO = "2026-01-01T00:00:00.000Z";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionKey: "simulator:c1",
    channel: "simulator",
    contactId: "c1",
    step: "BUILDING_ORDER",
    items: [],
    processedMessageIds: [],
    underHumanHandoff: false,
    misunderstandingCount: 0,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    expiresAt: FIXED_ISO,
    ...overrides,
  };
}

function atStep(step: AgentConversationStep, overrides: Partial<AgentSession> = {}): AgentSession {
  return makeSession({ step, ...overrides });
}

const PRODUCTS_CONTEXT: LlmInterpreterContext = {
  products: [{ id: "p1", name: "Brownie Tradicional" }],
};

test("a MATCHED fixture that matches the schema shape is accepted by the local validator", () => {
  const fixture = {
    status: "MATCHED",
    actions: [{ type: "ADD_ITEM", productId: "p1", quantity: 2 }],
    reason: null,
    suggestions: [],
  };
  const result = validateLlmOutput({ raw: fixture, session: atStep("BUILDING_ORDER"), context: PRODUCTS_CONTEXT });
  assert.equal(result.status, "MATCHED");
});

test("a NOT_UNDERSTOOD fixture that matches the schema shape is accepted by the local validator", () => {
  const fixture = {
    status: "NOT_UNDERSTOOD",
    actions: [],
    reason: "GENERIC",
    suggestions: ["mostrar cardápio"],
  };
  const result = validateLlmOutput({ raw: fixture, session: atStep("START") });
  assert.equal(result.status, "NOT_UNDERSTOOD");
});

test("an AMBIGUOUS fixture that matches the schema shape is accepted by the local validator", () => {
  const fixture = {
    status: "AMBIGUOUS",
    actions: [],
    reason: "MULTIPLE_MATCHES",
    suggestions: [],
  };
  const result = validateLlmOutput({ raw: fixture, session: atStep("START") });
  assert.equal(result.status, "AMBIGUOUS");
});

test("a CONFIRM_ORDER-only fixture is accepted by the local validator", () => {
  const fixture = {
    status: "MATCHED",
    actions: [{ type: "CONFIRM_ORDER" }],
    reason: null,
    suggestions: [],
  };
  const result = validateLlmOutput({ raw: fixture, session: atStep("AWAITING_CONFIRMATION") });
  assert.equal(result.status, "MATCHED");
});

test("a SET_CUSTOMER_NAME fixture is accepted by the local validator", () => {
  const fixture = {
    status: "MATCHED",
    actions: [{ type: "SET_CUSTOMER_NAME", customerName: "Joana" }],
    reason: null,
    suggestions: [],
  };
  const result = validateLlmOutput({ raw: fixture, session: atStep("COLLECTING_NAME") });
  assert.equal(result.status, "MATCHED");
});
