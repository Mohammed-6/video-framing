import { createApp } from "./app";
import { loadConfig } from "./config";
import { CredentialCipher } from "./crypto";
import { migrate } from "./db/migrate";
import { createDb } from "./db/pool";
import { createStorage } from "./storage";

async function main() {
  const cfg = loadConfig();
  if (cfg.RUN_MIGRATIONS_ON_START) await migrate(cfg.DATABASE_URL);
  const db = createDb(cfg.DATABASE_URL);
  const storage = createStorage(cfg);
  const app = createApp({ cfg, db, storage, cipher: new CredentialCipher(cfg.CREDENTIALS_KEY), fetch: globalThis.fetch });

  const server = app.listen(cfg.PORT, () => {
    console.log(`clipforge api listening on :${cfg.PORT} (storage=${storage.driver})`);
  });
  server.requestTimeout = 0; // large local-storage uploads

  const shutdown = () => {
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
