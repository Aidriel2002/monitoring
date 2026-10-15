"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";

interface Device {
  serialNumber: string;
  productClass: string;
  commonType: string;
  onlineStatus: string;
  aliasName: string;
  name: string;
  localIp: string;
  cpeIp: string;
  groupName: string;
  lastOnline: number;
  credentialName?: string;
}

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
  /** Server-side outage start — used when device history is unavailable. */
  oldestOffline?: number;
}

const LOAD_MORE = 30;

function getGMT8Time(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " GMT+8";
}

function formatDowntime(lastOnline: number): string {
  if (!lastOnline) return "Unknown";
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
  if (!lastOnline) return "Unknown";
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
  if (times.length > 0) return Math.min(...times);
  // Shared projects whose device history is denied still carry the outage
  // start the server tracked from aggregate counts.
  return site.oldestOffline || 0;
}

export default function SitesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(LOAD_MORE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentTime, setCurrentTime] = useState("");
  const [filter, setFilter] = useState<"all" | "offline" | "online">("all");
  const [search, setSearch] = useState("");
  const [authExpired, setAuthExpired] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(getGMT8Time()), 1000);
    setCurrentTime(getGMT8Time());
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await authFetch("/api/dashboard");
        if (res.status === 401) {
          setAuthExpired(true);
          return;
        }
        const data = await res.json();
        setProjects(data.projects || []);
      } catch {
        console.error("Failed to load sites");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    let result = projects.filter((p) => {
      if (filter === "offline" && p.offlineCount === 0) return false;
      if (filter === "online" && p.onlineCount === 0) return false;
      if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });

    // Offline sites first (most days offline at top), then online sites.
    result = [...result].sort((a, b) => {
      const aOff = a.offlineCount > 0;
      const bOff = b.offlineCount > 0;
      if (aOff !== bOff) return aOff ? -1 : 1;
      if (!aOff && !bOff) return 0;
      const aOldest = getSiteOldestOffline(a);
      const bOldest = getSiteOldestOffline(b);
      const aDays = offlineDays(aOldest);
      const bDays = offlineDays(bOldest);
      if (aDays !== bDays) return bDays - aDays;
      if (!aOldest && !bOldest) return 0;
      if (!aOldest) return 1;
      if (!bOldest) return -1;
      return aOldest - bOldest;
    });

    return result;
  }, [projects, filter, search]);

  const visible = filtered.slice(0, visibleCount);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && visibleCount < filtered.length) {
          setLoadingMore(true);
          setTimeout(() => {
            setVisibleCount((prev) => Math.min(prev + LOAD_MORE, filtered.length));
            setLoadingMore(false);
          }, 200);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, filtered.length]);

  useEffect(() => {
    setVisibleCount(LOAD_MORE);
  }, [filter, search]);

  const offlineCount = projects.filter((p) => p.offlineCount > 0).length;
  const onlineCount = projects.filter((p) => p.offlineCount === 0).length;

  return (
    <div className="h-screen w-screen bg-gray-50 p-6 overflow-auto">
      <div className="w-full">
        <header className="mb-6 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/dashboard")}
              className="px-3 py-2 text-sm font-medium text-gray-600 bg-transparent border border-gray-500 rounded-md hover:bg-gray-100"
            >
              &larr; Dashboard
            </button>
            <h1 className="text-2xl font-bold text-gray-900">All Sites</h1>
          </div>
          <span className="text-sm font-mono text-gray-600">{currentTime}</span>
        </header>

        {authExpired && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
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

        <div className="mb-4 flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search sites..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setFilter("all")}
              className={`px-3 py-2 text-sm font-medium rounded-md border bg-transparent ${
                filter === "all"
                  ? "text-gray-900 border-gray-900"
                  : "text-gray-500 border-gray-400 hover:border-gray-600 hover:text-gray-700"
              }`}
            >
              All ({projects.length})
            </button>
            <button
              onClick={() => setFilter("offline")}
              className={`px-3 py-2 text-sm font-medium rounded-md border bg-transparent ${
                filter === "offline"
                  ? "text-red-600 border-red-600"
                  : "text-gray-500 border-gray-400 hover:border-red-400 hover:text-red-500"
              }`}
            >
              Offline ({offlineCount})
            </button>
            <button
              onClick={() => setFilter("online")}
              className={`px-3 py-2 text-sm font-medium rounded-md border bg-transparent ${
                filter === "online"
                  ? "text-green-600 border-green-600"
                  : "text-gray-500 border-gray-400 hover:border-green-400 hover:text-green-500"
              }`}
            >
              Online ({onlineCount})
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-400 mb-3">
          Showing {Math.min(visibleCount, filtered.length)} of {filtered.length}
          {" \u00B7 Offline sites first (offline days descending)"}
        </p>

        {loading ? (
          <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
            Loading sites...
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow">
            <div className="divide-y divide-gray-200">
              {visible.length === 0 ? (
                <div className="p-12 text-center text-gray-500">
                  No sites found
                </div>
              ) : (
                visible.map((project) => {
                  const oldest = getSiteOldestOffline(project);
                  return (
                    <div
                      key={`${project.credentialId}-${project.groupId}`}
                      className="p-4 hover:bg-gray-50"
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium text-gray-900 text-sm">
                            {project.name}
                          </h3>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {project.type} &middot; ID: {project.groupId}
                            {project.businessType && ` \u00B7 ${project.businessType}`}
                          </p>
                          {project.credentialName && (
                            <p className="text-xs text-blue-500 mt-0.5">
                              {project.credentialName}
                            </p>
                          )}
                          {oldest > 0 && project.offlineCount > 0 && (
                            <>
                              <p className="text-xs text-orange-700 mt-0.5 font-semibold">
                                Offline: {formatOfflineDays(oldest)}
                              </p>
                              <p className="text-[11px] text-orange-600/80">
                                since {formatLastSeen(oldest)}
                              </p>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm shrink-0 ml-4">
                          <div className="text-right">
                            <p className="text-green-600 font-medium">{project.onlineCount} on</p>
                            <p className="text-red-600 font-medium">{project.offlineCount} off</p>
                          </div>
                          <div className="w-16 bg-gray-200 rounded-full h-2 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-green-500"
                              style={{
                                width: project.totalCount > 0
                                  ? `${(project.onlineCount / project.totalCount) * 100}%`
                                  : "0%",
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {visibleCount < filtered.length && (
              <div ref={sentinelRef} className="p-4 text-center text-gray-400 text-sm">
                {loadingMore ? "Loading more..." : "Scroll to load more"}
              </div>
            )}
            {visibleCount >= filtered.length && filtered.length > LOAD_MORE && (
              <div className="p-3 text-center text-gray-400 text-xs border-t border-gray-200">
                All {filtered.length} sites loaded
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
