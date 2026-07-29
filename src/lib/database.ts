import { Pool } from "pg";

type DatabaseQueryable = {
  query(queryText: string): Promise<unknown>;
};

let databasePool: Pool | undefined;

function getDatabasePool(): Pool {
  if (databasePool) return databasePool;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL não configurada");
  }

  databasePool = new Pool({ connectionString });
  return databasePool;
}

// O Pool é criado apenas na primeira checagem; importar este módulo não abre
// conexão nem tenta acessar o PostgreSQL.
export async function checkDatabaseConnection(queryable: DatabaseQueryable = getDatabasePool()): Promise<void> {
  await queryable.query("SELECT 1");
}

export async function closeDatabasePool(): Promise<void> {
  if (!databasePool) return;

  const pool = databasePool;
  databasePool = undefined;
  await pool.end();
}
