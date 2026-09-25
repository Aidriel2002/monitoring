"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { getSupabase } from "@/lib/supabase";
import {
  DASHBOARD_CHANNEL_PREFIX,
  DASHBOARD_EVENT,
} from "@/lib/realtime";

interface Project {
  groupId: number;
  name: string;
  type: string;
  description: string;
  businessType: string;
  credentialId?: string;
  credentialName?: string;
  devices: Device[];
  onlineCount: number;
  offlineCount: number;
  totalCount: number;
  latitude?: number;
  longitude?: number;
  province?: string;
}

interface Device {
  serialNumber: string;
  productClass: string;
  commonType: string;
  onlineStatus: string;
  aliasName: string;
  name: string;
  localIp: string;
  cpeIp: string;
  mac: string;
  groupName: string;
  lastOnline: number;
  staNums: number;
  credentialId?: string;
  credentialName?: string;
  detailsUnavailable?: boolean;
  offlineCount?: number;
  latitude?: number;
  longitude?: number;
  province?: string;
}

interface RateLimitedCredential {
  id: string;
  name: string;
  retryInSeconds: number;
}

function getGMT8Time(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " GMT+8";
}

function getGMT8Date(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}

const NEXT_REFRESH_KEY = "dashboard:nextRefreshAt";
const MANUAL_REFRESH_KEY = "dashboard:manualRefreshAt";
/** Fallback countdown (seconds) until the server reports statusIntervalSeconds. */
const DEFAULT_INTERVAL_SECONDS = 100 * 60;
/** Manual Sync Data / spam guard: at most one force sync per minute. */
const MANUAL_REFRESH_COOLDOWN_MS = 60_000;

function readNextRefreshAt(): number | null {
  try {
    const raw = sessionStorage.getItem(NEXT_REFRESH_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeNextRefreshAt(ts: number): void {
  try {
    sessionStorage.setItem(NEXT_REFRESH_KEY, String(ts));
  } catch {
    // ignore private-mode / quota errors
  }
}

function readManualRefreshAt(): number | null {
  try {
    const raw = sessionStorage.getItem(MANUAL_REFRESH_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeManualRefreshAt(ts: number): void {
  try {
    sessionStorage.setItem(MANUAL_REFRESH_KEY, String(ts));
  } catch {
    // ignore
  }
}

function secondsUntil(ts: number): number {
  return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
}

function formatDowntime(lastOnline: number): string {
  if (!lastOnline) return "";
  const ms = Date.now() - lastOnline;
  if (ms < 0) return "Just now";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

/** Whole days offline since `lastOnline` (0 = unknown / not offline). */
function offlineDays(lastOnline: number): number {
  if (!lastOnline) return 0;
  const ms = Date.now() - lastOnline;
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

/** Offline days count; falls back to a sub-day duration when under 1 day. */
function formatOfflineDays(lastOnline: number): string {
  if (!lastOnline) return "";
  const days = offlineDays(lastOnline);
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"} offline`;
  return formatDowntime(lastOnline);
}

/** Exact last-seen moment, GMT+8 — matches the header clock. */
function formatLastSeen(lastOnline: number): string {
  if (!lastOnline) return "";
  return (
    new Date(lastOnline).toLocaleString("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + " GMT+8"
  );
}

function getSiteOldestOffline(site: Project): number {
  // Ignore devices with unknown lastOnline (0) — one unknown must not hide
  // the known downtime of the rest of the site.
  const times = site.devices
    .filter((d) => d.onlineStatus !== "ON" && d.lastOnline > 0)
    .map((d) => d.lastOnline);
  if (times.length === 0) return 0;
  return Math.min(...times);
}

/** Stable background color for a province name (badge after site name). */
function provinceBadgeClass(province?: string): string {
  if (!province) return "bg-gray-200 text-gray-700";
  const palette = [
    "bg-blue-100 text-blue-800",
    "bg-emerald-100 text-emerald-800",
    "bg-violet-100 text-violet-800",
    "bg-amber-100 text-amber-800",
    "bg-rose-100 text-rose-800",
    "bg-cyan-100 text-cyan-800",
    "bg-indigo-100 text-indigo-800",
    "bg-teal-100 text-teal-800",
    "bg-fuchsia-100 text-fuchsia-800",
    "bg-lime-100 text-lime-800",
    "bg-orange-100 text-orange-800",
    "bg-sky-100 text-sky-800",
  ];
  let h = 0;
  for (let i = 0; i < province.length; i++) {
    h = (h * 31 + province.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length];
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [offlineDevices, setOfflineDevices] = useState<Device[]>([]);
  const [offlineSites, setOfflineSites] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  // SSR-safe defaults — restore sessionStorage only after mount (hydration).
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [currentTime, setCurrentTime] = useState("");
  const [currentDate, setCurrentDate] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  const [limitedCreds, setLimitedCreds] = useState<RateLimitedCredential[]>([]);
  const [refreshCountdown, setRefreshCountdown] = useState(
    DEFAULT_INTERVAL_SECONDS
  );
  const [authExpired, setAuthExpired] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [manualCooldown, setManualCooldown] = useState(0);
  const fetchAllRef = useRef<(force?: boolean) => void>(() => {});
  const inFlightRef = useRef(false);
  const debounceRef = useRef<number | undefined>(undefined);
  const profileRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<
    ReturnType<typeof getSupabase>["channel"]
  > | null>(null);
  const router = useRouter();

  const fetchAll = useCallback(async (force = false) => {
    // Idempotent: drop concurrent/spam force refreshes.
    if (force) {
      if (inFlightRef.current) return;
      const lastManual = readManualRefreshAt();
      if (lastManual && Date.now() - lastManual < MANUAL_REFRESH_COOLDOWN_MS) {
        return;
      }
      writeManualRefreshAt(Date.now());
      setRefreshing(true);
    } else if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;

    try {
      const dashRes = await authFetch(
        force ? "/api/dashboard?refresh=status" : "/api/dashboard"
      );

      if (dashRes.status === 401) {
        // Stay signed in — only log out when the user clicks Logout.
        setAuthExpired(true);
        return;
      }

      if (dashRes.status === 429) {
        setRateLimited(true);
        return;
      }

      setRateLimited(false);
      setAuthExpired(false);
      const dashData = await dashRes.json();

      setProjects(dashData.projects || []);
      setOfflineDevices(dashData.offlineDevices || []);
      setOfflineSites(dashData.offlineSites || []);
      setLimitedCreds(dashData.rateLimitedCredentials || []);

      const interval =
        typeof dashData.statusIntervalSeconds === "number"
          ? dashData.statusIntervalSeconds
          : DEFAULT_INTERVAL_SECONDS;
      const now = Date.now();
      let next = readNextRefreshAt();
      // Keep the running window across page switches unless forced or expired.
      if (force || !next || next <= now) {
        next = now + interval * 1000;
        writeNextRefreshAt(next);
      }
      setRefreshCountdown(secondsUntil(next));
      setLastRefresh(new Date(next - interval * 1000));
    } catch (error) {
      console.error("Error fetching dashboard:", error);
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllRef.current = fetchAll;
  }, [fetchAll]);

  // Restore the running update window after hydration (sessionStorage is client-only).
  useEffect(() => {
    const next = readNextRefreshAt();
    if (next && next > Date.now()) {
      setRefreshCountdown(secondsUntil(next));
      setLastRefresh(new Date(next - DEFAULT_INTERVAL_SECONDS * 1000));
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Auto status check every 100m (matches server status TTL).
    const poll = setInterval(() => fetchAll(), DEFAULT_INTERVAL_SECONDS * 1000);
    const whenDue = setInterval(() => {
      const next = readNextRefreshAt();
      if (next && next <= Date.now()) fetchAll();
    }, 1000);
    return () => {
      clearInterval(poll);
      clearInterval(whenDue);
    };
  }, [fetchAll]);

  // Supabase realtime — server/webhook pushes rebuilds so we don't poll harder.
  useEffect(() => {
    const supabase = getSupabase();
    let cancelled = false;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled || !user) return;

      const channel = supabase
        .channel(`${DASHBOARD_CHANNEL_PREFIX}${user.id}`)
        .on("broadcast", { event: DASHBOARD_EVENT }, () => {
          // Debounce bursts (multi-cred rebuild can emit more than once).
          window.clearTimeout(debounceRef.current);
          debounceRef.current = window.setTimeout(() => {
            fetchAllRef.current();
          }, 400);
        })
        .subscribe();

      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(debounceRef.current);
      const ch = channelRef.current;
      if (ch) {
        supabase.removeChannel(ch);
        channelRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(getGMT8Time());
      setCurrentDate(getGMT8Date());
    }, 1000);
    setCurrentTime(getGMT8Time());
    setCurrentDate(getGMT8Date());
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Tick from the persisted deadline so remount does not restart a full window.
    const timer = setInterval(() => {
      const next = readNextRefreshAt();
      if (!next) return;
      setRefreshCountdown(secondsUntil(next));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Manual-refresh cooldown ticker (1/minute spam guard).
  useEffect(() => {
    const tick = () => {
      const last = readManualRefreshAt();
      if (!last) {
        setManualCooldown(0);
        return;
      }
      const remain = Math.ceil(
        (MANUAL_REFRESH_COOLDOWN_MS - (Date.now() - last)) / 1000
      );
      setManualCooldown(remain > 0 ? remain : 0);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const refreshDisabled = refreshing || loading || manualCooldown > 0;

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Sort offline devices: offline days count descending, unknown last
  const sortedOfflineDevices = useMemo(() => {
    return [...offlineDevices].sort((a, b) => {
      const aDays = offlineDays(a.lastOnline);
      const bDays = offlineDays(b.lastOnline);
      if (aDays !== bDays) return bDays - aDays;
      if (!a.lastOnline && !b.lastOnline) return 0;
      if (!a.lastOnline) return 1;
      if (!b.lastOnline) return -1;
      return a.lastOnline - b.lastOnline;
    });
  }, [offlineDevices]);

  // Sort offline sites: offline days count descending (longest offline first), unknown last
  const sortedOfflineSites = useMemo(() => {
    return [...offlineSites].sort((a, b) => {
      const aDays = offlineDays(getSiteOldestOffline(a));
      const bDays = offlineDays(getSiteOldestOffline(b));
      if (aDays !== bDays) return bDays - aDays;
      const aOldest = getSiteOldestOffline(a);
      const bOldest = getSiteOldestOffline(b);
      if (!aOldest && !bOldest) return 0;
      if (!aOldest) return 1;
      if (!bOldest) return -1;
      return aOldest - bOldest;
    });
  }, [offlineSites]);

  const totalDevices = projects.reduce((sum, p) => sum + p.totalCount, 0);
  const totalOnline = projects.reduce((sum, p) => sum + p.onlineCount, 0);
  const totalOffline = projects.reduce((sum, p) => sum + p.offlineCount, 0);

  // Offline sites known from aggregate counts but without per-device details
  // (e.g. shared-project device list unavailable). Never claim "all online" then.
  const offlineWithoutDetails = offlineSites.some(
    (s) =>
      s.offlineCount > 0 &&
      !s.devices.some((d) => d.onlineStatus !== "ON")
  );

  return (
    <div className="h-screen w-screen bg-gray-50 p-6 overflow-auto">
      <div className="w-full">
        <header className="mb-6 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">MULTIFACTORS SALES MONITORING</h1>
            <p className="text-sm text-gray-500 mt-1 flex items-center gap-2">
              <span>{currentDate}</span>
              <span className="font-mono text-gray-600">{currentTime}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-xs text-gray-400">
                Updating in: {Math.floor(refreshCountdown / 60)}:
                {String(refreshCountdown % 60).padStart(2, "0")}
              </span>
            )}
            <button
              onClick={() => fetchAll(true)}
              disabled={refreshDisabled}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {refreshing ? (
                <>
                  <svg
                    className="animate-spin h-4 w-4 text-gray-500"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  Syncing...
                </>
              ) : manualCooldown > 0 ? (
                `Sync Data (${manualCooldown}s)`
              ) : (
                "Sync Data"
              )}
            </button>
            <button
              onClick={() => router.push("/sites")}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-blue-600 rounded-md hover:bg-blue-700"
            >
              All Sites
            </button>
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen((o) => !o)}
                aria-label="Profile menu"
                className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 w-44 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1">
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      router.push("/settings");
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Settings
                  </button>
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      handleLogout();
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {authExpired && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
            <p className="text-red-800 font-medium">
              Your session has expired. You stay signed in until you log out.
            </p>
            <button
              onClick={() => router.push("/login")}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 shrink-0 ml-4"
            >
              Log in again
            </button>
          </div>
        )}

        {rateLimited && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-yellow-800 font-medium">Rate limited by Ruijie API</p>
            <p className="text-yellow-700 text-sm">
              Auto-refresh paused. Wait a few minutes then click Sync Data.
            </p>
          </div>
        )}

        {limitedCreds.length > 0 && (
          <div className="mb-6 bg-orange-50 border border-orange-200 rounded-lg p-4">
            <p className="text-orange-800 font-medium">
              Credential limit reached — projects hidden
            </p>
            <ul className="mt-2 space-y-1">
              {limitedCreds.map((c) => (
                <li key={c.id} className="text-sm text-orange-700">
                  <span className="font-semibold">{c.name}</span> reached its
                  API limit
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium text-gray-500">Sites</h3>
            <p className="text-2xl font-bold text-blue-600">{projects.length}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium text-gray-500">Total Devices</h3>
            <p className="text-2xl font-bold text-purple-600">{totalDevices}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium text-gray-500">Online</h3>
            <p className="text-2xl font-bold text-green-600">{totalOnline}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium text-gray-500">Offline</h3>
            <p className="text-2xl font-bold text-red-600">{totalOffline}</p>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
            Loading dashboard data...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-6">
              {/* Offline Sites */}
              <div className="lg:col-span-3 bg-white rounded-lg shadow flex flex-col">
                <div className="p-4 border-b border-gray-200">
                  <h2 className="text-lg font-semibold text-gray-900">
                    Offline Sites
                    <span className="ml-2 text-sm font-normal text-red-600">
                      ({sortedOfflineSites.length})
                    </span>
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Sorted by offline days (descending)
                  </p>
                </div>
                <div className="divide-y divide-gray-200 overflow-y-auto max-h-[450px]">
                  {sortedOfflineSites.length === 0 ? (
                    <div className="p-12 text-center text-green-600">
                      All sites have online devices!
                    </div>
                  ) : (
                    sortedOfflineSites.map((site) => {
                      const oldest = getSiteOldestOffline(site);
                      return (
                        <div
                          key={`${site.credentialId}-${site.groupId}`}
                          className="p-3 hover:bg-gray-50"
                        >
                          <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="font-medium text-gray-900 text-sm truncate">
                                  {site.name}
                                </h3>
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${provinceBadgeClass(site.province)}`}
                                >
                                  {site.province || "Unknown"}
                                </span>
                              </div>
                              <p className="text-xs text-gray-500 mt-0.5">
                                ID: {site.groupId}
                                {site.latitude != null &&
                                  site.longitude != null &&
                                  ` · ${site.latitude.toFixed(4)}, ${site.longitude.toFixed(4)}`}
                              </p>
                              {site.credentialName && (
                                <p className="text-xs text-blue-500 mt-0.5">
                                  {site.credentialName}
                                </p>
                              )}
                            </div>
                            <div className="text-right ml-3 shrink-0">
                              <p className="text-red-600 font-semibold text-sm">
                                {site.offlineCount} off
                              </p>
                              {site.onlineCount > 0 && (
                                <p className="text-green-600 text-sm">
                                  {site.onlineCount} on
                                </p>
                              )}
                              {oldest > 0 && (
                                <>
                                  <p className="text-[11px] font-semibold text-orange-700 mt-0.5">
                                    {formatOfflineDays(oldest)}
                                  </p>
                                  <p className="text-[10px] text-orange-600/80 leading-tight">
                                    since {formatLastSeen(oldest)}
                                  </p>
                                </>
                              )}
                              {site.totalCount === 0 && (
                                <p className="text-[10px] text-orange-500">No devices</p>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Offline Devices */}
              <div className="lg:col-span-2 bg-white rounded-lg shadow flex flex-col">
                <div className="p-4 border-b border-gray-200">
                  <h2 className="text-lg font-semibold text-gray-900">
                    Offline Devices
                    <span className="ml-2 text-sm font-normal text-red-600">
                      ({totalOffline})
                    </span>
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Sorted by offline days (descending)
                  </p>
                </div>
                <div className="divide-y divide-gray-200 overflow-y-auto max-h-[450px]">
                  {sortedOfflineDevices.length === 0 && !offlineWithoutDetails && (
                    <div className="p-12 text-center text-green-600">
                      All devices are online!
                    </div>
                  )}
                  {offlineWithoutDetails && (
                    <div className="p-3 text-center text-sm text-orange-700 bg-orange-50">
                      Some offline sites report offline devices, but device
                      details are unavailable.
                    </div>
                  )}
                  {sortedOfflineDevices.map((device) => (
                      <div
                        key={`${device.credentialName}-${device.serialNumber}`}
                        className="p-3 hover:bg-gray-50"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
                              device.detailsUnavailable
                                ? "bg-orange-100 text-orange-800"
                                : "bg-red-100 text-red-800"
                            }`}
                          >
                            {device.detailsUnavailable
                              ? `${device.offlineCount ?? "?"} off`
                              : "OFF"}
                          </span>
                          <div className="min-w-0 flex-1">
                            <h3 className="font-medium text-gray-900 text-sm truncate">
                              {device.aliasName || device.name || device.productClass}
                            </h3>
                            <p className="text-xs text-gray-500 truncate">
                              {device.detailsUnavailable ? (
                                <>
                                  {device.productClass &&
                                    `${device.productClass} · `}
                                  details unavailable
                                </>
                              ) : (
                                <>
                                  {device.productClass}
                                  {device.serialNumber &&
                                    ` · ${device.serialNumber}`}
                                  {(device.localIp || device.cpeIp) &&
                                    ` · ${device.localIp || device.cpeIp}`}
                                </>
                              )}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                              {device.groupName}
                              {device.credentialName && ` (${device.credentialName})`}
                            </p>
                            {(device.latitude != null || device.province) && (
                              <p className="text-[10px] text-gray-400 truncate">
                                {device.province}
                                {device.latitude != null &&
                                  device.longitude != null &&
                                  ` · ${device.latitude.toFixed(4)}, ${device.longitude.toFixed(4)}`}
                              </p>
                            )}
                          </div>
                          {!device.detailsUnavailable && device.lastOnline > 0 && (
                            <div className="text-right shrink-0 max-w-[10.5rem]">
                              <span className="block text-[11px] text-orange-700 font-semibold">
                                {formatOfflineDays(device.lastOnline)}
                              </span>
                              <span className="block text-[10px] text-orange-600/80 leading-tight">
                                {formatLastSeen(device.lastOnline)}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
