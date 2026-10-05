import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db/client.js";
import { settings } from "./db/schema.js";

// Every runtime setting is declared here with the shape its value must have
export const SETTINGS = {
  "chat.model": z
    .string()
    .trim()
    .regex(/^(opus|sonnet|haiku|claude-[a-z0-9.-]+)(\[1m\])?$/, "Modelo de Claude no reconocido"),
} as const;

export type SettingKey = keyof typeof SETTINGS;

/**
 * Tells whether a key names a declared setting
 *
 * @param   key  Candidate key
 *
 * @return  Whether it is a setting key
 */
export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/**
 * Reads a setting, or null when nobody set it
 *
 * @param   db   Own database
 * @param   key  Setting to read
 *
 * @return  The stored value
 */
export async function readSetting<K extends SettingKey>(
  db: Database,
  key: K,
): Promise<z.infer<(typeof SETTINGS)[K]> | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  const parsed = SETTINGS[key].safeParse(row?.value);

  return parsed.success ? parsed.data : null;
}

/**
 * Lists every stored setting
 *
 * @param   db  Own database
 *
 * @return  The settings with who changed them and when
 */
export function listSettings(db: Database) {
  return db.select().from(settings).orderBy(settings.key);
}

/**
 * Stores a setting after checking its shape
 *
 * @param   db      Own database
 * @param   key     Setting to change
 * @param   value   New value
 * @param   userId  Administrator changing it
 *
 * @return  The stored value, or the reason it was rejected in Spanish
 */
export async function writeSetting(
  db: Database,
  key: SettingKey,
  value: unknown,
  userId: number,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const parsed = SETTINGS[key].safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Valor inválido" };
  }

  await db
    .insert(settings)
    .values({ key, value: parsed.data, updatedBy: userId })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: parsed.data, updatedBy: userId, updatedAt: sql`now()` },
    });

  return { ok: true, value: parsed.data };
}
