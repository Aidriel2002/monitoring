import { getSupabaseServiceRole } from "@/lib/supabase";

/**
 * Durable dashboard payload cache (Supabase).
 *
 * Netlify function instances share no memory and have an ephemeral /
 * read-only filesystem, so the in-memory cache (lib/cache) dies on every
 * cold start — the first poll after a cold start had to redo the full
 * multi-second Ruijie rebuild before any sites appeared. This table keeps
 * the last healthy payload so a cold instance can answer instantly.
 */
const TABLE = "dashboard_cache";

export interface DurableDashboard<T> {
  payload: T;
  builtAtMs: number;
}

export async function durableLoad<T>(
  userId: string
): Promise<DurableDashboard<T> | null> {
  try {
    const sb = getSupabaseServiceRole();
    const { data, error } = await sb
      .from(TABLE)
      .select("payload, built_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data?.payload) return null;
    const builtAtMs = Date.parse(String(data.built_at || ""));
    if (!Number.isFinite(builtAtMs)) return null;
    const payload = data.payload as T;
    // Stub rows written by notifiedHashSet carry an empty payload object.
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray((payload as { projects?: unknown[] }).projects)
    ) {
      return null;
    }
    return { payload, builtAtMs };
  } catch {
    return null;
  }
}

/** Persist a freshly built healthy payload. Best-effort. */
export async function durableSave(
  userId: string,
  payload: unknown
): Promise<void> {
  try {
    const sb = getSupabaseServiceRole();
    // Partial upsert: only the provided columns are written, so an existing
    // notified_hash (Telegram claim) survives a payload refresh.
    await sb
      .from(TABLE)
      .upsert(
        {
          user_id: userId,
          payload,
          built_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
  } catch {
    // best-effort — the in-memory cache still covers this instance
  }
}

export async function durableClear(userId: string): Promise<void> {
  try {
    await getSupabaseServiceRole().from(TABLE).delete().eq("user_id", userId);
  } catch {
    // best-effort
  }
}

/** Last Telegram report fingerprint for this user (null = never sent). */
export async function notifiedHashGet(userId: string): Promise<string | null> {
  try {
    const sb = getSupabaseServiceRole();
    const { data, error } = await sb
      .from(TABLE)
      .select("notified_hash")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return typeof data.notified_hash === "string" ? data.notified_hash : null;
  } catch {
    return null;
  }
}

/**
 * Record that the report for `hash` was delivered. Creates a stub row (empty
 * payload) when the user has none yet — durableLoad ignores those stubs.
 */
export async function notifiedHashSet(
  userId: string,
  hash: string
): Promise<void> {
  try {
    const sb = getSupabaseServiceRole();
    await sb
      .from(TABLE)
      .upsert(
        { user_id: userId, notified_hash: hash, payload: {} },
        { onConflict: "user_id" }
      );
  } catch {
    // best-effort — worst case a duplicate report is sent
  }
}
