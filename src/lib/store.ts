import fs from "node:fs/promises";
import path from "node:path";

export function resolveStorePath(cwd: string = process.cwd()): string {
  const configured = process.env.BF_STORE_PATH?.trim();
  return configured ? path.resolve(cwd, configured) : path.join(cwd, "data", "brownies-fortal.demo.json");
}

export async function saveStoreFile<T>(storePath: string, store: T): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export async function loadStoreFile<T>(storePath: string, createSeed: () => T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8")) as T;
  } catch {
    const seed = createSeed();
    await saveStoreFile(storePath, seed);
    console.log("[store] armazenamento inicializado com dados semente (arquivo novo).");
    return structuredClone(seed);
  }
}
