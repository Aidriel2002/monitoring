import { NextResponse, after } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheClear, cacheGet, cacheSet } from "@/lib/cache";
import { diskGet, diskSet } from "@/lib/disk-cache";
import { durableLoad, durableSave } from "@/lib/dashboard-cache";
import {
  getProjects,
  fetchProjectTree,
  getFleetDevices,
  getReceivedProjects,
  getWarnLogsForGroup,
  getGroupGeo,
  getRateLimitStatus,
  isRateLimitError,
  invalidateDeviceStatus,
  DEVICE_STATUS_INTERVAL_SECONDS,
  expandSelectionToLeaves,
  RuijieCredentials,
  RuijieProject,
  RuijieDevice,
  RuijieWarnLog,
  ProjectTreeNode,
} from "@/lib/ruijie";
import { reverseGeocodeProvince, geocodeSiteName, isValidSiteGeo } from "@/lib/geo";
import { parseProjectsCache } from "@/lib/projects-cache";
import { broadcastDashboardUpdate } from "@/lib/realtime";
import { processTelegramInbox, sendOfflineReports } from "@/lib/notify";

/**
 * Warn-log rows are reused between cycles while a group's offline count is
 * unchanged; this caps how stale a quiet group's device identities may get.
 */
const WARN_LOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Cross-build warn-log store (module scope — must outlive a single request).
 * Without it every rebuild re-queried every offline shared group
 * (~15-30 calls) even though nothing had changed.
 */
const warnLogsByGroup = new Map<
  number,
  { rows: RuijieWarnLog[]; fetchedAt: number; offlineCount: number }
>();

/**
 * Outage starts for sites with no readable per-device history: shared
 * projects from tenants this account cannot query (device list → code 5,
 * warn log → empty) only expose on/off counts, never a timestamp. Remember
 * when the outage was first observed instead — persisted so restarts and
 * rate-limit holds don't reset every site's offline-days clock.
 */
const OUTAGE_DISK_KEY = "outage-starts:v1";
/** An entry unseen for this long is treated as a closed, previous outage. */
const OUTAGE_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const outageStarts = new Map<
  number,
  { startedAt: number; lastSeenAt: number }
>();
let outageStartsLoaded = false;

function loadOutageStarts(): void {
  if (outageStartsLoaded) return;
  outageStartsLoaded = true;
  try {
    const rows = diskGet<[number, { startedAt: number; lastSeenAt: number }][]>(
      OUTAGE_DISK_KEY
    );
    if (rows) for (const [groupId, entry] of rows) outageStarts.set(groupId, entry);
  } catch {
    // unreadable entry — start empty; the next build re-seeds it
  }
}

/** Oldest known outage start from real device rows (0 = no data). */
function oldestOfflineFromDevices(devices: RuijieDevice[]): number {
  const times = devices
    .filter((d) => d.onlineStatus !== "ON" && d.lastOnline > 0)
    .map((d) => d.lastOnline);
  if (times.length === 0) return 0;
  return Math.min(...times);
}

export interface RateLimitedCredential {
  id: string;
  name: string;
  retryInSeconds: number;
}

async function getUser(request: Request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...val] = c.trim().split("=");
      return [key, val.join("=")];
    })
  );

  const accessToken = cookies["sb-access-token"];
  if (!accessToken) return null;

  const supabase = getSupabaseServiceRole();
  const { data } = await supabase.auth.getUser(accessToken);
  return data.user;
}

export interface ProjectWithDevices extends RuijieProject {
  devices: RuijieDevice[];
  onlineCount: number;
  offlineCount: number;
  totalCount: number;
  credentialId?: string;
  /**
   * When this site went offline (epoch ms). Normally the oldest offline
   * device's `lastOnline`; for shared projects whose device history this
   * account cannot read, the first build that saw the outage.
   */
  oldestOffline?: number;
}

export type OfflineDevice = RuijieDevice & {
  credentialId?: string;
  credentialName?: string;
  /** Aggregate-only row for shared projects (no per-device API access) */
  detailsUnavailable?: boolean;
  offlineCount?: number;
  latitude?: number;
  longitude?: number;
  province?: string;
};

function warnLogsToDevices(
  logs: RuijieWarnLog[],
  groupId: number,
  offlineCount: number
): RuijieDevice[] {
  const groupLogs = logs.filter(
    (l) => l.groupId === groupId && l.warnEntityType === "DEVICE" && l.sn
  );
  if (groupLogs.length === 0 || offlineCount <= 0) return [];

  // Eliminated alarms have no active outage start — `eliminateTime` is the
  // last moment Ruijie considered the device up, so it is the best available
  // "last online". Active alarm → outage start (createTime). Keep the sample
  // with the newest of those per SN, then prefer active alarms / most recent
  // activity when trimming to the project's offline count.
  const bySn = new Map<string, { log: RuijieWarnLog; lastOnline: number }>();
  for (const log of groupLogs) {
    const lastOnline = log.isEliminate ? log.eliminateTime || 0 : log.createTime;
    const prev = bySn.get(log.sn);
    if (!prev || lastOnline > prev.lastOnline) {
      bySn.set(log.sn, { log, lastOnline });
    }
  }

  return [...bySn.values()]
    .sort((a, b) => {
      if (a.log.isEliminate !== b.log.isEliminate) {
        return a.log.isEliminate ? 1 : -1;
      }
      return b.lastOnline - a.lastOnline;
    })
    .slice(0, offlineCount)
    .map(({ log, lastOnline }) => ({
      serialNumber: log.sn,
      productClass: log.productClass || "",
      productType: log.productType || "",
      commonType: "",
      onlineStatus: "OFF",
      aliasName: log.deviceName || "",
      name: log.deviceName || "",
      localIp: "",
      cpeIp: "",
      mac: "",
      groupName: log.buildName || "",
      parentGroupName: log.parentGroupName || "",
      buildingId: log.buildId,
      groupId: log.groupId,
      lastOnline,
      createTime: log.createTime,
      staNums: 0,
      staActiveNums: 0,
      softwareVersion: "",
    }));
}

/** Healthy payload matches the 10m status cycle; limited/degraded re-seat to 15s. */
const DASHBOARD_TTL_MS = DEVICE_STATUS_INTERVAL_SECONDS * 1000;
/** Degraded / rate-limited payloads get a short in-memory TTL so they self-heal. */
const DEGRADED_TTL_MS = 15_000;
/**
 * How long a known-good payload may back a degraded rebuild (fleet/tree
 * failure) instead of blanking the dashboard. Bounded so genuinely-gone
 * data still disappears within a workday.
 */
const STALE_DASHBOARD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * How long to wait for a first-ever build before answering anyway. A cold
 * rebuild is tens of seconds of sequential Ruijie calls — waiting for all of
 * it is what pushed the function past Netlify's execution limit (502 →
 * "Error fetching dashboard" → zero sites). Past this point the response
 * reports `rebuilding` and the build finishes in the background.
 */
const FIRST_BUILD_WAIT_MS = 20_000;
/** Poll again this soon when the response was served stale / is rebuilding. */
const REVALIDATE_POLL_SECONDS = 30;

/**
 * One rebuild per user across concurrent polls — without this every tab and
 * every retry stacks its own full Ruijie rebuild (quota + duration multiply).
 */
const activeRebuilds = new Map<string, Promise<DashboardPayload>>();

/**
 * Build the payload, park it in the in-memory cache (short TTL when
 * degraded), persist the durable copy when it still has sites, and log the
 * duration — a missing durable row was the reason every cold start had to
 * redo the whole rebuild. Rejections are surfaced to the caller; a caller
 * that stops awaiting (timeout) must not turn that into an unhandled
 * rejection, and the rebuild must still finish for everyone else.
 */
async function runRebuild(
  userId: string,
  cacheKey: string,
  creds: CredentialRow[],
  opts: { forceGeo?: boolean; prev?: DashboardPayload }
): Promise<DashboardPayload> {
  const existing = activeRebuilds.get(cacheKey);
  if (existing) return existing;

  const tracked = (async () => {
    const started = Date.now();
    const fresh = await buildDashboard(creds, {
      forceGeo: opts.forceGeo,
      prev: opts.prev,
    });
    const healthy =
      !fresh.degraded && (fresh.rateLimitedCredentials || []).length === 0;
    cacheSet(cacheKey, fresh, healthy ? DASHBOARD_TTL_MS : DEGRADED_TTL_MS);
    // Any payload with sites is worth keeping: the durable copy is what lets
    // a cold instance answer instantly instead of timing out. Sites of a
    // credential that is currently rate-limited are filtered on read anyway.
    if (Array.isArray(fresh.projects) && fresh.projects.length > 0) {
      await durableSave(userId, fresh);
      // Fresh geocoded provinces/sites — drop the contacts picker cache so
      // the Add Contact form picks them up without waiting out its TTL.
      cacheClear(`contacts:v1:${userId}`);
    }
    console.log(
      `[dashboard] rebuild ${Date.now() - started}ms sites=${fresh.projects.length}` +
        ` healthy=${healthy} degraded=${fresh.degraded}`
    );
    return fresh;
  })().finally(() => activeRebuilds.delete(cacheKey));

  activeRebuilds.set(cacheKey, tracked);
  tracked.catch(() => undefined);
  return tracked;
}

/** `value`, or null when `promise` did not settle within `ms`. */
async function orTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  // Kept outside the try so a failure below can still answer with the last
  // durable payload instead of a bare 500.
  let userId: string | null = null;
  let creds: CredentialRow[] | null = null;
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;

    const supabase = getSupabaseServiceRole();
    const { data: credsData, error: credsError } = await supabase
      .from("api_credentials")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true);

    if (credsError) {
      return NextResponse.json({ error: credsError.message }, { status: 500 });
    }

    const credRows = (credsData || []) as unknown as CredentialRow[];
    creds = credRows;

    if (credRows.length === 0) {
      return NextResponse.json({
        projects: [],
        offlineDevices: [],
        offlineSites: [],
        rateLimitedCredentials: [],
        statusIntervalSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
        nextUpdateInSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
      });
    }

    const cacheKey = `dashboard:${user.id}`;
    // Every credential in this account shares one Ruijie quota (same bootstrap
    // key, same source IP): once one of them returns code 44, calling the
    // others only earns code 44 for them too — which is how all of them ended
    // up flagged at once. While a cooldown is active, hold the rebuild: the
    // last payload keeps every other credential's projects on screen and only
    // the credential that actually hit the limit is reported.
    const coolingCred = credRows.some((cred) =>
      getRateLimitStatus(toRuijieCreds(cred)).limited
    );
    // Refresh button: reset the status window and rebuild immediately.
    // Not while cooling down — there is nothing to refresh, the calls would
    // only earn more code 44s (Sync Data falls back to the last payload).
    const forceStatus =
      new URL(request.url).searchParams.get("refresh") === "status" &&
      !coolingCred;

    // An API was enabled/disabled since the cached payload was built (the
    // in-memory cache is per-instance on serverless, so a toggle on another
    // instance never cleared this one). Drop the IN-MEMORY copy so a rebuild
    // is scheduled — the durable row is deliberately kept: it is the
    // last-resort answer if that rebuild fails, and applyLiveRateLimits
    // already hides credentials that are no longer active. Deleting it first
    // is what left the dashboard with nothing after a 500/502.
    const cached = cacheGet<DashboardPayload>(cacheKey);
    if (
      cached &&
      !coolingCred &&
      !credentialSetMatches(cached.credentialIds, credRows)
    ) {
      cacheClear(cacheKey);
    }
    if (forceStatus) {
      for (const cred of credRows) {
        invalidateDeviceStatus({
          appId: cred.app_id,
          secret: cred.secret,
          bootstrapToken: cred.bootstrap_token || undefined,
          baseUrl: cred.base_url || undefined,
        });
      }
      cacheClear(cacheKey);
    }
    const mem = cacheGet<DashboardPayload>(cacheKey);

    // Durable Supabase copy — cold starts answer from it instead of redoing
    // the full rebuild (which on Netlify is tens of seconds of sequential
    // Ruijie calls). Accepted well past the status TTL: a stale payload with
    // sites beats a blank one while a background rebuild runs.
    const durable = await durableLoad<DashboardPayload>(user.id);
    const durableAgeMs = durable ? Date.now() - durable.builtAtMs : Infinity;
    const durableUsable =
      !!durable &&
      durableAgeMs <= STALE_DASHBOARD_MAX_AGE_MS &&
      credentialSetMatches(durable.payload.credentialIds, credRows);
    const lastResort =
      durable && durableAgeMs <= STALE_DASHBOARD_MAX_AGE_MS
        ? durable.payload
        : undefined;

    const ageOf = (p: DashboardPayload) =>
      typeof p.builtAt === "number" ? Date.now() - p.builtAt : Infinity;

    let payload: DashboardPayload | undefined = mem;
    if (!payload && durableUsable && durable) payload = durable.payload;

    // Rate-limit hold: serve the last payload, make no Ruijie calls.
    const cooling = coolingCred && !!payload;
    const needsRebuild =
      !cooling &&
      (!payload ||
        forceStatus ||
        ageOf(payload) >= DASHBOARD_TTL_MS ||
        payload.degraded === true);

    let pendingRebuild: Promise<DashboardPayload> | null = null;
    let syncBuilt = false;
    let rebuilding = false;
    let rebuildError: string | null = null;

    if (needsRebuild) {
      pendingRebuild = runRebuild(user.id, cacheKey, credRows, {
        forceGeo: forceStatus,
        prev: payload || lastResort,
      });

      if (!payload) {
        // Nothing to show yet — wait briefly so a normal build still answers
        // inline. Anything longer risks the host's execution limit, so the
        // response reports `rebuilding` and after() finishes the work.
        try {
          const built = await orTimeout(pendingRebuild, FIRST_BUILD_WAIT_MS);
          if (built) {
            payload = built;
            syncBuilt = true;
          } else {
            rebuilding = true;
          }
        } catch (e) {
          rebuildError = e instanceof Error ? e.message : String(e);
          rebuilding = true;
        }
      } else {
        // Stale-but-usable: answer now, refresh after the response. The short
        // memory TTL keeps repeat polls cheap while the rebuild runs.
        rebuilding = true;
        cacheSet(cacheKey, payload, REVALIDATE_POLL_SECONDS * 1000);
      }
    }

    const uid = user.id;
    const backgroundBuild = !!pendingRebuild && !syncBuilt;
    if (pendingRebuild) {
      const pending = pendingRebuild;
      after(async () => {
        let fresh: DashboardPayload | null = null;
        try {
          fresh = await pending;
        } catch (e) {
          console.warn(
            "Dashboard rebuild failed:",
            e instanceof Error ? e.message : e
          );
        }
        if (fresh) {
          if (backgroundBuild) {
            // Push fresh data (and limit flags) to open dashboards — realtime
            // costs no Ruijie quota and avoids waiting for the next poll.
            await broadcastDashboardUpdate(uid, {
              rateLimitedCredentials: fresh.rateLimitedCredentials,
              degraded: fresh.degraded,
            }).catch(() => undefined);
          }
          // Telegram outage report — post-response: sending before the HTTP
          // response is what caused Netlify 502s on top of a long rebuild.
          await sendOfflineReports(uid, fresh).catch((e) =>
            console.warn(
              "Offline notifications failed:",
              e instanceof Error ? e.message : e
            )
          );
        }
        // Bot inbox housekeeping: link phone numbers and reply to new chats so
        // the bot responds within ~a minute of being messaged. Throttled inside
        // (one scan per minute per instance).
        await processTelegramInbox().catch(() => undefined);
      });
    } else if (payload) {
      // Fresh hit — send inline (bounded): if a host froze after() before the
      // report went out, the next poll delivers it.
      await Promise.race([
        sendOfflineReports(uid, payload).catch(() => undefined),
        new Promise((resolve) => {
          const t = setTimeout(resolve, 12_000);
          (t as NodeJS.Timeout).unref?.();
        }),
      ]);
      after(() => processTelegramInbox().catch(() => undefined));
    }

    // A degraded rebuild that produced no sites must not blank a dashboard an
    // older copy still has data for (rate limits / fleet failures do this).
    if (
      payload &&
      payload.projects.length === 0 &&
      payload.degraded &&
      lastResort &&
      lastResort.projects.length > 0
    ) {
      payload = lastResort;
    }

    // Nothing usable at all (first run and the build failed) — answer with an
    // explicit error instead of an empty-but-"successful" dashboard, so the
    // client shows the failure banner and retries with backoff.
    if (!payload) {
      return NextResponse.json({
        projects: [],
        offlineDevices: [],
        offlineSites: [],
        rateLimitedCredentials: [],
        degraded: true,
        rebuilding: true,
        error: rebuildError || "Dashboard rebuild did not finish",
        statusIntervalSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
        nextUpdateInSeconds: REVALIDATE_POLL_SECONDS,
      });
    }

    // Overlay live cooldown state on every response — even when the dashboard
    // cache still holds a "healthy" payload from before code 44.
    const response = applyLiveRateLimits(payload, credRows);

    // Payloads cached before coordinate validation may still carry bogus
    // coords — strip them on the way out so the map never plots them.
    for (const p of response.projects) {
      if (
        p.latitude != null &&
        p.longitude != null &&
        !isValidSiteGeo(p.latitude, p.longitude)
      ) {
        p.latitude = undefined;
        p.longitude = undefined;
      }
    }
    for (const d of response.offlineDevices) {
      if (
        d.latitude != null &&
        d.longitude != null &&
        !isValidSiteGeo(d.latitude, d.longitude)
      ) {
        d.latitude = undefined;
        d.longitude = undefined;
      }
    }

    const ttl =
      response.degraded || response.rateLimitedCredentials.length > 0
        ? DEGRADED_TTL_MS
        : DASHBOARD_TTL_MS;
    // Re-seat TTL for degraded/limited payloads so the next request after the
    // cooldown expires rebuilds instead of serving stale data for another
    // status cycle. Skipped while a rebuild is already running — that entry
    // is the raw payload the rebuild will replace.
    if (ttl < DASHBOARD_TTL_MS && !rebuilding) {
      cacheSet(cacheKey, response, ttl);
    }

    // Always report the full status interval so the visible countdown is a
    // steady 10 minutes. (A "remaining cache window" countdown made the timer
    // shrink to 30s after rebuilds/rate-limit holds, which looked broken.)
    const nextUpdateInSeconds = DEVICE_STATUS_INTERVAL_SECONDS;

    return NextResponse.json({
      ...response,
      statusIntervalSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
      nextUpdateInSeconds,
      rebuilding,
      error: rebuildError || undefined,
    });
  } catch (error) {
    // Last-resort durable fallback — a 500 with nothing in it is what left the
    // dashboard empty after a failed rebuild. Answer with the last known
    // payload (if any) plus the error so the client keeps sites on screen and
    // shows the retry banner.
    if (userId && creds) {
      try {
        const durable = await durableLoad<DashboardPayload>(userId);
        if (durable) {
          const response = applyLiveRateLimits(durable.payload, creds);
          return NextResponse.json({
            ...response,
            statusIntervalSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
            nextUpdateInSeconds: REVALIDATE_POLL_SECONDS,
            rebuilding: true,
            error: error instanceof Error ? error.message : "Internal server error",
          });
        }
      } catch {
        // fall through to plain 500 below
      }
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

type CredentialRow = {
  id: string;
  name: string;
  app_id: string;
  secret: string;
  bootstrap_token: string | null;
  base_url: string | null;
  selected_group_ids: number[] | null;
  selected_received_group_ids: number[] | null;
  projects_cache?: unknown;
};

function toRuijieCreds(cred: CredentialRow): RuijieCredentials {
  return {
    appId: cred.app_id,
    secret: cred.secret,
    bootstrapToken: cred.bootstrap_token || undefined,
    baseUrl: cred.base_url || undefined,
  };
}

interface DashboardPayload {
  projects: ProjectWithDevices[];
  offlineDevices: OfflineDevice[];
  offlineSites: ProjectWithDevices[];
  rateLimitedCredentials: RateLimitedCredential[];
  degraded: boolean;
  /** Credential set the payload was built from — used to detect enable/disable changes. */
  credentialIds?: string[];
  /** When this payload was built — rotates the Telegram report claim each cycle. */
  builtAt?: number;
}

/** True when the payload's credential set is exactly the currently-enabled set. */
function credentialSetMatches(
  ids: string[] | undefined,
  creds: CredentialRow[]
): boolean {
  return (
    Array.isArray(ids) &&
    ids.length === creds.length &&
    creds.every((c) => ids.includes(c.id))
  );
}

/**
 * Merge in-memory cooldown state into a (possibly cached) dashboard payload
 * and hide projects for any credential that is currently limited.
 */
function applyLiveRateLimits(
  payload: DashboardPayload,
  creds: CredentialRow[]
): DashboardPayload {
  const rateLimitedCredentials: RateLimitedCredential[] = [];

  for (const cred of creds) {
    const status = getRateLimitStatus(toRuijieCreds(cred));
    if (status.limited) {
      rateLimitedCredentials.push({
        id: cred.id,
        name: cred.name,
        retryInSeconds: status.retryInSeconds,
      });
    }
  }

  // Prefer live cooldown; if none active, keep flags from a just-built payload
  // (15s TTL) so a limit hit during build is not lost on the next poll.
  const limitedCreds =
    rateLimitedCredentials.length > 0
      ? rateLimitedCredentials
      : (payload.rateLimitedCredentials || []);

  const limitedIds = new Set(limitedCreds.map((r) => r.id));
  // `creds` is the currently-enabled set — sites from a credential that has
  // since been disabled must not be served even from a stale cached payload.
  const activeIds = new Set(creds.map((c) => c.id));
  const visible = (credentialId?: string) =>
    activeIds.has(credentialId || "") && !limitedIds.has(credentialId || "");
  const projects = (payload.projects || []).filter((p) => visible(p.credentialId));
  const offlineDevices = (payload.offlineDevices || []).filter((d) =>
    visible(d.credentialId)
  );
  const offlineSites = (payload.offlineSites || []).filter((p) =>
    visible(p.credentialId)
  );

  return {
    ...payload,
    projects,
    offlineDevices,
    offlineSites,
    rateLimitedCredentials: limitedCreds,
    degraded: payload.degraded || limitedCreds.length > 0,
  };
}

async function buildDashboard(
  creds: CredentialRow[],
  opts?: { forceGeo?: boolean; prev?: DashboardPayload }
): Promise<DashboardPayload> {
    const allProjects: ProjectWithDevices[] = [];
    const allOfflineDevices: OfflineDevice[] = [];
    let degraded = false;
    // A fresh code 44 on the shared quota: stop calling Ruijie for the rest of
    // this build so the remaining credentials are not flagged as limited too.
    let quotaHit = false;
    const rateLimitedCredentials: RateLimitedCredential[] = [];

    const markLimited = (cred: CredentialRow, retryInSeconds: number) => {
      if (rateLimitedCredentials.some((r) => r.id === cred.id)) return;
      rateLimitedCredentials.push({
        id: cred.id,
        name: cred.name,
        retryInSeconds: Math.max(retryInSeconds, 1),
      });
      degraded = true;
    };

    // Flag every credential already in cooldown before any Ruijie call —
    // a rate limit hit during a previous request must show even if caches
    // would otherwise serve a full healthy payload.
    for (const cred of creds) {
      const status = getRateLimitStatus(toRuijieCreds(cred));
      if (status.limited) markLimited(cred, status.retryInSeconds);
    }

    const dropLimitedProjects = () => {
      const limitedIds = new Set(rateLimitedCredentials.map((r) => r.id));
      for (let i = allProjects.length - 1; i >= 0; i--) {
        if (limitedIds.has(allProjects[i].credentialId || "")) {
          allProjects.splice(i, 1);
        }
      }
      for (let i = allOfflineDevices.length - 1; i >= 0; i--) {
        if (limitedIds.has(allOfflineDevices[i].credentialId || "")) {
          allOfflineDevices.splice(i, 1);
        }
      }
    };

    // Shared sites live under a sharing credential that cannot read
    // `GET /group/{id}` (code 5). Seed coords from every owned tree first
    // so reverse-geocode still gets lat/lng when the owner is also linked.
    const ownedGeoByGroup = new Map<
      number,
      { latitude?: number; longitude?: number }
    >();
    const ownedGroupIds = new Set<number>();
    for (const cred of creds) {
      if (quotaHit) break;
      const credentials = toRuijieCreds(cred);
      if (getRateLimitStatus(credentials).limited) continue;
      try {
        for (const p of await getProjects(credentials)) {
          ownedGroupIds.add(p.groupId);
          if (p.latitude != null && p.longitude != null) {
            ownedGeoByGroup.set(p.groupId, {
              latitude: p.latitude,
              longitude: p.longitude,
            });
          }
        }
      } catch (e) {
        if (isRateLimitError(e)) {
          markLimited(cred, getRateLimitStatus(credentials).retryInSeconds || 30);
          quotaHit = true;
        }
        // Tree unavailable — per-credential getGroupGeo still runs below.
      }
    }

    // Fetch every credential's fleet before building rows. Shared/received
    // projects deny maint/devices (code 5) for the *receiving* credential, but
    // the owning credential's fleet carries the same groupId with real
    // onlineStatus + lastOnline — without this the offline panels show no time.
    const fleetByGroup = new Map<number, RuijieDevice[]>();
    const fleetByCred = new Map<string, RuijieDevice[]>();
    for (const cred of creds) {
      if (quotaHit) break;
      const credentials = toRuijieCreds(cred);
      if (getRateLimitStatus(credentials).limited) continue;
      let fleet: RuijieDevice[] = [];
      try {
        fleet = await getFleetDevices(credentials);
      } catch (e) {
        if (isRateLimitError(e)) {
          const st = getRateLimitStatus(credentials);
          markLimited(cred, st.retryInSeconds || 30);
          quotaHit = true;
          dropLimitedProjects();
          continue;
        }
        console.error("Fleet fetch failed, omitting device details:", e);
        fleet = [];
        degraded = true;
      }
      fleetByCred.set(cred.id, fleet);
      for (const d of fleet) {
        const list = fleetByGroup.get(d.groupId) || [];
        if (!list.some((x) => x.serialNumber === d.serialNumber)) list.push(d);
        fleetByGroup.set(d.groupId, list);
      }
    }

    // Lazy per-group warn logs — only fetched for shared projects that need
    // device identity. The global warnlog list is capped (5 pages), so groups
    // deep in history never appear in it; `group_id` scopes the query.
    // Reuse/refresh policy lives with the module-scope `warnLogsByGroup`.
    // `preferCredId` is the credential that received the project — it is the
    // one that can see its alarms, so it usually answers on the first try.
    const loadWarnLogsForGroup = async (
      groupId: number,
      offlineCount: number,
      preferCredId?: string
    ): Promise<RuijieWarnLog[]> => {
      const hit = warnLogsByGroup.get(groupId);
      if (
        hit &&
        hit.offlineCount === offlineCount &&
        Date.now() - hit.fetchedAt < WARN_LOG_MAX_AGE_MS
      ) {
        return hit.rows;
      }

      const ordered = preferCredId
        ? [
            ...creds.filter((c) => c.id === preferCredId),
            ...creds.filter((c) => c.id !== preferCredId),
          ]
        : creds;

      let rows: RuijieWarnLog[] = [];
      let answered = false;
      for (const c of ordered) {
        if (quotaHit) break;
        const credentials = toRuijieCreds(c);
        if (getRateLimitStatus(credentials).limited) continue;
        try {
          rows = await getWarnLogsForGroup(credentials, groupId);
          answered = true;
        } catch (e) {
          if (isRateLimitError(e)) {
            const st = getRateLimitStatus(credentials);
            markLimited(c, st.retryInSeconds || 30);
            quotaHit = true;
            continue;
          }
          continue; // try next credential
        }
        if (rows.length > 0) break;
      }

      // Only remember answers a credential actually gave — a rate-limited
      // build must not freeze empty rows in place of a future fetch.
      if (answered) {
        warnLogsByGroup.set(groupId, {
          rows,
          fetchedAt: Date.now(),
          offlineCount,
        });
      }
      return rows;
    };

    for (const cred of creds) {
      if (quotaHit) break;

      const credentials: RuijieCredentials = toRuijieCreds(cred);

      // Already cooling down — skip all Ruijie calls; hide this account's projects.
      const preStatus = getRateLimitStatus(credentials);
      if (preStatus.limited) {
        markLimited(cred, preStatus.retryInSeconds);
        continue;
      }

      // A credential with no owned projects and no shared projects selected
      // contributes nothing to the dashboard — never call Ruijie for it, so it
      // cannot be rate-limited (or drag the shared quota down) either.
      const ownedSel = cred.selected_group_ids as number[] | null;
      const receivedSel = cred.selected_received_group_ids as number[] | null;
      const skipOwned = Array.isArray(ownedSel) && ownedSel.length === 0;
      const skipReceived =
        Array.isArray(receivedSel) && receivedSel.length === 0;
      if (skipOwned && skipReceived) continue;

      // Fetch received/shared projects (1 API call, already has device counts).
      // Explicit empty selection owns no shared groups — skip the list call.
      try {
        const receivedAll = skipReceived
          ? []
          : await getReceivedProjects(credentials);
        // Shared selection: null = all, [] = none, array = specific IDs.
        const received = skipReceived
          ? []
          : receivedSel === null || receivedSel === undefined
            ? receivedAll
            : receivedAll.filter((rp) => receivedSel.includes(rp.groupId));
        for (const rp of received) {
          let onlineCount = 0;
          let offlineCount = 0;
          let totalCount = 0;
          for (const dt of rp.devTypeDetail || []) {
            onlineCount += dt.onCount;
            offlineCount += dt.offCount;
            totalCount += dt.totalCount;
          }
          // Fully recovered — drop the old rows so the next outage refetches
          // instead of matching the previous one's device identities.
          if (offlineCount === 0) warnLogsByGroup.delete(rp.groupId);

          // Shared projects deny maint/devices (code 5) — never call it.
          // Prefer the owning credential's fleet slice for this group (real
          // lastOnline / names / IPs); fall back to warn-log identity.
          let devices: RuijieDevice[] = [];
          let devicesFromWarnLog = false;
          if (offlineCount > 0) {
            devices = fleetByGroup.get(rp.groupId) || [];
            if (devices.length === 0) {
              const logs = await loadWarnLogsForGroup(
                rp.groupId,
                offlineCount,
                cred.id
              );
              devices = warnLogsToDevices(logs, rp.groupId, offlineCount);
              devicesFromWarnLog = devices.length > 0;
            }
          }

          // Warn-log rows are offline-only samples — keep aggregate counts
          // from devTypeDetail so online/total stay accurate.
          const resolvedOnline = devices.length > 0 && !devicesFromWarnLog
            ? devices.filter((d) => d.onlineStatus === "ON").length
            : devicesFromWarnLog
              ? Math.max(0, onlineCount)
              : onlineCount;
          const resolvedOffline = devices.length > 0 && !devicesFromWarnLog
            ? devices.filter((d) => d.onlineStatus !== "ON").length
            : offlineCount;
          const resolvedTotal = devices.length > 0 && !devicesFromWarnLog
            ? devices.length
            : totalCount;

          // Shared sites are not in this credential's tree — prefer coords
          // from the owning account's tree. Only ask group detail for groups
          // one of our credentials owns: for foreign shared groups the API
          // answers code 5, and repeating that per cycle burns rate limit.
          let receivedLat: number | undefined;
          let receivedLng: number | undefined;
          const ownedGeo = ownedGeoByGroup.get(rp.groupId);
          if (ownedGeo) {
            receivedLat = ownedGeo.latitude;
            receivedLng = ownedGeo.longitude;
          } else if (ownedGroupIds.has(rp.groupId)) {
            try {
              const geo = await getGroupGeo(credentials, rp.groupId);
              receivedLat = geo.latitude;
              receivedLng = geo.longitude;
            } catch {
              // coords optional — province falls back to Unknown
            }
          }

          allProjects.push({
            groupId: rp.groupId,
            name: rp.groupName,
            type: "RECEIVED",
            description: `Shared by ${rp.tenantName}`,
            businessType: rp.businessType,
            credentialId: cred.id,
            credentialName: cred.name,
            devices,
            onlineCount: resolvedOnline,
            offlineCount: resolvedOffline,
            totalCount: resolvedTotal,
            latitude: receivedLat,
            longitude: receivedLng,
          });

          // Use real device data for offline devices list
          if (devices.length > 0) {
            for (const device of devices) {
              if (device.onlineStatus !== "ON") {
                allOfflineDevices.push({
                  ...device,
                  credentialId: cred.id,
                  credentialName: cred.name,
                });
              }
            }
          } else if (resolvedOffline > 0) {
            // Shared projects: Ruijie Open API denies device-list access
            // (code 5) and warn log had no matching device rows — only
            // aggregate counts exist. Add a summary row so the Offline
            // Devices panel isn't empty while sites are offline.
            const breakdown = (rp.devTypeDetail || [])
              .filter((dt) => dt.offCount > 0)
              .map((dt) => `${dt.offCount}× ${dt.commonType || dt.productType}`)
              .join(", ");

            allOfflineDevices.push({
              serialNumber: `shared-summary-${rp.groupId}`,
              productClass: breakdown,
              productType: "",
              commonType: "",
              onlineStatus: "OFF",
              aliasName: rp.groupName,
              name: rp.groupName,
              localIp: "",
              cpeIp: "",
              mac: "",
              groupName: rp.groupName,
              parentGroupName: "",
              buildingId: rp.groupId,
              groupId: rp.groupId,
              lastOnline: 0,
              createTime: 0,
              staNums: 0,
              staActiveNums: 0,
              softwareVersion: "",
              credentialId: cred.id,
              credentialName: cred.name,
              detailsUnavailable: true,
              offlineCount: resolvedOffline,
            });
          }
        }
      } catch (e) {
        if (isRateLimitError(e)) {
          const st = getRateLimitStatus(credentials);
          markLimited(cred, st.retryInSeconds || 30);
          quotaHit = true;
          dropLimitedProjects();
          continue;
        }
        console.error("Failed to fetch received projects:", e);
        degraded = true;
      }

      // Owned projects: one paginated fleet fetch, then slice per group.
      // NEVER fall back to 130 per-project calls — that alone exceeds 5k/day.
      try {
        const allProjectsFromCred = await getProjects(credentials);
        const selectedIds = cred.selected_group_ids as number[] | null;
        // Leaf projects only — expand any legacy parent IDs to their leaves.
        // expandSelectionToLeaves returns null when every leaf is selected.
        let projects = allProjectsFromCred;
        if (selectedIds !== null) {
          // Live tree is ideal, but a cold start / transient failure must not
          // drop the credential's sites — fall back to the snapshot persisted
          // by Settings → Sync devices so the saved selection still applies.
          let tree: ProjectTreeNode[] | undefined;
          try {
            ({ tree } = await fetchProjectTree(credentials));
          } catch (treeErr) {
            if (isRateLimitError(treeErr)) throw treeErr;
            tree = parseProjectsCache(cred.projects_cache)?.tree;
          }
          if (!tree) {
            throw new Error("Project tree unavailable");
          }
          const expanded = expandSelectionToLeaves(tree, selectedIds);
          if (expanded === null) {
            projects = allProjectsFromCred;
          } else {
            const leafSelected = new Set(expanded);
            projects = allProjectsFromCred.filter((p) =>
              leafSelected.has(p.groupId)
            );
          }
        }

        // Fleet already fetched (and rate-limit checked) in the pre-pass.
        const fleet = fleetByCred.get(cred.id) || [];

        const byGroup = new Map<number, RuijieDevice[]>();
        for (const d of fleet) {
          const list = byGroup.get(d.groupId) || [];
          list.push(d);
          byGroup.set(d.groupId, list);
        }

        for (const project of projects) {
          const existing = allProjects.find(
            (p) => p.groupId === project.groupId
          );
          if (existing) {
            // Received row was added first under a sharing credential that
            // cannot read coords — backfill from the owning tree.
            if (existing.latitude == null && project.latitude != null) {
              existing.latitude = project.latitude;
              existing.longitude = project.longitude;
            }
            continue;
          }

          const devices = byGroup.get(project.groupId) || [];
          const onlineCount = devices.filter(
            (d) => d.onlineStatus === "ON"
          ).length;
          const offlineCount = devices.length - onlineCount;

          allProjects.push({
            ...project,
            credentialId: cred.id,
            credentialName: cred.name,
            devices,
            onlineCount,
            offlineCount,
            totalCount: devices.length,
          });

          for (const device of devices) {
            if (device.onlineStatus !== "ON") {
              allOfflineDevices.push({
                ...device,
                credentialId: cred.id,
                credentialName: cred.name,
              });
            }
          }
        }
      } catch (e) {
        if (isRateLimitError(e)) {
          const st = getRateLimitStatus(credentials);
          markLimited(cred, st.retryInSeconds || 30);
          quotaHit = true;
          dropLimitedProjects();
          continue;
        }
        console.error("Failed to fetch owned projects:", e);
        degraded = true;
      }
    }

    // Shared quota exhausted mid-build: stop here and hand back the previous
    // payload. The remaining credentials never got a 44 of their own, so they
    // are neither flagged nor hidden — their last known projects stay up.
    if (quotaHit && opts?.prev) return opts.prev;

    // Codes 44 can be swallowed by stale-on-error inside cacheFetch —
    // re-check every credential's cooldown so the banner still appears.
    for (const cred of creds) {
      const status = getRateLimitStatus(toRuijieCreds(cred));
      if (status.limited) markLimited(cred, status.retryInSeconds);
    }

    // Final pass — hide any leftover rows for credentials that hit their limit.
    dropLimitedProjects();

    // Reject bogus site coordinates (0,0, swapped lat/lng, foreign hits)
    // before they are plotted: clear them so the group-geo and name-geocode
    // passes below get a chance to place the site correctly.
    for (const p of allProjects) {
      if (
        p.latitude != null &&
        p.longitude != null &&
        !isValidSiteGeo(p.latitude, p.longitude)
      ) {
        p.latitude = undefined;
        p.longitude = undefined;
      }
    }

    // Last-chance coords for sites still missing lat/lng (e.g. shared from a
    // tenant we do not own and not present in any linked owned tree).
    // Budgeted: denied group-geo lookups must not stall Sync Data.
    // Manual Sync Data may spend longer — user is explicitly waiting.
    const lastChanceDeadline =
      Date.now() + (opts?.forceGeo ? 10_000 : 3000);
    for (const p of allProjects) {
      if (Date.now() > lastChanceDeadline) break;
      if (p.totalCount <= 0) continue;
      if (p.latitude != null && p.longitude != null) continue;
      // Group detail answers code 5 for shared groups we do not own; asking
      // for them every cycle spends rate limit on a guaranteed denial.
      if (!ownedGroupIds.has(p.groupId)) continue;
      for (const cred of creds) {
        if (Date.now() > lastChanceDeadline) break;
        const credentials = toRuijieCreds(cred);
        if (getRateLimitStatus(credentials).limited) continue;
        try {
          const geo = await getGroupGeo(credentials, p.groupId);
          if (isValidSiteGeo(geo.latitude, geo.longitude)) {
            p.latitude = geo.latitude;
            p.longitude = geo.longitude;
            break;
          }
        } catch {
          // try next credential
        }
      }
    }

    // Shared-from-external sites: Ruijie denies group geo for every linked
    // credential. Fall back to place-name geocode (municipality in site label).
    // Auto path stays short so polls do not hang; force Sync Data may take longer.
    const nameGeoDeadline = Date.now() + (opts?.forceGeo ? 45_000 : 5000);
    for (const p of allProjects) {
      if (Date.now() > nameGeoDeadline) break;
      if (p.totalCount <= 0) continue;
      if (p.latitude != null && p.longitude != null) continue;
      try {
        const named = await geocodeSiteName(p.name, p.groupId);
        if (named) {
          p.latitude = named.latitude;
          p.longitude = named.longitude;
        }
      } catch {
        // province stays Unknown
      }
    }

    // Resolve province from site lat/lng (leaf group tree). Failures → null.
    const geoByGroup = new Map<number, { latitude?: number; longitude?: number }>();
    for (const p of allProjects) {
      if (p.latitude != null && p.longitude != null) {
        geoByGroup.set(p.groupId, {
          latitude: p.latitude,
          longitude: p.longitude,
        });
      }
    }
    await Promise.all(
      allProjects.map(async (p) => {
        if (p.latitude == null || p.longitude == null) return;
        try {
          p.province = (await reverseGeocodeProvince(p.latitude, p.longitude)) || undefined;
        } catch {
          p.province = undefined;
        }
      })
    );
    // Offline devices inherit the site's coordinates/province for display.
    for (const d of allOfflineDevices) {
      const geo = geoByGroup.get(d.groupId);
      if (geo) {
        if (d.latitude == null) d.latitude = geo.latitude;
        if (d.longitude == null) d.longitude = geo.longitude;
      }
      const owner = allProjects.find((p) => p.groupId === d.groupId);
      if (owner?.province && !d.province) d.province = owner.province;
    }

    // Offline day / time: sites with readable devices take it from their
    // oldest device's lastOnline. Shared projects from tenants this account
    // cannot query expose only counts — device list → code 5, warn log →
    // empty — so fall back to the first build that observed the outage.
    // Persisted (24h freshness) so restarts and rate-limit holds don't reset
    // every shared site's offline-days clock.
    loadOutageStarts();
    const observedAt = Date.now();
    let outageDirty = false;
    for (const p of allProjects) {
      if (p.totalCount <= 0) continue;
      if (p.offlineCount <= 0) {
        if (outageStarts.delete(p.groupId)) outageDirty = true;
        continue;
      }
      const derived = oldestOfflineFromDevices(p.devices);
      if (derived > 0) {
        const known = outageStarts.get(p.groupId)?.startedAt;
        outageStarts.set(p.groupId, {
          startedAt: known && known < derived ? known : derived,
          lastSeenAt: observedAt,
        });
        p.oldestOffline = derived;
      } else {
        const known = outageStarts.get(p.groupId);
        const startedAt =
          known && observedAt - known.lastSeenAt < OUTAGE_ENTRY_MAX_AGE_MS
            ? known.startedAt
            : observedAt;
        outageStarts.set(p.groupId, { startedAt, lastSeenAt: observedAt });
        p.oldestOffline = startedAt;
      }
      outageDirty = true;
    }
    if (outageDirty) diskSet(OUTAGE_DISK_KEY, [...outageStarts]);

    // Aggregate-only shared rows inherit the site's outage start so the
    // Offline Devices panel shows offline days / exact time like real rows.
    for (const d of allOfflineDevices) {
      if (!d.detailsUnavailable || d.lastOnline > 0) continue;
      const owner = allProjects.find((p) => p.groupId === d.groupId);
      if (owner?.oldestOffline) d.lastOnline = owner.oldestOffline;
    }

    // Sites = only projects that actually have devices. Root/sub-root
    // containers, empty groups, and zero-count rows are never counted.
    const siteProjects = allProjects.filter((p) => p.totalCount > 0);

    // A site is offline only when it actually has offline devices.
    const offlineSites = siteProjects.filter((p) => p.offlineCount > 0);

    return {
      projects: siteProjects,
      offlineDevices: allOfflineDevices,
      offlineSites,
      rateLimitedCredentials,
      degraded,
      credentialIds: creds.map((c) => c.id),
      builtAt: Date.now(),
    };
}
