import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REAL_DEMO_PATH = path.join(process.cwd(), "data", "brownies-fortal.demo.json");
const ADMIN_CODE = "brownies-demo";

async function hashIfExists(filePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/public/business`);
      if (res.ok) return;
    } catch {
      // servidor ainda não está de pé — tenta novamente
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Servidor de teste não respondeu a tempo.");
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

test("POST /api/public/orders cria o pedido, persiste no armazenamento temporário e aparece no bootstrap administrativo, sem tocar no arquivo real da demonstração", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-orders-endpoint-test-"));
  const tempStorePath = path.join(tempDir, "store-teste.json");
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let stderrOutput = "";

  try {
    const hashBefore = await hashIfExists(REAL_DEMO_PATH);

    child = spawn(process.execPath, ["--experimental-strip-types", "server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, BF_STORE_PATH: tempStorePath, PORT: String(port), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", chunk => { stderrOutput += chunk.toString(); });

    await waitForServer(baseUrl, 20_000);

    const payload = {
      items: [{ productId: "demo-brigadeiro", quantity: 2 }],
      customerName: "Pedido de teste de integração",
      customerPhone: "85999998888",
      fulfillmentType: "RETIRADA",
      paymentMethod: "PIX",
      pickupTime: "",
      // Valores falsos que o servidor deve ignorar e recalcular:
      subtotal: 1, discount: 999, total: 1,
    };

    const createResponse = await fetch(`${baseUrl}/api/public/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(createResponse.status, 201);
    const order = await createResponse.json();
    assert.equal(order.subtotal, 10);
    assert.equal(order.discount, 0);
    assert.equal(order.deliveryFee, 0);
    assert.equal(order.total, 10);
    assert.equal(order.status, "NOVO");
    assert.ok(typeof order.publicCode === "string" && order.publicCode.startsWith("BF-"));

    // Persistido no arquivo temporário apontado por BF_STORE_PATH.
    const onDisk = JSON.parse(await fs.readFile(tempStorePath, "utf8"));
    const persistedOrder = onDisk.orders.find((o: { id: string }) => o.id === order.id);
    assert.ok(persistedOrder, "pedido deveria estar persistido no armazenamento temporário");
    assert.equal(persistedOrder.total, 10);

    // Aparece no bootstrap administrativo (o que alimenta o painel /equipe).
    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: ADMIN_CODE }),
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();

    const bootstrapResponse = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(bootstrapResponse.status, 200);
    const store = await bootstrapResponse.json();
    const bootstrapOrder = store.orders.find((o: { id: string }) => o.id === order.id);
    assert.ok(bootstrapOrder, "pedido deveria aparecer no bootstrap administrativo (/equipe)");
    assert.equal(bootstrapOrder.publicCode, order.publicCode);

    await stopServer(child);
    child = undefined;

    // Arquivo real da demonstração permanece byte a byte inalterado.
    const hashAfter = await hashIfExists(REAL_DEMO_PATH);
    assert.equal(hashAfter, hashBefore);
  } catch (error) {
    if (stderrOutput) console.error("stderr do servidor de teste:\n" + stderrOutput);
    throw error;
  } finally {
    if (child) await stopServer(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/public/orders com Idempotency-Key: replay retorna o mesmo pedido, reuso com conteúdo diferente retorna 409, chaves diferentes criam pedidos diferentes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-orders-idempotency-test-"));
  const tempStorePath = path.join(tempDir, "store-teste.json");
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let stderrOutput = "";

  try {
    const hashBefore = await hashIfExists(REAL_DEMO_PATH);

    child = spawn(process.execPath, ["--experimental-strip-types", "server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, BF_STORE_PATH: tempStorePath, PORT: String(port), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", chunk => { stderrOutput += chunk.toString(); });

    await waitForServer(baseUrl, 20_000);

    const payload = {
      items: [{ productId: "demo-brigadeiro", quantity: 2 }],
      customerName: "Pedido de teste de idempotência",
      customerPhone: "85999998888",
      fulfillmentType: "RETIRADA",
      paymentMethod: "PIX",
      pickupTime: "",
    };

    const postOrder = (body: unknown, idempotencyKey?: string) =>
      fetch(`${baseUrl}/api/public/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
        body: JSON.stringify(body),
      });

    // 1-2. Primeira chamada com a chave: cria o pedido (201).
    const firstResponse = await postOrder(payload, "integration-key-001");
    assert.equal(firstResponse.status, 201);
    assert.equal(firstResponse.headers.get("idempotency-replayed"), "false");
    const firstOrder = await firstResponse.json();

    // 3-6. Reenvio exatamente igual, mesma chave: replay (200), mesmo id/publicCode.
    const replayResponse = await postOrder(payload, "integration-key-001");
    assert.equal(replayResponse.status, 200);
    assert.equal(replayResponse.headers.get("idempotency-replayed"), "true");
    const replayOrder = await replayResponse.json();
    assert.equal(replayOrder.id, firstOrder.id);
    assert.equal(replayOrder.publicCode, firstOrder.publicCode);

    // 8. Apenas um pedido no arquivo temporário.
    const onDiskAfterReplay = JSON.parse(await fs.readFile(tempStorePath, "utf8"));
    assert.equal(onDiskAfterReplay.orders.length, 1);

    // 9. Apenas um pedido no bootstrap administrativo.
    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: ADMIN_CODE }),
    });
    const { token } = await loginResponse.json();
    const bootstrapAfterReplay = await (await fetch(`${baseUrl}/api/admin/bootstrap`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(bootstrapAfterReplay.orders.length, 1);

    // 10-11. Mesma chave, quantidade diferente: conflito (409).
    const conflictingPayload = { ...payload, items: [{ productId: "demo-brigadeiro", quantity: 3 }] };
    const conflictResponse = await postOrder(conflictingPayload, "integration-key-001");
    assert.equal(conflictResponse.status, 409);

    // 12. Continua existindo apenas um pedido após o conflito.
    const onDiskAfterConflict = JSON.parse(await fs.readFile(tempStorePath, "utf8"));
    assert.equal(onDiskAfterConflict.orders.length, 1);

    // Duas chaves diferentes com o mesmo payload: criam dois pedidos (a chave, não o conteúdo, controla a idempotência).
    const secondKeyResponse = await postOrder(payload, "integration-key-002");
    assert.equal(secondKeyResponse.status, 201);
    const secondKeyOrder = await secondKeyResponse.json();
    assert.notEqual(secondKeyOrder.id, firstOrder.id);

    const onDiskFinal = JSON.parse(await fs.readFile(tempStorePath, "utf8"));
    assert.equal(onDiskFinal.orders.length, 2);

    await stopServer(child);
    child = undefined;

    const hashAfter = await hashIfExists(REAL_DEMO_PATH);
    assert.equal(hashAfter, hashBefore);
  } catch (error) {
    if (stderrOutput) console.error("stderr do servidor de teste:\n" + stderrOutput);
    throw error;
  } finally {
    if (child) await stopServer(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
