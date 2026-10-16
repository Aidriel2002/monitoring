"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { getSupabase } from "@/lib/supabase";
import DashboardMap, { MapSite } from "@/components/DashboardMap";
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
  /** Server-side outage start — used when device history is unavailable. */
  oldestOffline?: number;
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

/** v2: versioned so a window saved by the old 100-min build is ignored. */
const NEXT_REFRESH_KEY = "dashboard:nextRefreshAt:v2";
const MANUAL_REFRESH_KEY = "dashboard:manualRefreshAt";
/** Fallback countdown (seconds) until the server reports statusIntervalSeconds. */
const DEFAULT_INTERVAL_SECONDS = 10 * 60;
/** Re-check while a credential is cooling down — server answers from cache. */
const FAST_POLL_SECONDS = 60;
/** Manual Sync Data / spam guard: at most one force sync per minute. */
const MANUAL_REFRESH_COOLDOWN_MS = 60_000;
/** Sync-finished alarm: keep beeping for 8 seconds after the cycle ends. */
const BEEP_DURATION_MS = 8_000;
/** Pause between beeps inside the alarm window. */
const BEEP_REPEAT_MS = 2_000;
/**
 * After a failed sync, park the deadline this far out: the visible countdown
 * shows the retry window and `whenDue` re-fires exactly then — instead of the
 * failure leaving no deadline at all (no countdown, no data, no retry for a
 * full status cycle). Escalates 15 → 30 → 60 on consecutive failures so a
 * hard-down API is not hammered at full speed.
 */
const SYNC_RETRY_BACKOFF_SECONDS = [15, 30, 60] as const;
/** Fetch timeout for /api/dashboard (server may take ~20s on a cold build). */
const DASHBOARD_FETCH_TIMEOUT_MS = 45_000;

let audioCtx: AudioContext | null = null;

/** Short "beep beep" via Web Audio — no audio asset needed. */
function playBeep(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const start = audioCtx.currentTime + 0.02;
    for (let i = 0; i < 2; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      const t = start + i * 0.25;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    }
  } catch {
    // Autoplay policies may block audio until the first user gesture.
  }
}

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

/** Compact last-seen moment for list rows (no timezone suffix). */
function formatLastSeenShort(lastOnline: number): string {
  if (!lastOnline) return "";
  return new Date(lastOnline).toLocaleString("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** Accent color for an outage: red (long) → orange → amber (recent). */
function outageSeverity(days: number): { border: string; text: string } {
  if (!days) return { border: "border-gray-300", text: "text-gray-500" };
  if (days >= 90) return { border: "border-red-500", text: "text-red-600" };
  if (days >= 30) return { border: "border-orange-400", text: "text-orange-500" };
  return { border: "border-amber-400", text: "text-amber-600" };
}

/** Scroll speed for the auto-scrolling offline lists (ms per 1px step). */
const AUTO_SCROLL_INTERVAL_MS = 50;
/** How long the auto-scroll rests after wrapping to the top. */
const AUTO_SCROLL_PAUSE_MS = 3_000;

/**
 * Continuously scroll a list down 1px at a time; when it reaches the bottom
 * it jumps back to the top, rests for 3 seconds, then keeps scrolling.
 * Manual scrolling (wheel, touch, scrollbar drag) also pauses it for
 * 3 seconds so the user can read.
 */
function useAutoScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let pausedUntil = 0;
    let lastSetTop = el.scrollTop;

    // Any scroll we didn't cause ourselves is a user interaction.
    const onScroll = () => {
      if (Math.abs(el.scrollTop - lastSetTop) > 2) {
        pausedUntil = Date.now() + AUTO_SCROLL_PAUSE_MS;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const id = window.setInterval(() => {
      if (Date.now() < pausedUntil) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 1) return; // nothing to overflow-scroll
      const next = el.scrollTop + 1;
      if (next >= max) {
        lastSetTop = 0;
        el.scrollTo(0, 0); // reached bottom → loop to top
        pausedUntil = Date.now() + AUTO_SCROLL_PAUSE_MS; // rest before resuming
        return;
      }
      lastSetTop = next;
      el.scrollTo(0, next);
    }, AUTO_SCROLL_INTERVAL_MS);

    return () => {
      window.clearInterval(id);
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref]);
}

function getSiteOldestOffline(site: Project): number {
  // Ignore devices with unknown lastOnline (0) — one unknown must not hide
  // the known downtime of the rest of the site.
  const times = site.devices
    .filter((d) => d.onlineStatus !== "ON" && d.lastOnline > 0)
    .map((d) => d.lastOnline);
  const fromDevices = times.length > 0 ? Math.min(...times) : 0;
  // Shared projects whose device history is denied still carry the outage
  // start the server tracked from aggregate counts.
  const tracked = site.oldestOffline || 0;
  // Prefer the older of the two: the server tracks the CONTINUOUS outage
  // start across device reboots (a rebooted device's lastOnline moves
  // forward), while the device rows only show the current slice.
  if (tracked > 0 && fromDevices > 0) return Math.min(tracked, fromDevices);
  return tracked > 0 ? tracked : fromDevices;
}

/** Count offline sites per label (province / credential), count-descending. */
function groupOfflineSites(
  sites: Project[],
  key: (site: Project) => string
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const k = key(site);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Stable badge style for a province name (bordered pill, light mode). */
function provinceBadgeClass(province?: string): string {
  if (!province) return "border border-gray-300 bg-gray-100 text-gray-600";
  return "border border-emerald-300 bg-emerald-50 text-emerald-700";
}

/** Region X (Northern Mindanao) provinces the map tour may visit. */
const REGION_10_PROVINCES = new Set([
  "bukidnon",
  "camiguin",
  "lanao del norte",
  "misamis occidental",
  "misamis oriental",
]);

/** Loose Region 10 bounding box (south, west, north, east). */
const REGION_10_BBOX: [number, number, number, number] = [7.0, 123.0, 9.6, 126.0];

/** True only for sites inside Region 10; uses coords when province is unknown. */
function isInRegion10(
  province?: string,
  latitude?: number,
  longitude?: number
): boolean {
  if (province) {
    const p = province.split(",")[0].trim().toLowerCase();
    // A present province that is not Region 10 is authoritative (no bbox
    // fallback), so nearby regions like Davao/Surigao can never slip in.
    return (
      REGION_10_PROVINCES.has(p) ||
      p.startsWith("misamis") ||
      p === "northern mindanao" ||
      p === "region x" ||
      p === "region 10"
    );
  }
  if (latitude == null || longitude == null) return false;
  return (
    latitude >= REGION_10_BBOX[0] &&
    longitude >= REGION_10_BBOX[1] &&
    latitude <= REGION_10_BBOX[2] &&
    longitude <= REGION_10_BBOX[3]
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [offlineDevices, setOfflineDevices] = useState<Device[]>([]);
  const [offlineSites, setOfflineSites] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  // SSR-safe defaults — restore sessionStorage only after mount (hydration).
  const [currentTime, setCurrentTime] = useState("");
  const [currentDate, setCurrentDate] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  const [limitedCreds, setLimitedCreds] = useState<RateLimitedCredential[]>([]);
  const [refreshCountdown, setRefreshCountdown] = useState(
    DEFAULT_INTERVAL_SECONDS
  );
  const [syncFailed, setSyncFailed] = useState(false);
  /** Consecutive failed syncs — drives the escalating retry backoff. */
  const [failCount, setFailCount] = useState(0);
  const [authExpired, setAuthExpired] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [manualCooldown, setManualCooldown] = useState(0);
  const fetchAllRef = useRef<(force?: boolean) => void>(() => {});
  const inFlightRef = useRef(false);
  // Mirror of syncFailed for the countdown-tick effect (no stale closure).
  const syncFailedRef = useRef(false);
  // Mirror of failCount for the retry-backoff calculation (no stale closure).
  const failCountRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);
  const profileRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<
    ReturnType<typeof getSupabase>["channel"]
  > | null>(null);
  const router = useRouter();

  // Sync-finished alarm state: beep every few seconds until the deadline.
  const beepUntilRef = useRef(0);
  const beepTimerRef = useRef<number | undefined>(undefined);
  const prevCountdownRef = useRef<number | null>(null);

  const stopBeeping = useCallback(() => {
    if (beepTimerRef.current) {
      window.clearInterval(beepTimerRef.current);
      beepTimerRef.current = undefined;
    }
    beepUntilRef.current = 0;
  }, []);

  const startBeepSession = useCallback(() => {
    beepUntilRef.current = Date.now() + BEEP_DURATION_MS;
    playBeep();
    if (beepTimerRef.current) return;
    beepTimerRef.current = window.setInterval(() => {
      if (Date.now() >= beepUntilRef.current) {
        stopBeeping();
        return;
      }
      playBeep();
    }, BEEP_REPEAT_MS);
  }, [stopBeeping]);

  // Cleanup any beeping on unmount.
  useEffect(() => stopBeeping, [stopBeeping]);

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
      stopBeeping(); // manual sync acknowledges the alarm
    } else if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;

    // Park the update window on a short retry: keeps the visible countdown
    // ticking and makes whenDue re-fire soon instead of leaving no deadline
    // (which hid the countdown and skipped retries until the next poll).
    // Escalates on consecutive failures so a hard-down API is not hammered.
    const parkRetry = (fail = true) => {
      if (fail) {
        failCountRef.current += 1;
        setFailCount(failCountRef.current);
      }
      setSyncFailed(fail);
      const backoff =
        SYNC_RETRY_BACKOFF_SECONDS[
          Math.min(failCountRef.current - 1, SYNC_RETRY_BACKOFF_SECONDS.length - 1)
        ] ?? SYNC_RETRY_BACKOFF_SECONDS[0];
      const retryAt = Date.now() + backoff * 1000;
      writeNextRefreshAt(retryAt);
      setRefreshCountdown(backoff);
    };

    try {
      const dashRes = await authFetch(
        force ? "/api/dashboard?refresh=status" : "/api/dashboard",
        { signal: AbortSignal.timeout(DASHBOARD_FETCH_TIMEOUT_MS) }
      );

      if (dashRes.status === 401) {
        // Stay signed in — only log out when the user clicks Logout.
        setAuthExpired(true);
        parkRetry();
        return;
      }

      if (dashRes.status === 429) {
        setRateLimited(true);
        parkRetry();
        return;
      }

      setRateLimited(false);
      setAuthExpired(false);
      // Non-OK responses (500 JSON errors, proxy 502 HTML) must not be
      // silently treated as an empty-but-successful dashboard.
      if (!dashRes.ok) {
        throw new Error(`Dashboard request failed (HTTP ${dashRes.status})`);
      }
      const dashData = await dashRes.json();

      // The server now reports rebuilds and explicit errors on an OK response —
      // surface them instead of treating the (possibly stale) payload as fresh.
      if (dashData.error) {
        console.warn("Dashboard degraded:", dashData.error);
      }
      const rebuilding = dashData.rebuilding === true;
      if (dashData.error && !rebuilding) {
        throw new Error(dashData.error);
      }

      syncFailedRef.current = false;
      failCountRef.current = 0;
      setFailCount(0);
      setSyncFailed(false);

      setProjects(dashData.projects || []);
      setOfflineDevices(dashData.offlineDevices || []);
      setOfflineSites(dashData.offlineSites || []);
      const limited = dashData.rateLimitedCredentials || [];
      setLimitedCreds(limited);

      const interval =
        typeof dashData.statusIntervalSeconds === "number"
          ? dashData.statusIntervalSeconds
          : DEFAULT_INTERVAL_SECONDS;
      // Remaining server-cache window (falls back to the full interval).
      // Counting THIS down instead of a fresh full interval keeps the client
      // deadline aligned with the server's real expiry — the fetch at 0 then
      // actually rebuilds. With a full-interval countdown, drift made the
      // countdown-end sync hit a still-fresh server cache: no rebuild, no new
      // sites/devices fetched (seen on Netlify).
      const updateIn =
        typeof dashData.nextUpdateInSeconds === "number"
          ? dashData.nextUpdateInSeconds
          : interval;
      const now = Date.now();
      let next: number;
      if (limited.length > 0) {
        // A credential is cooling down — the server answers from cache and
        // makes no Ruijie calls, so poll fast and drop the banner as soon as
        // the cooldown lifts instead of waiting out a full status cycle.
        next = now + FAST_POLL_SECONDS * 1000;
      } else if (rebuilding) {
        // The rebuild is still running in the background — poll again when the
        // server says to (30s) so we pick up the fresh payload when it lands.
        next = now + updateIn * 1000;
      } else {
        // Keep the running window across page switches unless forced or expired.
        const prev = readNextRefreshAt();
        if (!force && prev && prev > now) {
          next = prev;
        } else {
          next = now + updateIn * 1000;
        }
      }
      writeNextRefreshAt(next);
      setRefreshCountdown(secondsUntil(next));
    } catch (error) {
      console.error("Error fetching dashboard:", error);
      syncFailedRef.current = true;
      setSyncFailed(true);
      parkRetry();
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, [stopBeeping]);

  useEffect(() => {
    fetchAllRef.current = fetchAll;
  }, [fetchAll]);

  // Restore the running update window after hydration (sessionStorage is client-only).
  useEffect(() => {
    const next = readNextRefreshAt();
    if (next && next > Date.now()) {
      setRefreshCountdown(secondsUntil(next));
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Auto status check every 10m (matches server status TTL).
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
      const secs = secondsUntil(next);
      setRefreshCountdown(secs);
      // Countdown just hit zero → the sync cycle finished: sound the alarm.
      // Skipped while a sync is failing — the zero is just the retry window
      // expiring, not a completed refresh.
      if (
        secs === 0 &&
        prevCountdownRef.current !== null &&
        prevCountdownRef.current > 0 &&
        !syncFailedRef.current
      ) {
        startBeepSession();
      }
      prevCountdownRef.current = secs;
    }, 1000);
    return () => clearInterval(timer);
  }, [startBeepSession]);

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

  const offlineSitesScrollRef = useRef<HTMLDivElement>(null);
  const offlineDevicesScrollRef = useRef<HTMLDivElement>(null);
  const byProvinceScrollRef = useRef<HTMLDivElement>(null);
  const byProjectScrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(offlineSitesScrollRef);
  useAutoScroll(offlineDevicesScrollRef);
  useAutoScroll(byProvinceScrollRef);
  useAutoScroll(byProjectScrollRef);

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
  const sitesOnline = projects.length - offlineSites.length;
  const sitesPct =
    projects.length > 0 ? (sitesOnline / projects.length) * 100 : 0;
  const devicesPct =
    totalDevices > 0 ? (totalOnline / totalDevices) * 100 : 0;

  const offlineByProvince = useMemo(
    () => groupOfflineSites(offlineSites, (site) => site.province || "Unknown"),
    [offlineSites]
  );

  const offlineByProject = useMemo(
    () =>
      groupOfflineSites(
        offlineSites,
        (site) => site.credentialName || "Unknown"
      ),
    [offlineSites]
  );

  // Offline sites in Region 10 with coordinates, for the auto-touring map.
  const mapSites = useMemo<MapSite[]>(
    () =>
      projects
        .filter(
          (p) =>
            p.offlineCount > 0 &&
            p.latitude != null &&
            p.longitude != null &&
            isInRegion10(p.province, p.latitude, p.longitude)
        )
        .map((p) => ({
          key: `${p.credentialId}-${p.groupId}`,
          name: p.name,
          latitude: p.latitude as number,
          longitude: p.longitude as number,
          offlineCount: p.offlineCount,
        })),
    [projects]
  );

  return (
    <div className="min-h-screen w-full bg-gray-100 flex flex-col p-4 gap-4 lg:h-screen lg:overflow-hidden">
      <div className="w-full flex-1 min-h-0 flex flex-col gap-4">
        <header className="shrink-0 flex flex-wrap justify-between items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Multifactors Sales Monitoring
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {currentDate}, {currentTime}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Always rendered — a failed/ pending first fetch previously hid
                the countdown entirely (lastRefresh gate) and, with no deadline
                written, left it with nothing to count down to. */}
            <span className="text-xs text-gray-500">
              Updating in {Math.floor(refreshCountdown / 60)}:
              {String(refreshCountdown % 60).padStart(2, "0")}
            </span>
            <button
              onClick={() => fetchAll(true)}
              disabled={refreshDisabled}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {refreshing ? (
                <>
                  <svg
                    className="animate-spin h-4 w-4"
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
                `Sync data (${manualCooldown}s)`
              ) : (
                "Sync data"
              )}
            </button>
            <button
              onClick={() => router.push("/sites")}
              className="px-4 py-2 text-sm font-medium text-blue-600 bg-white border border-blue-500 rounded-md shadow-sm hover:bg-blue-50"
            >
              All sites
            </button>
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen((o) => !o)}
                aria-label="Profile menu"
                className="w-10 h-10 rounded-full bg-transparent text-blue-600 border border-blue-600 flex items-center justify-center hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </button>
              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-44 bg-white border border-gray-200 rounded-md shadow-lg z-20 p-1 space-y-1">
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      router.push("/settings");
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-blue-600 bg-transparent rounded hover:bg-blue-50"
                  >
                    Settings
                  </button>
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      handleLogout();
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 bg-transparent rounded hover:bg-red-50"
                  >
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {authExpired && (
          <div className="shrink-0 bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
            <p className="text-red-800 font-medium">
              Your session has expired. You stay signed in until you log out.
            </p>
            <button
              onClick={() => router.push("/login")}
              className="px-4 py-2 text-sm font-medium text-red-600 bg-transparent border border-red-600 rounded-md hover:bg-red-50 shrink-0 ml-4"
            >
              Log in again
            </button>
          </div>
        )}

        {rateLimited && (
          <div className="shrink-0 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-yellow-800 font-medium">Rate limited by Ruijie API</p>
            <p className="text-yellow-700 text-sm">
              Auto-refresh paused. Wait a few minutes then click Sync Data.
            </p>
          </div>
        )}

        {syncFailed && (
          <div className="shrink-0 bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-medium">
              Sync failed — retrying in{" "}
              {SYNC_RETRY_BACKOFF_SECONDS[
                Math.min(failCount - 1, SYNC_RETRY_BACKOFF_SECONDS.length - 1)
              ] ?? SYNC_RETRY_BACKOFF_SECONDS[0]}
              s.
            </p>
            <p className="text-red-700 text-sm">
              Dashboard data may be outdated. This page retries automatically.
            </p>
          </div>
        )}

        {limitedCreds.length > 0 && (
          <div className="shrink-0 bg-orange-50 border border-orange-200 rounded-lg p-4">
            <p className="text-orange-800 font-medium">
              API quota limit reached — showing last known data
            </p>
            <ul className="mt-2 space-y-1">
              {limitedCreds.map((c) => (
                <li key={c.id} className="text-sm text-orange-700">
                  <span className="font-semibold">{c.name}</span> hit its
                  Ruijie API quota
                  {c.retryInSeconds > 0
                    ? ` — retrying in ${c.retryInSeconds}s`
                    : ""}
                  . Sites below for this API are the last known status.
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <p className="text-3xl font-bold leading-none text-blue-600">
                {projects.length}
              </p>
              <p className="text-xs text-gray-500 mt-1.5">Sites</p>
            </div>
            <div>
              <p className="text-3xl font-bold leading-none text-red-500">
                {offlineSites.length}
              </p>
              <p className="text-xs text-gray-500 mt-1.5">Offline sites</p>
            </div>
            <div>
              <p className="text-3xl font-bold leading-none text-gray-900">
                {totalDevices}
              </p>
              <p className="text-xs text-gray-500 mt-1.5">Total devices</p>
            </div>
            <div>
              <p className="text-3xl font-bold leading-none text-green-600">
                {totalOnline}
              </p>
              <p className="text-xs text-gray-500 mt-1.5">Online</p>
            </div>
            <div>
              <p className="text-3xl font-bold leading-none text-red-500">
                {totalOffline}
              </p>
              <p className="text-xs text-gray-500 mt-1.5">Offline devices</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 min-w-[260px] flex-1 max-w-2xl">
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-600">Sites online</span>
                <span className="text-gray-500">
                  {sitesOnline} of {projects.length} · {sitesPct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 bg-red-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${sitesPct}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-600">Devices online</span>
                <span className="text-gray-500">
                  {totalOnline} of {totalDevices} · {devicesPct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 bg-red-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${devicesPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <main className="flex-1 min-h-0 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
          {/* Left column: site map — auto-tours every site, one per 30s */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden h-[300px] lg:h-auto lg:row-span-2 min-h-0">
            <DashboardMap
              sites={mapSites}
              emptyText="No offline sites in Region 10"
            />
          </div>

          {/* Offline breakdown: By province + By project — two lists in one card */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
            {/* By province */}
            <div className="flex flex-col min-h-0">
              <div className="px-3.5 py-2.5 border-b border-gray-100 shrink-0 flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-gray-900">
                  By province
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-semibold">
                    {offlineSites.length}
                  </span>
                </h2>
                <span className="text-[11px] text-gray-400">Most offline first</span>
              </div>
              <div
                ref={byProvinceScrollRef}
                className="h-[72px] overflow-y-auto list-scroll divide-y divide-gray-100"
              >
                {offlineByProvince.length === 0 ? (
                  <div className="p-6 text-center text-sm text-green-600">
                    {loading || refreshing ? "Loading..." : "All sites online!"}
                  </div>
                ) : (
                  offlineByProvince.map(({ label, count }) => (
                    <div
                      key={label}
                      className="h-9 flex items-center gap-2 px-3.5"
                    >
                      <span
                        className={`inline-flex items-center min-w-0 truncate px-2 py-0.5 rounded text-[11px] font-semibold ${provinceBadgeClass(label === "Unknown" ? undefined : label)}`}
                      >
                        {label}
                      </span>
                      <div className="flex-1 min-w-0 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-red-400 rounded-full"
                          style={{
                            width: `${Math.max(6, (count / offlineByProvince[0].count) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="w-5 text-right text-[13px] font-bold text-red-500">
                        {count}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* By project */}
            <div className="flex flex-col min-h-0">
              <div className="px-3.5 py-2.5 border-b border-gray-100 shrink-0 flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-gray-900">
                  By project
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-semibold">
                    {offlineSites.length}
                  </span>
                </h2>
                <span className="text-[11px] text-gray-400">Most offline first</span>
              </div>
              <div
                ref={byProjectScrollRef}
                className="h-[72px] overflow-y-auto list-scroll divide-y divide-gray-100"
              >
                {offlineByProject.length === 0 ? (
                  <div className="p-6 text-center text-sm text-green-600">
                    {loading || refreshing ? "Loading..." : "All sites online!"}
                  </div>
                ) : (
                  offlineByProject.map(({ label, count }) => (
                    <div
                      key={label}
                      className="h-9 flex items-center gap-2 px-3.5"
                    >
                      <span className="text-[13px] font-medium text-gray-800 min-w-0 shrink truncate">
                        {label}
                      </span>
                      <div className="flex-1 min-w-0 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-red-400 rounded-full"
                          style={{
                            width: `${Math.max(6, (count / offlineByProject[0].count) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="w-5 text-right text-[13px] font-bold text-red-500">
                        {count}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Offline sites */}
          <div className="flex-1 min-h-0 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-gray-200 shrink-0 flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-gray-900">
                  Offline sites
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-semibold">
                    {sortedOfflineSites.length}
                  </span>
                </h2>
                <span className="text-xs text-gray-400">
                  Longest offline first
                </span>
              </div>
              <div
                ref={offlineSitesScrollRef}
                className="flex-1 min-h-0 overflow-y-auto list-scroll divide-y divide-gray-100"
              >
                {loading ? (
                  <div className="p-8 text-center text-sm text-gray-500">
                    Loading dashboard data...
                  </div>
                ) : sortedOfflineSites.length === 0 ? (
                  <div className="p-12 text-center text-green-600">
                    {refreshing ? "Syncing..." : "All sites online!"}
                  </div>
                ) : (
                  sortedOfflineSites.map((site) => {
                    const oldest = getSiteOldestOffline(site);
                    const sev = outageSeverity(offlineDays(oldest));
                    return (
                      <div
                        key={`${site.credentialId}-${site.groupId}`}
                          className={`border-l-4 ${sev.border} px-2.5 py-2 hover:bg-gray-50`}
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-xs font-semibold text-gray-900">
                              {site.name}
                            </h3>
                            <span
                              className={`mt-1 inline-flex items-center max-w-[6.5rem] truncate px-1.5 py-0.5 rounded text-[9px] font-semibold ${provinceBadgeClass(site.province)}`}
                            >
                              {site.province || "Unknown"}
                            </span>
                          </div>
                          <div className="shrink-0 text-right min-w-[5.5rem] whitespace-nowrap">
                            {oldest > 0 ? (
                              <>
                                <p className={`text-xs font-bold ${sev.text}`}>
                                  {formatOfflineDays(oldest)}
                                </p>
                                <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">
                                  {formatLastSeenShort(oldest)}
                                </p>
                              </>
                            ) : (
                              <p className="text-xs text-gray-400">Unknown</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          {/* Offline devices */}
            <div className="flex-1 min-h-0 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-gray-200 shrink-0 flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-gray-900">
                  Offline devices
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-semibold">
                    {totalOffline}
                  </span>
                </h2>
                <span className="text-xs text-gray-400">
                  Longest offline first
                </span>
              </div>
              <div
                ref={offlineDevicesScrollRef}
                className="flex-1 min-h-0 overflow-y-auto list-scroll divide-y divide-gray-100"
              >
                {loading ? (
                  <div className="p-8 text-center text-sm text-gray-500">
                    Loading dashboard data...
                  </div>
                ) : (
                  <>
                    {sortedOfflineDevices.length === 0 && (
                      <div className="p-12 text-center text-green-600">
                        {refreshing ? "Syncing..." : "All devices are online!"}
                      </div>
                    )}
                    {sortedOfflineDevices.map((device) => {
                      const sev = outageSeverity(offlineDays(device.lastOnline));
                      return (
                        <div
                          key={`${device.credentialName}-${device.serialNumber}`}
                        className={`border-l-4 ${sev.border} px-2.5 py-2 hover:bg-gray-50`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900">
                              {device.aliasName ||
                                device.name ||
                                device.productClass}
                            </h3>
                            {device.lastOnline > 0 && (
                              <div className="shrink-0 text-right whitespace-nowrap">
                                <p className={`text-xs font-bold ${sev.text}`}>
                                  {formatOfflineDays(device.lastOnline)}
                                </p>
                                <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">
                                  {formatLastSeenShort(device.lastOnline)}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
        </main>
      </div>
    </div>
  );
}
