import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheFetch, cacheClear } from "@/lib/cache";
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
import { reverseGeocodeProvince, geocodeSiteName } from "@/lib/geo";
import { broadcastDashboardUpdate } from "@/lib/realtime";

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

    // Refresh button: reset the 100m status window and rebuild immediately.
    const forceStatus =
      new URL(request.url).searchParams.get("refresh") === "status";
    if (forceStatus) {
      for (const cred of creds) {
        invalidateDeviceStatus({
          appId: cred.app_id,
          secret: cred.secret,
          bootstrapToken: cred.bootstrap_token || undefined,
          baseUrl: cred.base_url || undefined,
        });
      }
      cacheClear(`dashboard:${user.id}`);
    }

    // One shared payload per user — concurrent tab polls hit memory, not Ruijie.
    // Degraded / rate-limited results get a short TTL so they self-heal.
    const payload = await cacheFetch(
      `dashboard:${user.id}`,
      DASHBOARD_TTL_MS,
      async () => {
        const built = await buildDashboard(creds, { forceGeo: forceStatus });
        // Push fresh data (and limit flags) to open dashboards without waiting
        // for the client's poll — realtime costs no Ruijie quota.
        void broadcastDashboardUpdate(user.id, {
          rateLimitedCredentials: built.rateLimitedCredentials,
          degraded: built.degraded,
        });
        return built;
      }
    );

    // Overlay live cooldown state on every response — even when the dashboard
    // cache still holds a "healthy" payload from before code 44.
    const response = applyLiveRateLimits(payload, creds);

    const ttl =
      response.degraded || response.rateLimitedCredentials.length > 0
        ? 15_000
        : DASHBOARD_TTL_MS;
    // Re-seat TTL for degraded/limited payloads (cacheFetch already stored full TTL).
    if (ttl < DASHBOARD_TTL_MS) {
      const { cacheSet } = await import("@/lib/cache");
      cacheSet(`dashboard:${user.id}`, response, ttl);
    }

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

type DashboardPayload = Awaited<ReturnType<typeof buildDashboard>>;

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
    const status = getRateLimitStatus({
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    });
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
  opts?: { forceGeo?: boolean }
) {
    const allProjects: ProjectWithDevices[] = [];
    const allOfflineDevices: OfflineDevice[] = [];
    let degraded = false;
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
      const status = getRateLimitStatus({
        appId: cred.app_id,
        secret: cred.secret,
        bootstrapToken: cred.bootstrap_token || undefined,
        baseUrl: cred.base_url || undefined,
      });
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

    const toRuijieCreds = (cred: CredentialRow): RuijieCredentials => ({
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    });

    // Shared sites live under a sharing credential that cannot read
    // `GET /group/{id}` (code 5). Seed coords from every owned tree first
    // so reverse-geocode still gets lat/lng when the owner is also linked.
    const ownedGeoByGroup = new Map<
      number,
      { latitude?: number; longitude?: number }
    >();
    const ownedGroupIds = new Set<number>();
    for (const cred of creds) {
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
      const credentials = toRuijieCreds(cred);
      if (getRateLimitStatus(credentials).limited) continue;
      let fleet: RuijieDevice[] = [];
      try {
        fleet = await getFleetDevices(credentials);
      } catch (e) {
        if (isRateLimitError(e)) {
          const st = getRateLimitStatus(credentials);
          markLimited(cred, st.retryInSeconds || 30);
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
    const loadWarnLogsForGroup = async (
      groupId: number,
      offlineCount: number
    ): Promise<RuijieWarnLog[]> => {
      const hit = warnLogsByGroup.get(groupId);
      if (
        hit &&
        hit.offlineCount === offlineCount &&
        Date.now() - hit.fetchedAt < WARN_LOG_MAX_AGE_MS
      ) {
        return hit.rows;
      }

      let rows: RuijieWarnLog[] = [];
      let answered = false;
      for (const c of creds) {
        const credentials = toRuijieCreds(c);
        if (getRateLimitStatus(credentials).limited) continue;
        try {
          rows = await getWarnLogsForGroup(credentials, groupId);
          answered = true;
        } catch (e) {
          if (isRateLimitError(e)) {
            const st = getRateLimitStatus(credentials);
            markLimited(c, st.retryInSeconds || 30);
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
      const credentials: RuijieCredentials = {
        appId: cred.app_id,
        secret: cred.secret,
        bootstrapToken: cred.bootstrap_token || undefined,
        baseUrl: cred.base_url || undefined,
      };

      // Already cooling down — skip all Ruijie calls; hide this account's projects.
      const preStatus = getRateLimitStatus(credentials);
      if (preStatus.limited) {
        markLimited(cred, preStatus.retryInSeconds);
        continue;
      }

      // Fetch received/shared projects (1 API call, already has device counts).
      // Explicit empty selection owns no shared groups — skip the list call.
      const receivedSel = cred.selected_received_group_ids as number[] | null;
      const skipReceived =
        Array.isArray(receivedSel) && receivedSel.length === 0;
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
              const logs = await loadWarnLogsForGroup(rp.groupId, offlineCount);
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
          dropLimitedProjects();
          continue;
        }
        console.error("Failed to fetch owned projects:", e);
        degraded = true;
      }
    }

    // Codes 44 can be swallowed by stale-on-error inside cacheFetch —
    // re-check every credential's cooldown so the banner still appears.
    for (const cred of creds) {
      const status = getRateLimitStatus({
        appId: cred.app_id,
        secret: cred.secret,
        bootstrapToken: cred.bootstrap_token || undefined,
        baseUrl: cred.base_url || undefined,
      });
      if (status.limited) markLimited(cred, status.retryInSeconds);
    }

    // Final pass — hide any leftover rows for credentials that hit their limit.
    dropLimitedProjects();

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
          if (geo.latitude != null && geo.longitude != null) {
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
