import { getSupabaseServiceRole } from "@/lib/supabase";
import { diskGet, diskSet } from "@/lib/disk-cache";
import { notifiedHashGet, notifiedHashSet } from "@/lib/dashboard-cache";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 15_000;
/** Cap report size — Telegram messages max out around 4096 chars. */
const MAX_SITES = 40;
const MAX_TEXT_CHARS = 4000;
/** Disk cache: phone → Telegram chat id (learned from bot inbox messages). */
const CHAT_MAP_KEY = "tg:phone-chat-map";
/** Inbox scans from the dashboard poll are throttled to one per minute. */
const INBOX_SCAN_MIN_INTERVAL_MS = 60_000;
let lastInboxScanAt = 0;
/** One in-flight report per user per instance (parallel polls dedupe here). */
const notifyingUsers = new Set<string>();

interface InboxUpdate {
  update_id: number;
  message?: {
    text?: string;
    contact?: { phone_number?: string };
    chat?: { id?: number };
  };
}

export interface NotifyDevice {
  serialNumber: string;
  name: string;
  aliasName: string;
  productClass: string;
  detailsUnavailable?: boolean;
}

export interface NotifySite {
  groupId: number;
  name: string;
  province?: string;
  offlineCount: number;
  totalCount: number;
  devices: NotifyDevice[];
}

/**
 * Normalize a phone number to E.164 for storage/lookup.
 * Accepts 09171234567 / 639171234567 / +639171234567 / (0917) 123-4567.
 * Local PH numbers (leading 0) become +63…; returns null when unparseable.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) {
    return /^\+\d{7,15}$/.test(digits) ? digits : null;
  }
  if (/^0\d{9,12}$/.test(digits)) return `+63${digits.slice(1)}`;
  if (/^63\d{9,12}$/.test(digits)) return `+${digits}`;
  if (/^\d{7,15}$/.test(digits)) return `+${digits}`;
  return null;
}

/** Pull a phone-looking number out of a free-text message. */
function phoneFromText(text?: string): string | null {
  if (!text) return null;
  const match = text.match(/\+?[\d][\d\s\-()]{7,17}\d/);
  return match ? normalizePhone(match[0]) : null;
}

/**
 * Persist learned phone→chat links onto contact rows (resolved_chat_id) so
 * the mapping survives cold starts on serverless hosts (Netlify has no
 * writable disk cache and getUpdates is acked — the link would be lost
 * forever). Best-effort: warns and stops when the migration_v7 column is
 * missing; the disk map still covers long-lived processes.
 */
async function persistLinkedChats(map: Record<string, string>): Promise<void> {
  try {
    const supabase = getSupabaseServiceRole();
    const { data: rows, error } = await supabase
      .from("contact_incharges")
      .select("id, telegram_chat_id");
    if (error || !rows?.length) return;
    for (const row of rows) {
      const phone = normalizePhone(String(row.telegram_chat_id || ""));
      const chatId = phone ? map[phone] : undefined;
      if (!chatId) continue;
      const { error: updateError } = await supabase
        .from("contact_incharges")
        .update({ resolved_chat_id: chatId })
        .eq("id", row.id);
      if (updateError) {
        console.warn("Telegram chat-id persist failed:", updateError.message);
        return;
      }
    }
  } catch (e) {
    console.warn(
      "Telegram chat-id persist failed:",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Drain the bot's inbox: link numbers (from text or shared contact card) to
 * chats, and reply to every message so the bot actually responds.
 *
 * Reply rules:
 *   - number found & newly linked → confirmation
 *   - number found & already linked → "already linked"
 *   - no number, chat already linked → "you're linked, reports after sync"
 *   - no number, unknown chat → ask them to send their number / contact card
 *
 * Always acks processed updates (offset) and is safe to call concurrently —
 * `force` bypasses the throttle (used when a report must resolve a number now).
 */
export async function processTelegramInbox(opts?: {
  force?: boolean;
}): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  if (!opts?.force) {
    if (Date.now() - lastInboxScanAt < INBOX_SCAN_MIN_INTERVAL_MS) return;
  }
  lastInboxScanAt = Date.now();

  try {
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getUpdates?limit=100&allowed_updates=${encodeURIComponent('["message"]')}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: InboxUpdate[];
    } | null;
    if (!data?.ok || !Array.isArray(data.result) || data.result.length === 0) {
      return;
    }

    const map = diskGet<Record<string, string>>(CHAT_MAP_KEY) || {};
    const linkedChats = new Set(Object.values(map));
    let learned = false;
    let lastId = 0;

    for (const update of data.result) {
      if (update.update_id > lastId) lastId = update.update_id;
      const msg = update.message;
      const chatId = msg?.chat?.id;
      if (!msg || chatId == null) continue;

      // Contact card (attach → Contact) or a typed number in the text.
      const phone =
        normalizePhone(msg.contact?.phone_number || "") ||
        phoneFromText(msg.text);

      let reply: string;
      if (phone && map[phone] !== String(chatId)) {
        map[phone] = String(chatId);
        linkedChats.add(String(chatId));
        learned = true;
        reply =
          "✓ Number linked — monitoring outage reports will be sent to you here after each sync.";
      } else if (phone) {
        reply =
          "✓ Your number is already linked. Monitoring reports will arrive here after each sync.";
      } else if (linkedChats.has(String(chatId))) {
        reply =
          "✓ You're linked. Offline-site reports arrive here after each sync (or when Sync Data is pressed).";
      } else {
        reply =
          "Hi! I'm the monitoring bot. Send your mobile number (e.g. 09171234567) " +
          "or share your contact card (Attach → Contact) so outage reports can reach you.";
      }

      try {
        await sendTelegramMessage(String(chatId), reply);
      } catch (e) {
        console.warn(
          "Telegram reply failed:",
          e instanceof Error ? e.message : e
        );
      }
    }

    if (learned) {
      diskSet(CHAT_MAP_KEY, map);
      await persistLinkedChats(map);
    }
    // Confirm processed updates so they are not re-delivered/expired.
    if (lastId > 0) {
      await fetch(
        `${TELEGRAM_API_BASE}/bot${token}/getUpdates?offset=${lastId + 1}&limit=1&timeout=0`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      ).catch(() => undefined);
    }
  } catch (e) {
    console.warn(
      "Telegram inbox scan failed:",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Resolve a stored contact reference (phone or @username) to a chat ID the
 * Telegram API accepts. @username is used directly. A phone number is looked
 * up in the disk-cached phone→chat map learned from the bot's inbox; on a
 * miss it forces one inbox scan (the contact may have just sent their
 * number). Returns null when the contact still hasn't sent their number.
 */
async function resolveTelegramChatId(raw: string): Promise<string | null> {
  const value = raw.trim();
  if (value.startsWith("@")) return value;
  const phone = normalizePhone(value);
  if (!phone) return null;

  const map = diskGet<Record<string, string>>(CHAT_MAP_KEY) || {};
  if (map[phone]) return map[phone];

  await processTelegramInbox({ force: true });
  const refreshed = diskGet<Record<string, string>>(CHAT_MAP_KEY) || {};
  return refreshed[phone] || null;
}

/**
 * Send one text message via the Telegram Bot API.
 * `chatId` may be @username or numeric user ID (the contact must have
 * started a conversation with the bot first).
 * Throws on any failure.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
  } | null;

  if (!res.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram send failed (HTTP ${res.status})`);
  }
}

/**
 * Build the monitoring report text — one block per down site, separated by
 * a blank line:
 *
 *   Good day, Down Site in Site A (Cavite).
 *
 *   Good day, Down Site in Site B (Rizal).
 */
export function buildMonitoringReport(sites: NotifySite[]): string {
  const blocks: string[] = [];

  for (const site of sites.slice(0, MAX_SITES)) {
    const where = site.province ? ` (${site.province})` : "";
    blocks.push(`Good day, Down Site in ${site.name}${where}.`);
  }
  if (sites.length > MAX_SITES) {
    blocks.push(`...and ${sites.length - MAX_SITES} more down sites.`);
  }

  const text = blocks.join("\n\n");
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}...`
    : text;
}

/**
 * Stable fingerprint of one sync cycle's down-site set. Stored durably
 * (dashboard_cache.notified_hash) so a report goes out once per cycle — not
 * once per poll — even across serverless instances. The payload's builtAt
 * rotates the hash every sync, preserving the "report after every sync" cadence.
 */
function offlineSitesHash(sites: NotifySite[], builtAt?: number): string {
  const parts = sites
    .map((s) => {
      const devices = s.devices
        .map((d) => d.serialNumber || d.aliasName || d.name || "")
        .filter(Boolean)
        .sort()
        .join(",");
      return `${s.groupId}|${s.name}|${s.province || ""}|${s.offlineCount}/${s.totalCount}|${devices}`;
    })
    .sort();
  const material = `${builtAt ?? ""}\n${parts.join("\n")}`;
  let h = 5381;
  for (let i = 0; i < material.length; i++) {
    h = (Math.imul(h, 33) + material.charCodeAt(i)) | 0;
  }
  return `v1:${sites.length}:${h}`;
}

/**
 * Message every contact incharge whose assigned provinces/projects contain
 * any currently-offline site. Never throws — per-contact failures are logged.
 *
 * Delivery is claimed against a durable per-cycle fingerprint
 * (dashboard_cache.notified_hash) so:
 *   - cache-hit polls do not re-send the same outage on every request, and
 *   - if a serverless host freezes the post-response after() work mid-send,
 *     the claim stays unset and the next dashboard request delivers it.
 *
 * No-op when TELEGRAM_BOT_TOKEN is unset or there are no offline sites.
 */
export async function sendOfflineReports(
  userId: string,
  payload: { offlineSites?: NotifySite[]; builtAt?: number }
): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;

  const sites = (payload.offlineSites || []).filter((s) => s.offlineCount > 0);
  if (sites.length === 0) return;
  if (notifyingUsers.has(userId)) return;
  notifyingUsers.add(userId);

  try {
    const supabase = getSupabaseServiceRole();

    // Already delivered for this sync cycle?
    const hash = offlineSitesHash(sites, payload.builtAt);
    if ((await notifiedHashGet(userId)) === hash) return;

    const { data: contacts, error } = await supabase
      .from("contact_incharges")
      .select("*")
      .eq("user_id", userId);
    if (error) {
      console.warn("Contacts lookup failed:", error.message);
      return;
    }

    const sends: Promise<void>[] = [];
    for (const contact of contacts || []) {
      const provinces: string[] = Array.isArray(contact.provinces)
        ? contact.provinces.map((p: unknown) => String(p).toLowerCase())
        : [];
      const projectIds: number[] = Array.isArray(contact.project_ids)
        ? contact.project_ids
            .map((p: unknown) => Number(p))
            .filter((n: number) => Number.isFinite(n))
        : [];
      // No assignment — this contact is not in charge of any site.
      if (provinces.length === 0 && projectIds.length === 0) continue;

      const scoped = sites.filter(
        (s) =>
          (s.province != null && provinces.includes(s.province.toLowerCase())) ||
          projectIds.includes(s.groupId)
      );
      if (scoped.length === 0) {
        console.warn(
          `Telegram report skipped for ${contact.name}: ` +
            "no offline site falls within their assigned provinces/projects"
        );
        continue;
      }

      const resolvedChatId = String(contact.resolved_chat_id || "").trim();
      const raw = String(contact.telegram_chat_id || "").trim();
      if (!resolvedChatId && !raw) {
        console.warn(`Skipping Telegram report for ${contact.name}: no number`);
        continue;
      }

      // Prefer the DB-stored chat id (survives serverless cold starts), fall
      // back to the learned phone→chat map / a fresh inbox scan.
      const chatId = resolvedChatId || (await resolveTelegramChatId(raw)) || "";
      if (!chatId) {
        console.warn(
          `Telegram report skipped for ${contact.name} (${raw}): ` +
            "contact has not messaged the bot yet"
        );
        continue;
      }
      if (!resolvedChatId) {
        // Backfill so the link outlives the process (Netlify cold starts).
        const { error: persistError } = await supabase
          .from("contact_incharges")
          .update({ resolved_chat_id: chatId })
          .eq("id", contact.id);
        if (persistError) {
          console.warn("Telegram chat-id persist failed:", persistError.message);
        }
      }

      sends.push(
        sendTelegramMessage(chatId, buildMonitoringReport(scoped))
          .then(() => {
            console.log(
              `Telegram report sent to ${contact.name} (${chatId}) — ` +
                `${scoped.length} offline site(s)`
            );
          })
          .catch((e) => {
            console.warn(
              `Telegram report failed for ${contact.name} (${raw}):`,
              e instanceof Error ? e.message : e
            );
          })
      );
    }

    // Parallel: N contacts must not serialize into N × timeout on serverless.
    await Promise.allSettled(sends);
    // Claim the cycle after the attempt — a host that freezes the function
    // mid-send leaves the claim unset, so the next request retries.
    await notifiedHashSet(userId, hash);
  } finally {
    notifyingUsers.delete(userId);
  }
}
