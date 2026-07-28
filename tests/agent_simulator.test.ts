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

test("parseSimulatorLine aceita uma linha de entrada textual", () => {
  const parsed = parseSimulatorLine(
    JSON.stringify({ channel: "simulator", contactId: "cliente-001", messageId: "msg-001", text: "oi" }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.kind, "text");
  assert.equal(parsed.ok && parsed.value.kind === "text" && parsed.value.text, "oi");
});

test("parseSimulatorLine rejeita text vazio", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ channel: "simulator", contactId: "c1", text: "   " }));
  assert.equal(parsed.ok, false);
});

test("parseSimulatorLine ainda exige action ou text quando nenhum dos dois é informado", () => {
  const parsed = parseSimulatorLine(JSON.stringify({ channel: "simulator", contactId: "c1" }));
  assert.equal(parsed.ok, false);
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

function startSimulator(storePath: string, extraEnv: Record<string, string> = {}): SimulatorHandle {
  const child = spawn("node", ["--experimental-strip-types", "src/agent/simulator.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, BF_STORE_PATH: storePath, ...extraEnv },
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

    let last: { result: { event: string } } | undefined;
    for (const step of flow) {
      sim.sendLine({ channel: "simulator", contactId, messageId: step.messageId, action: step.action });
      last = (await sim.nextOutput()) as { result: { event: string } };
      if (step.messageId === "f1") {
        const afterFirstAction = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
        assert.equal(afterFirstAction.orders.length, 0);
      }
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
  const before = await fs.readFile(realDemoPath, "utf8").catch(() => null);
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-real-file-check", action: { type: "START_CONVERSATION" } });
    await sim.nextOutput();
    await sim.close();
  });
  const after = await fs.readFile(realDemoPath, "utf8").catch(() => null);
  assert.equal(after, before);
});

// --- Presentation Builder + Renderer integrados no simulador ----------------

test("saída do simulador inclui messages humanizadas com dados públicos resolvidos", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-presentation";
    const flow: Array<{ messageId: string; action: Record<string, unknown> }> = [
      { messageId: "p1", action: { type: "START_CONVERSATION" } },
      { messageId: "p2", action: { type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 2 } },
      { messageId: "p3", action: { type: "FINISH_CART" } },
      { messageId: "p4", action: { type: "SET_CUSTOMER_NAME", customerName: "Maria" } },
      { messageId: "p5", action: { type: "SET_CUSTOMER_PHONE", customerPhone: "85999998888" } },
      { messageId: "p6", action: { type: "SET_FULFILLMENT", fulfillmentType: "RETIRADA" } },
      { messageId: "p7", action: { type: "SKIP_CUSTOMER_NOTES" } },
      { messageId: "p8", action: { type: "SET_PAYMENT_METHOD", paymentMethod: "PIX" } },
      { messageId: "p9", action: { type: "REVIEW_ORDER" } },
      { messageId: "p10", action: { type: "CONFIRM_ORDER" } },
    ];

    const outputs: Array<{ result: { event: string }; messages: Array<{ type: string; text: string }> }> = [];
    for (const step of flow) {
      sim.sendLine({ channel: "simulator", contactId, messageId: step.messageId, action: step.action });
      outputs.push(
        (await sim.nextOutput()) as { result: { event: string }; messages: Array<{ type: string; text: string }> },
      );
    }

    const byEvent = (event: string) => outputs.find(o => o.result.event === event)!;

    // WELCOME possui nome do negócio semeado pelo simulador.
    assert.match(byEvent("WELCOME").messages[0].text, /Brownieria Fortal \(simulador\)/);

    // ITEM_ADDED resolve o nome do brownie pelo productId.
    assert.match(byEvent("ITEM_ADDED").messages[0].text, /Brownie de Brigadeiro/);

    // ASK_PAYMENT_METHOD lista as opções atuais do Business semeado.
    assert.match(byEvent("ASK_PAYMENT_METHOD").messages[0].text, /• PIX/);

    // ORDER_REVIEW inclui produto, quantidade, nome e forma de pagamento.
    const reviewText = byEvent("ORDER_REVIEW").messages[0].text;
    assert.match(reviewText, /2x Brownie de Brigadeiro/);
    assert.match(reviewText, /Maria/);
    assert.match(reviewText, /PIX/);

    // ORDER_CREATED expõe o código público, nunca IDs internos.
    const createdOutput = byEvent("ORDER_CREATED");
    assert.match(createdOutput.messages[0].text, /Código:/);
    assert.doesNotMatch(createdOutput.messages[0].text, /undefined/);

    for (const output of outputs) {
      assert.ok(Array.isArray(output.messages));
      for (const message of output.messages) {
        assert.doesNotMatch(message.text, /undefined/);
      }
    }

    await sim.close();
  });
});

test("saída do simulador não inclui presentationContext por padrão", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-sem-debug", messageId: "d1", action: { type: "START_CONVERSATION" } });
    const output = (await sim.nextOutput()) as Record<string, unknown>;
    assert.equal("presentationContext" in output, false);
    await sim.close();
  });
});

test("saída do simulador inclui presentationContext quando BF_SIMULATOR_DEBUG_CONTEXT está habilitado", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_SIMULATOR_DEBUG_CONTEXT: "1" });
    sim.sendLine({ channel: "simulator", contactId: "cliente-com-debug", messageId: "d1", action: { type: "START_CONVERSATION" } });
    const output = (await sim.nextOutput()) as { presentationContext?: { business?: { name?: string } } };
    assert.ok(output.presentationContext);
    assert.equal(output.presentationContext?.business?.name, "Brownieria Fortal (simulador)");
    await sim.close();
  });
});

test("MESSAGE_ALREADY_PROCESSED no simulador continua devolvendo messages vazio", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-duplicado";
    sim.sendLine({ channel: "simulator", contactId, messageId: "dup1", action: { type: "START_CONVERSATION" } });
    await sim.nextOutput();
    sim.sendLine({ channel: "simulator", contactId, messageId: "dup1", action: { type: "START_CONVERSATION" } });
    const replay = (await sim.nextOutput()) as { duplicateMessage: boolean; messages: unknown[] };
    assert.equal(replay.duplicateMessage, true);
    assert.deepEqual(replay.messages, []);
    await sim.close();
  });
});

// --- Modo textual (Deterministic Message Interpreter) -----------------------

type TextFlowStep = { messageId: string; text: string };
type TextOutput = Record<string, unknown>;

async function writeCustomStore(storePath: string, store: unknown): Promise<void> {
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
}

function seedStoreWithPickupSlots() {
  const seed = buildSeedDomainStore();
  seed.business.pickupSlots = ["18:00", "19:00", "20:00"];
  return seed;
}

function seedStoreWithAmbiguousProducts() {
  const seed = buildSeedDomainStore();
  const base = seed.products[0]!;
  seed.products = [
    { ...base, id: "brownie-a", slug: "brownie-a", name: "Brownie" },
    { ...base, id: "brownie-b", slug: "brownie-b", name: "Brownie" },
  ];
  return seed;
}

async function sendTextFlow(sim: SimulatorHandle, contactId: string, flow: TextFlowStep[]): Promise<TextOutput[]> {
  const outputs: TextOutput[] = [];
  for (const step of flow) {
    sim.sendLine({ channel: "simulator", contactId, messageId: step.messageId, text: step.text });
    outputs.push((await sim.nextOutput()) as TextOutput);
  }
  return outputs;
}

// Fluxo completo até (mas sem) a confirmação — reaproveitado por vários
// testes abaixo. Depende de um store com pelo menos um horário de retirada
// (seedStoreWithPickupSlots), senão o Engine pula direto para observações.
const FULL_TEXT_FLOW_UNTIL_CONFIRMATION: TextFlowStep[] = [
  { messageId: "t1", text: "oi" },
  { messageId: "t2", text: "1" },
  { messageId: "t3", text: "finalizar" },
  { messageId: "t4", text: "Maria Silva" },
  { messageId: "t5", text: "85999998888" },
  { messageId: "t6", text: "retirada" },
  { messageId: "t7", text: "19:00" },
  { messageId: "t8", text: "sem observação" },
  { messageId: "t9", text: "pix" },
];

test("modo textual: entrada com text é aceita e 'oi' inicia a conversa", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    sim.sendLine({ channel: "simulator", contactId: "cliente-texto-oi", messageId: "tx1", text: "oi" });
    const output = (await sim.nextOutput()) as { result: { event: string }; interpretation: { deterministic: { status: string } } };
    assert.equal(output.interpretation.deterministic.status, "MATCHED");
    assert.equal(output.result.event, "WELCOME");
    await sim.close();
  });
});

test("modo textual: 'menu' mostra o cardápio", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-menu";
    await sendTextFlow(sim, contactId, [{ messageId: "tm1", text: "oi" }]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tm2", text: "menu" }]);
    assert.equal((output as { result: { event: string } }).result.event, "MENU_READY");
    await sim.close();
  });
});

test("modo textual: seleção numérica adiciona produto ao carrinho", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-produto";
    await sendTextFlow(sim, contactId, [{ messageId: "tp1", text: "oi" }]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tp2", text: "1" }]);
    const result = output as { result: { event: string }; sessionAfter: { step: string; items: Array<{ productId: string; quantity: number }> } };
    assert.equal(result.result.event, "ITEM_ADDED");
    assert.equal(result.sessionAfter.step, "BUILDING_ORDER");
    assert.deepEqual(result.sessionAfter.items, [{ productId: "brownie-brigadeiro", quantity: 1 }]);
    await sim.close();
  });
});

test("modo textual: nome é coletado", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-nome";
    await sendTextFlow(sim, contactId, [
      { messageId: "tn1", text: "oi" },
      { messageId: "tn2", text: "1" },
      { messageId: "tn3", text: "finalizar" },
    ]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tn4", text: "Maria Silva" }]);
    const result = output as { sessionAfter: { customerName?: string; step: string } };
    assert.equal(result.sessionAfter.customerName, "Maria Silva");
    assert.equal(result.sessionAfter.step, "COLLECTING_FULFILLMENT");
    await sim.close();
  });
});

test("modo textual: telefone é coletado", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-telefone";
    await sendTextFlow(sim, contactId, [
      { messageId: "tt1", text: "oi" },
      { messageId: "tt2", text: "1" },
      { messageId: "tt3", text: "finalizar" },
      { messageId: "tt4", text: "Maria Silva" },
    ]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tt5", text: "85999998888" }]);
    const result = output as { sessionAfter: { customerPhone?: string } };
    assert.equal(result.sessionAfter.customerPhone, "85999998888");
    await sim.close();
  });
});

test("modo textual: retirada é coletada", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-retirada";
    await sendTextFlow(sim, contactId, [
      { messageId: "tf1", text: "oi" },
      { messageId: "tf2", text: "1" },
      { messageId: "tf3", text: "finalizar" },
      { messageId: "tf4", text: "Maria Silva" },
      { messageId: "tf5", text: "85999998888" },
    ]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tf6", text: "retirada" }]);
    const result = output as { sessionAfter: { fulfillmentType?: string } };
    assert.equal(result.sessionAfter.fulfillmentType, "RETIRADA");
    await sim.close();
  });
});

test("modo textual: horário de retirada é coletado", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-horario";
    await sendTextFlow(sim, contactId, [
      { messageId: "th1", text: "oi" },
      { messageId: "th2", text: "1" },
      { messageId: "th3", text: "finalizar" },
      { messageId: "th4", text: "Maria Silva" },
      { messageId: "th5", text: "85999998888" },
      { messageId: "th6", text: "retirada" },
    ]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "th7", text: "19:00" }]);
    const result = output as { sessionAfter: { pickupTime?: string } };
    assert.equal(result.sessionAfter.pickupTime, "19:00");
    await sim.close();
  });
});

test("modo textual: observação pode ser pulada", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-nota";
    await sendTextFlow(sim, contactId, [
      { messageId: "tno1", text: "oi" },
      { messageId: "tno2", text: "1" },
      { messageId: "tno3", text: "finalizar" },
      { messageId: "tno4", text: "Maria Silva" },
      { messageId: "tno5", text: "85999998888" },
      { messageId: "tno6", text: "retirada" },
      { messageId: "tno7", text: "19:00" },
    ]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tno8", text: "sem observação" }]);
    const result = output as { result: { event: string }; sessionAfter: { customerNotes?: string } };
    assert.equal(result.result.event, "ASK_PAYMENT_METHOD");
    assert.equal(result.sessionAfter.customerNotes, undefined);
    await sim.close();
  });
});

test("modo textual: forma de pagamento é coletada", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-pagamento";
    await sendTextFlow(
      sim,
      contactId,
      FULL_TEXT_FLOW_UNTIL_CONFIRMATION.slice(0, -1), // até 'sem observação'
    );
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tpg1", text: "pix" }]);
    const result = output as { sessionAfter: { paymentMethod?: string; step: string } };
    assert.equal(result.sessionAfter.paymentMethod, "PIX");
    assert.equal(result.sessionAfter.step, "AWAITING_CONFIRMATION");
    await sim.close();
  });
});

test("modo textual: confirmação cria o pedido", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-confirmar";
    await sendTextFlow(sim, contactId, FULL_TEXT_FLOW_UNTIL_CONFIRMATION);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tcf1", text: "confirmar" }]);
    const result = output as { result: { event: string }; sessionAfter: { createdOrderPublicCode?: string } };
    assert.equal(result.result.event, "ORDER_CREATED");
    assert.ok(result.sessionAfter.createdOrderPublicCode);
    await sim.close();
  });
});

test("fluxo textual completo chega a ORDER_CREATED com mensagens em todas as etapas", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-fluxo-completo";
    const outputs = await sendTextFlow(sim, contactId, [
      ...FULL_TEXT_FLOW_UNTIL_CONFIRMATION,
      { messageId: "t10", text: "confirmar" },
    ]);
    for (const output of outputs) {
      assert.ok(Array.isArray((output as { messages?: unknown[] }).messages));
      assert.ok(((output as { messages: unknown[] }).messages.length) > 0);
    }
    const last = outputs[outputs.length - 1] as { result: { event: string } };
    assert.equal(last.result.event, "ORDER_CREATED");
    await sim.close();
  });
});

test("modo textual: mensagem não compreendida não chama o Engine, mas incrementa misunderstandingCount", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-nao-compreendido";
    await sendTextFlow(sim, contactId, [{ messageId: "tu1", text: "oi" }]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "tu2", text: "blablabla sem sentido nenhum" }]);
    const result = output as {
      interpretation?: { deterministic: { status: string } };
      result?: unknown;
      sessionAfter?: { step: string; misunderstandingCount: number };
      policy?: { misunderstandingCountAfter: number; handoffTriggered: boolean };
    };
    assert.equal(result.interpretation?.deterministic.status, "NOT_UNDERSTOOD");
    assert.equal(result.result, undefined);
    assert.equal(result.sessionAfter?.step, "BROWSING_MENU");
    assert.equal(result.sessionAfter?.misunderstandingCount, 1);
    assert.equal(result.policy?.misunderstandingCountAfter, 1);
    assert.equal(result.policy?.handoffTriggered, false);

    sim.sendLine({ command: "GET_SESSION", channel: "simulator", contactId });
    const session = (await sim.nextOutput()) as { session: { step: string; misunderstandingCount: number } };
    assert.equal(session.session.step, "BROWSING_MENU");
    assert.equal(session.session.misunderstandingCount, 1);
    await sim.close();
  });
});

test("modo textual: mensagem ambígua não altera o carrinho, mas incrementa misunderstandingCount", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithAmbiguousProducts());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-ambiguo";
    await sendTextFlow(sim, contactId, [{ messageId: "ta1", text: "oi" }]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "ta2", text: "brownie" }]);
    const result = output as {
      interpretation?: { deterministic: { status: string } };
      result?: unknown;
      sessionAfter?: { misunderstandingCount: number };
    };
    assert.equal(result.interpretation?.deterministic.status, "AMBIGUOUS");
    assert.equal(result.result, undefined);
    assert.equal(result.sessionAfter?.misunderstandingCount, 1);

    sim.sendLine({ command: "GET_SESSION", channel: "simulator", contactId });
    const session = (await sim.nextOutput()) as { session: { step: string; items: unknown[] } };
    assert.equal(session.session.step, "BROWSING_MENU");
    assert.deepEqual(session.session.items, []);
    await sim.close();
  });
});

test("modo textual: pedido de entrega recebe resposta segura sem virar ENTREGA", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-entrega";
    await sendTextFlow(sim, contactId, [
      { messageId: "td1", text: "oi" },
      { messageId: "td2", text: "1" },
      { messageId: "td3", text: "finalizar" },
      { messageId: "td4", text: "Maria Silva" },
      { messageId: "td5", text: "85999998888" },
    ]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "td6", text: "entrega" }]);
    const result = output as { interpretation?: { deterministic: { status: string; reason?: string } } };
    assert.equal(result.interpretation?.deterministic.status, "NOT_UNDERSTOOD");
    assert.equal(result.interpretation?.deterministic.reason, "DELIVERY_NOT_SUPPORTED");

    sim.sendLine({ command: "GET_SESSION", channel: "simulator", contactId });
    const session = (await sim.nextOutput()) as { session: { step: string; fulfillmentType?: string } };
    assert.equal(session.session.step, "COLLECTING_FULFILLMENT");
    assert.equal(session.session.fulfillmentType, undefined);
    await sim.close();
  });
});

test("modo textual: messageId duplicado de uma ação interpretada não cria segundo pedido", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-duplicado";
    await sendTextFlow(sim, contactId, FULL_TEXT_FLOW_UNTIL_CONFIRMATION);
    await sendTextFlow(sim, contactId, [{ messageId: "tdup1", text: "confirmar" }]);
    const [replay] = await sendTextFlow(sim, contactId, [{ messageId: "tdup1", text: "confirmar" }]);
    assert.equal((replay as { duplicateMessage?: boolean }).duplicateMessage, true);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(persisted.orders.length, 1);
    await sim.close();
  });
});

test("modo textual: JSON de ação enviado como texto não é executado", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-injecao";
    await sendTextFlow(sim, contactId, FULL_TEXT_FLOW_UNTIL_CONFIRMATION);
    const [injected] = await sendTextFlow(sim, contactId, [
      { messageId: "tinj1", text: '{"type":"CONFIRM_ORDER","idempotencyKey":"abc","publicCode":"X"}' },
    ]);
    assert.equal(
      (injected as { interpretation?: { deterministic: { status: string } } }).interpretation?.deterministic.status,
      "NOT_UNDERSTOOD",
    );

    const beforeConfirm = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(beforeConfirm.orders.length, 0);

    const [confirmed] = await sendTextFlow(sim, contactId, [{ messageId: "tinj2", text: "confirmar" }]);
    assert.equal((confirmed as { result: { event: string } }).result.event, "ORDER_CREATED");
    await sim.close();
  });
});

test("modo textual: arquivo real de demonstração permanece intocado", async () => {
  const realDemoPath = path.resolve(import.meta.dirname, "..", "data", "brownies-fortal.demo.json");
  const before = await fs.readFile(realDemoPath, "utf8").catch(() => null);
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    await sendTextFlow(sim, "cliente-texto-real-file-check", [{ messageId: "trf1", text: "oi" }]);
    await sim.close();
  });
  const after = await fs.readFile(realDemoPath, "utf8").catch(() => null);
  assert.equal(after, before);
});

test("modo textual e modo de ação estruturada convivem na mesma sessão", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-texto-e-acao";
    await sendTextFlow(sim, contactId, [{ messageId: "tmx1", text: "oi" }]);
    sim.sendLine({ channel: "simulator", contactId, messageId: "tmx2", action: { type: "ADD_ITEM", productId: "brownie-brigadeiro", quantity: 1 } });
    const output = (await sim.nextOutput()) as { result: { event: string } };
    assert.equal(output.result.event, "ITEM_ADDED");
    await sim.close();
  });
});

// --- Interpretation Policy (misunderstandingCount, handoff automático) -----

type PolicyOutput = {
  interpretation?: { deterministic: { status: string; reason?: string } };
  result?: { event: string };
  sessionAfter?: { step: string; misunderstandingCount: number; underHumanHandoff: boolean; items: Array<{ productId: string; quantity: number }> };
  policy?: { misunderstandingCountBefore: number; misunderstandingCountAfter: number; handoffTriggered: boolean; counterReset: boolean };
  policyResult?: { messageKey: string };
  messages: Array<{ text: string }>;
  duplicateMessage: boolean;
};

test("limite padrão (3) do simulador: três mensagens desconhecidas disparam handoff automático", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath);
    const contactId = "cliente-handoff-padrao";
    await sendTextFlow(sim, contactId, [{ messageId: "hp1", text: "oi" }]);

    const [first] = await sendTextFlow(sim, contactId, [{ messageId: "hp2", text: "primeira mensagem sem sentido" }]);
    assert.equal((first as PolicyOutput).policy?.misunderstandingCountAfter, 1);
    assert.equal((first as PolicyOutput).policy?.handoffTriggered, false);

    const [second] = await sendTextFlow(sim, contactId, [{ messageId: "hp3", text: "segunda mensagem sem sentido" }]);
    assert.equal((second as PolicyOutput).policy?.misunderstandingCountAfter, 2);
    assert.equal((second as PolicyOutput).policy?.handoffTriggered, false);

    const [third] = await sendTextFlow(sim, contactId, [{ messageId: "hp4", text: "terceira mensagem sem sentido" }]);
    const thirdResult = third as PolicyOutput;
    assert.equal(thirdResult.policy?.misunderstandingCountAfter, 3);
    assert.equal(thirdResult.policy?.handoffTriggered, true);
    assert.equal(thirdResult.sessionAfter?.underHumanHandoff, true);
    assert.equal(thirdResult.sessionAfter?.step, "HUMAN_HANDOFF");
    assert.match(thirdResult.messages[0]?.text, /encaminhar você para uma pessoa/);
    await sim.close();
  });
});

test("BF_AGENT_MAX_MISUNDERSTANDINGS customizado dispara handoff mais cedo", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_AGENT_MAX_MISUNDERSTANDINGS: "1" });
    const contactId = "cliente-handoff-custom";
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "hc1", text: "mensagem sem sentido" }]);
    const result = output as PolicyOutput;
    assert.equal(result.policy?.misunderstandingCountAfter, 1);
    assert.equal(result.policy?.handoffTriggered, true);
    assert.equal(result.sessionAfter?.underHumanHandoff, true);
    await sim.close();
  });
});

test("BF_AGENT_MAX_MISUNDERSTANDINGS inválido impede a inicialização segura do simulador", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_AGENT_MAX_MISUNDERSTANDINGS: "abc" });
    sim.sendLine({ channel: "simulator", contactId: "cliente-config-invalida", messageId: "ci1", text: "oi" });
    const output = (await sim.nextOutput()) as { ok: false; error: { code: string } };
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "invalid_max_misunderstandings");
    const code = await sim.close();
    assert.equal(code, 1);
  });
});

test("handoff automático preserva o carrinho e não cria pedido", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_AGENT_MAX_MISUNDERSTANDINGS: "2" });
    const contactId = "cliente-handoff-carrinho";
    await sendTextFlow(sim, contactId, [
      { messageId: "hcart1", text: "oi" },
      { messageId: "hcart2", text: "1" },
    ]);
    await sendTextFlow(sim, contactId, [{ messageId: "hcart3", text: "mensagem sem sentido" }]);
    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "hcart4", text: "outra mensagem sem sentido" }]);
    const result = output as PolicyOutput;
    assert.equal(result.policy?.handoffTriggered, true);
    assert.deepEqual(result.sessionAfter?.items, [{ productId: "brownie-brigadeiro", quantity: 1 }]);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(persisted.orders.length, 0);
    await sim.close();
  });
});

test("mensagem comum durante handoff ativo devolve HUMAN_HANDOFF_ACTIVE sem chamar o Engine", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_AGENT_MAX_MISUNDERSTANDINGS: "1" });
    const contactId = "cliente-handoff-ativo";
    await sendTextFlow(sim, contactId, [{ messageId: "ha1", text: "mensagem sem sentido" }]);

    const [output] = await sendTextFlow(sim, contactId, [{ messageId: "ha2", text: "oi de novo" }]);
    const result = output as PolicyOutput;
    assert.equal(result.interpretation?.deterministic.reason, "HUMAN_HANDOFF_ACTIVE");
    assert.equal(result.result, undefined);
    assert.equal(result.policy?.misunderstandingCountAfter, 1);
    assert.equal(result.policyResult?.messageKey, "HUMAN_HANDOFF_ACTIVE");
    await sim.close();
  });
});

test("RESET_CONVERSATION sai do handoff e permite um novo fluxo", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_AGENT_MAX_MISUNDERSTANDINGS: "1" });
    const contactId = "cliente-handoff-reset";
    await sendTextFlow(sim, contactId, [{ messageId: "hr1", text: "mensagem sem sentido" }]);

    const [resetOutput] = await sendTextFlow(sim, contactId, [{ messageId: "hr2", text: "recomeçar" }]);
    const reset = resetOutput as PolicyOutput;
    assert.equal(reset.sessionAfter?.underHumanHandoff, false);
    assert.equal(reset.sessionAfter?.step, "START");
    assert.equal(reset.sessionAfter?.misunderstandingCount, 0);

    const [welcomeOutput] = await sendTextFlow(sim, contactId, [{ messageId: "hr3", text: "oi" }]);
    const welcome = welcomeOutput as PolicyOutput;
    assert.equal(welcome.interpretation?.deterministic.status, "MATCHED");
    assert.equal(welcome.result?.event, "WELCOME");
    await sim.close();
  });
});

test("mensagem que dispara handoff no limite: replay com o mesmo messageId não gera segundo handoff", async () => {
  await withTempStore(async storePath => {
    const sim = startSimulator(storePath, { BF_AGENT_MAX_MISUNDERSTANDINGS: "3" });
    const contactId = "cliente-handoff-duplicado";
    await sendTextFlow(sim, contactId, [
      { messageId: "hd1", text: "primeira sem sentido" },
      { messageId: "hd2", text: "segunda sem sentido" },
    ]);
    const [triggerOutput] = await sendTextFlow(sim, contactId, [{ messageId: "hd3", text: "terceira sem sentido" }]);
    const trigger = triggerOutput as PolicyOutput;
    assert.equal(trigger.policy?.handoffTriggered, true);
    assert.equal(trigger.sessionAfter?.misunderstandingCount, 3);

    const [replayOutput] = await sendTextFlow(sim, contactId, [{ messageId: "hd3", text: "terceira sem sentido" }]);
    const replay = replayOutput as PolicyOutput;
    assert.equal(replay.duplicateMessage, true);
    assert.equal(replay.messages.length, 0);

    sim.sendLine({ command: "GET_SESSION", channel: "simulator", contactId });
    const session = (await sim.nextOutput()) as { session: { misunderstandingCount: number; underHumanHandoff: boolean } };
    assert.equal(session.session.misunderstandingCount, 3);
    assert.equal(session.session.underHumanHandoff, true);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(persisted.orders.length, 0);
    await sim.close();
  });
});

test("fluxo de recuperação: uma falha seguida de 'menu' zera o contador e o pedido pode ser criado normalmente", async () => {
  await withTempStore(async storePath => {
    await writeCustomStore(storePath, seedStoreWithPickupSlots());
    const sim = startSimulator(storePath);
    const contactId = "cliente-recuperacao";

    await sendTextFlow(sim, contactId, [{ messageId: "r1", text: "oi" }]);
    const [failure] = await sendTextFlow(sim, contactId, [{ messageId: "r2", text: "mensagem sem sentido" }]);
    assert.equal((failure as PolicyOutput).policy?.misunderstandingCountAfter, 1);

    const [recovered] = await sendTextFlow(sim, contactId, [{ messageId: "r3", text: "menu" }]);
    const recoveredResult = recovered as PolicyOutput;
    assert.equal(recoveredResult.result?.event, "MENU_READY");
    assert.equal(recoveredResult.policy?.counterReset, true);
    assert.equal(recoveredResult.sessionAfter?.misunderstandingCount, 0);

    const rest = await sendTextFlow(sim, contactId, [
      { messageId: "r4", text: "1" },
      { messageId: "r5", text: "finalizar" },
      { messageId: "r6", text: "Maria Silva" },
      { messageId: "r7", text: "85999998888" },
      { messageId: "r8", text: "retirada" },
      { messageId: "r9", text: "19:00" },
      { messageId: "r10", text: "sem observação" },
      { messageId: "r11", text: "pix" },
      { messageId: "r12", text: "confirmar" },
    ]);
    const last = rest[rest.length - 1] as PolicyOutput;
    assert.equal(last.result?.event, "ORDER_CREATED");
    assert.equal(last.sessionAfter?.underHumanHandoff, false);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { orders: unknown[] };
    assert.equal(persisted.orders.length, 1);
    await sim.close();
  });
});
