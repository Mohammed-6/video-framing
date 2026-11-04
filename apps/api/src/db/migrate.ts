import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

/** Minimal forward-only migration runner: applies db/migrations/*.sql in name order. */
export async function migrate(connectionString: string, log: (msg: string) => void = console.log) {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    // Serialise concurrent API instances starting at the same time.
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const dir = path.join(__dirname, "migrations");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      log(`applying migration ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  migrate(url).then(
    () => console.log("migrations complete"),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
