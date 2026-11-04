import type { Config } from "./config";
import type { CredentialCipher } from "./crypto";
import type { Db } from "./db/pool";
import type { BlobStorage } from "./storage";

/** Everything route modules need, injected so tests can supply fakes. */
export type AppDeps = {
  cfg: Config;
  db: Db;
  storage: BlobStorage;
  cipher: CredentialCipher;
  /** Injectable for tests (YouTube / Google OAuth calls). */
  fetch: typeof fetch;
};
