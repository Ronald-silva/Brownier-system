// Round-trip real em disco (mesmo padrão de tests/store_path.test.ts):
// simula exatamente a sequência que server.ts faz em loadStore() — carregar,
// aplicar os backfills, salvar — e depois um "restart" (nova leitura do
// mesmo arquivo) para provar que tanto o backfill inicial quanto uma
// alteração feita pelo painel sobrevivem a um reinício do processo.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadStoreFile, saveStoreFile } from "../src/lib/store.ts";
import { ensureBrownierOperatingHours } from "../src/lib/business-defaults.ts";
import { INITIAL_OPERATING_HOURS, type StructuredWeeklyHours } from "../src/lib/business-hours.ts";

type FakeStore = { business: Record<string, unknown>; products: unknown[]; orders: unknown[] };
const seed = (): FakeStore => ({ business: { name: "Loja de teste" }, products: [], orders: [] });

test("horário estruturado sobrevive a um reinício (novo arquivo): backfill roda no primeiro boot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-hours-test-"));
  try {
    const storePath = path.join(tempDir, "store.json");

    // "Boot 1": arquivo ainda não existe — mesma sequência de server.ts#loadStore.
    const firstLoad = await loadStoreFile<FakeStore>(storePath, seed);
    const afterBackfill = ensureBrownierOperatingHours(firstLoad);
    await saveStoreFile(storePath, afterBackfill);

    // "Restart": novo processo, mesma leitura do arquivo em disco.
    const secondBoot = await loadStoreFile<FakeStore>(storePath, seed);
    assert.deepEqual(secondBoot.business.operatingHours, INITIAL_OPERATING_HOURS);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("alteração feita pelo painel persiste após reinício e o backfill nunca a sobrescreve", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-hours-test-"));
  try {
    const storePath = path.join(tempDir, "store.json");
    const boot1 = ensureBrownierOperatingHours(await loadStoreFile<FakeStore>(storePath, seed));
    await saveStoreFile(storePath, boot1);

    // Simula PUT /api/admin/business com operatingHours customizado (domingo passa a abrir).
    const customHours: StructuredWeeklyHours = { ...INITIAL_OPERATING_HOURS, SUN: [{ open: "10:00", close: "14:00" }] };
    const afterAdminEdit = { ...boot1, business: { ...boot1.business, operatingHours: customHours } };
    await saveStoreFile(storePath, afterAdminEdit);

    // "Restart" após a alteração do painel.
    const boot2 = await loadStoreFile<FakeStore>(storePath, seed);
    assert.deepEqual(boot2.business.operatingHours, customHours);

    // O backfill do próximo boot precisa reconhecer o horário já cadastrado
    // e devolver a MESMA referência — nunca substituir por INITIAL_OPERATING_HOURS.
    const afterSecondBackfill = ensureBrownierOperatingHours(boot2);
    assert.equal(afterSecondBackfill, boot2);
    assert.deepEqual(afterSecondBackfill.business.operatingHours, customHours);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
