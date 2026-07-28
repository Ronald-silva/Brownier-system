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
