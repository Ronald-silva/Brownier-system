import assert from "node:assert/strict";
import test from "node:test";
import { checkDatabaseConnection, closeDatabasePool } from "../src/lib/database.ts";

test("checkDatabaseConnection executa SELECT 1 no queryable informado", async () => {
  const queries: string[] = [];

  await checkDatabaseConnection({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] } as never;
    },
  });

  assert.deepEqual(queries, ["SELECT 1"]);
});

test("checkDatabaseConnection propaga falha do PostgreSQL sem criar conexão durante import", async () => {
  const databaseError = new Error("database unavailable");

  await assert.rejects(
    checkDatabaseConnection({ query: async () => { throw databaseError; } }),
    databaseError,
  );
});

test("closeDatabasePool é seguro antes de qualquer checagem", async () => {
  await assert.doesNotReject(closeDatabasePool());
});
