import { Pool, PoolClient, QueryResultRow } from "pg";

export type Queryable = Pick<PoolClient, "query">;

export type Db = {
  pool: Pool;
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
};

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 10 });
  return {
    pool,
    async query(sql, params) {
      return (await pool.query(sql, params as any[])).rows;
    },
    async one(sql, params) {
      return (await pool.query(sql, params as any[])).rows[0] ?? null;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
