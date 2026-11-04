import { AppSettings } from "@clipforge/contracts";
import type { Db } from "../../db/pool";

/** Stored JSON is parsed through the schema so new fields always get defaults. */
export async function getSettings(db: Db): Promise<AppSettings> {
  const row = await db.one<{ settings: unknown }>("SELECT settings FROM app_settings LIMIT 1");
  const parsed = AppSettings.safeParse(row?.settings ?? {});
  return parsed.success ? parsed.data : AppSettings.parse({});
}

export async function saveSettings(db: Db, settings: AppSettings): Promise<AppSettings> {
  await db.query("UPDATE app_settings SET settings = $1, updated_at = now()", [JSON.stringify(settings)]);
  return settings;
}
