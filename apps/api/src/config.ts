import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),

  /** The single owner's login password. */
  APP_PASSWORD: z.string().min(8, "APP_PASSWORD must be at least 8 characters"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_TTL_SECONDS: z.coerce.number().int().default(60 * 60 * 24 * 30),
  /** 32-byte key (base64) used to encrypt platform credentials at rest. */
  CREDENTIALS_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "CREDENTIALS_KEY must be 32 bytes, base64-encoded"),

  /** Browser-facing origin of the app (web + /api behind one host). Used for OAuth redirects. */
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  /** Browser-reachable API base (used for local-storage signed URLs). */
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),

  STORAGE_DRIVER: z.enum(["local", "gcs"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./data/blobs"),
  STORAGE_SIGNING_SECRET: z.string().default("dev-only-signing-secret"),
  GCS_BUCKET: optional,
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().default(60 * 30),
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().default(60 * 60),

  /** YouTube Data API v3 key (search & metadata). */
  YOUTUBE_API_KEY: optional,
  /** Daily quota of the key (Google's default is 10,000 units); only used for the usage display. */
  YOUTUBE_DAILY_QUOTA: z.coerce.number().int().positive().default(10_000),
  /** Reuse identical searches / video details for this long (0 = no cache). */
  YOUTUBE_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),
  /** Google OAuth client for publishing to YouTube (can also be set in the Platforms UI). */
  GOOGLE_OAUTH_CLIENT_ID: optional,
  GOOGLE_OAUTH_CLIENT_SECRET: optional,

  RUN_MIGRATIONS_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.STORAGE_DRIVER === "gcs" && !cfg.GCS_BUCKET) {
    throw new Error("GCS_BUCKET is required when STORAGE_DRIVER=gcs");
  }
  if (cfg.NODE_ENV === "production" && cfg.STORAGE_DRIVER === "local") {
    throw new Error("STORAGE_DRIVER=local is for development only");
  }
  return cfg;
}
