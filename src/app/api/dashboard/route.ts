import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheFetch, cacheClear, cacheGet, cacheSet } from "@/lib/cache";
import { diskGet, diskSet } from "@/lib/disk-cache";
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
} from "@/lib/ruijie";
import { reverseGeocodeProvince, geocodeSiteName, isValidSiteGeo } from "@/lib/geo";
import { broadcastDashboardUpdate } from "@/lib/realtime";
import { processTelegramInbox, sendOfflineReports } from "@/lib/notify";

/** Healthy payload matches the 100m status cycle; limited/degraded re-seat to 15s. */
const DASHBOARD_TTL_MS = DEVICE_STATUS_INTERVAL_SECONDS * 1000;

/**
 * Warn-log rows are reused between cycles while a group's offline count is
 * unchanged; this caps how stale a quiet group's device identities may get.
 */
const WARN_LOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Cross-build warn-log store (module scope — must outlive a single request).
 * Without it every 100-minute rebuild re-queried every offline shared group
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

export async function GET(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabaseServiceRole();
    const { data: creds, error: credsError } = await supabase
      .from("api_credentials")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true);

    if (credsError) {
      return NextResponse.json({ error: credsError.message }, { status: 500 });
    }

    if (!creds || creds.length === 0) {
      return NextResponse.json({
        projects: [],
        offlineDevices: [],
        offlineSites: [],
        rateLimitedCredentials: [],
        statusIntervalSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
      });
    }

    const cacheKey = `dashboard:${user.id}`;
    // Every credential in this account shares one Ruijie quota (same bootstrap
    // key, same source IP): once one of them returns code 44, calling the
    // others only earns code 44 for them too — which is how all of them ended
    // up flagged at once. While a cooldown is active, hold the rebuild: the
    // last payload keeps every other credential's projects on screen and only
    // the credential that actually hit the limit is reported.
    const coolingCred = creds.some((cred) =>
      getRateLimitStatus(toRuijieCreds(cred)).limited
    );
    // Read before any cacheClear below so a forced rebuild can still fall back
    // to the previous payload if the shared quota runs out mid-build.
    const cached = cacheGet<DashboardPayload>(cacheKey);

    // Refresh button: reset the 100m status window and rebuild immediately.
    // Not while cooling down — there is nothing to refresh, the calls would
    // only earn more code 44s (Sync Data falls back to the last payload).
    const forceStatus =
      new URL(request.url).searchParams.get("refresh") === "status" &&
      !coolingCred;
    if (forceStatus) {
      for (const cred of creds) {
        invalidateDeviceStatus({
          appId: cred.app_id,
          secret: cred.secret,
          bootstrapToken: cred.bootstrap_token || undefined,
          baseUrl: cred.base_url || undefined,
        });
      }
      cacheClear(cacheKey);
    }

    // One shared payload per user — concurrent tab polls hit memory, not Ruijie.
    // Degraded / rate-limited results get a short TTL so they self-heal.
    const payload =
      coolingCred && cached
        ? cached
        : await cacheFetch(cacheKey, DASHBOARD_TTL_MS, async () => {
            const built = await buildDashboard(creds, {
              forceGeo: forceStatus,
              prev: cached,
            });
            // Push fresh data (and limit flags) to open dashboards without waiting
            // for the client's poll — realtime costs no Ruijie quota. Awaited so
            // serverless hosts (Netlify) don't freeze it after the response.
            await broadcastDashboardUpdate(user.id, {
              rateLimitedCredentials: built.rateLimitedCredentials,
              degraded: built.degraded,
            });
            // Telegram outage report to contact incharges — runs only on fresh
            // rebuilds: the 100-min TTL expiry and manual Sync Data. Awaited
            // (bounded by Telegram timeouts) so serverless hosts cannot kill
            // it after the response is written.
            await sendOfflineReports(user.id, built).catch((e) =>
              console.warn(
                "Offline notifications failed:",
                e instanceof Error ? e.message : e
              )
            );
            return built;
          });

    // Overlay live cooldown state on every response — even when the dashboard
    // cache still holds a "healthy" payload from before code 44.
    const response = applyLiveRateLimits(payload, creds);

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
        ? 15_000
        : DASHBOARD_TTL_MS;
    // Re-seat TTL for degraded/limited payloads (cacheFetch already stored full TTL)
    // — also while holding the rebuild, so the next request after the cooldown
    // expires rebuilds instead of serving stale data for another status cycle.
    if (ttl < DASHBOARD_TTL_MS) {
      cacheSet(cacheKey, response, ttl);
    }

    // Bot inbox housekeeping: link phone numbers and reply to new chats so
    // the bot responds within ~a minute of being messaged. Throttled inside
    // (one scan per minute). Awaited (not fire-and-forget) so serverless
    // hosts don't freeze it after the response is written; the throttle
    // keeps the extra latency to ~one scan per minute per instance.
    await processTelegramInbox().catch(() => undefined);

    return NextResponse.json({
      ...response,
      statusIntervalSeconds: DEVICE_STATUS_INTERVAL_SECONDS,
    });
  } catch (error) {
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
  const projects = (payload.projects || []).filter(
    (p) => !limitedIds.has(p.credentialId || "")
  );
  const offlineDevices = (payload.offlineDevices || []).filter(
    (d) => !limitedIds.has(d.credentialId || "")
  );
  const offlineSites = (payload.offlineSites || []).filter(
    (p) => !limitedIds.has(p.credentialId || "")
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
          const { tree } = await fetchProjectTree(credentials);
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
    };
}
