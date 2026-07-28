import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveStorePath, loadStoreFile, saveStoreFile } from "../src/lib/store.ts";

const REAL_DEMO_PATH = path.join(process.cwd(), "data", "brownies-fortal.demo.json");

type FakeStore = { business: { name: string }; products: { id: string }[]; orders: unknown[] };
const fakeSeed = (): FakeStore => ({ business: { name: "Loja de teste" }, products: [{ id: "p1" }], orders: [] });

async function hashIfExists(filePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

test("resolveStorePath usa o caminho padrão quando BF_STORE_PATH não está definida", () => {
  const original = process.env.BF_STORE_PATH;
  delete process.env.BF_STORE_PATH;
  try {
    assert.equal(resolveStorePath("/projeto"), path.join("/projeto", "data", "brownies-fortal.demo.json"));
  } finally {
    if (original !== undefined) process.env.BF_STORE_PATH = original;
  }
});

test("resolveStorePath usa o caminho absoluto informado em BF_STORE_PATH", () => {
  const original = process.env.BF_STORE_PATH;
  process.env.BF_STORE_PATH = "/tmp/algum-lugar/store.json";
  try {
    assert.equal(resolveStorePath("/projeto"), "/tmp/algum-lugar/store.json");
  } finally {
    if (original === undefined) delete process.env.BF_STORE_PATH; else process.env.BF_STORE_PATH = original;
  }
});

test("resolveStorePath resolve caminho relativo de BF_STORE_PATH a partir do diretório de execução", () => {
  const original = process.env.BF_STORE_PATH;
  process.env.BF_STORE_PATH = "tmp-tests/store.json";
  try {
    assert.equal(resolveStorePath("/projeto"), path.join("/projeto", "tmp-tests", "store.json"));
  } finally {
    if (original === undefined) delete process.env.BF_STORE_PATH; else process.env.BF_STORE_PATH = original;
  }
});

test("armazenamento temporário via BF_STORE_PATH é isolado e não contamina a demonstração", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-store-test-"));
  const originalEnv = process.env.BF_STORE_PATH;
  try {
    const tempStorePath = path.join(tempDir, "nested", "store-teste.json");
    process.env.BF_STORE_PATH = tempStorePath;

    const hashBefore = await hashIfExists(REAL_DEMO_PATH);

    const resolved = resolveStorePath();
    assert.equal(resolved, tempStorePath);

    // Arquivo/diretórios ainda não existem antes da inicialização.
    await assert.rejects(fs.stat(tempStorePath));

    const loaded = await loadStoreFile<FakeStore>(resolved, fakeSeed);

    // Diretórios ausentes foram criados e o arquivo foi inicializado.
    const stat = await fs.stat(tempStorePath);
    assert.ok(stat.isFile());

    // Estrutura válida e sem pedidos copiados da demonstração.
    assert.deepEqual(loaded, fakeSeed());
    assert.equal(loaded.orders.length, 0);

    const onDisk = JSON.parse(await fs.readFile(tempStorePath, "utf8"));
    assert.deepEqual(onDisk, fakeSeed());
    assert.equal(onDisk.orders.length, 0);

    // Grava uma alteração (simulando a criação de um pedido) apenas no armazenamento temporário.
    const changed: FakeStore = { ...loaded, orders: [{ id: "pedido-teste" }] };
    await saveStoreFile(resolved, changed);
    const reloaded = JSON.parse(await fs.readFile(tempStorePath, "utf8"));
    assert.equal(reloaded.orders.length, 1);

    // O arquivo real da demonstração permanece byte a byte inalterado.
    const hashAfter = await hashIfExists(REAL_DEMO_PATH);
    assert.equal(hashAfter, hashBefore);
  } finally {
    if (originalEnv === undefined) delete process.env.BF_STORE_PATH; else process.env.BF_STORE_PATH = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
