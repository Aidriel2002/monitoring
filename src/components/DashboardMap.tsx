"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Map as LeafletMap,
  Circle,
  CircleMarker,
  LayerGroup,
} from "leaflet";
import "leaflet/dist/leaflet.css";

type LeafletModule = typeof import("leaflet");

export interface MapSite {
  key: string;
  name: string;
  latitude: number;
  longitude: number;
  offlineCount: number;
}

/** Time each site stays in view before sliding to the next one. */
const TOUR_INTERVAL_MS = 15_000;
/** Duration of the eased flyTo animation (the "smooth slide"). */
const FLY_DURATION_S = 2.5;
/** Building-level zoom when parked on a single site. */
const SITE_ZOOM = 15;
/** Pulse ring: one full expand/fade cycle. */
const PULSE_CYCLE_MS = 1600;

function activeIndex(index: number, length: number): number {
  if (length === 0 || index < 0) return -1;
  return ((index % length) + length) % length;
}

export default function DashboardMap({
  sites,
  emptyText = "No sites with coordinates yet",
}: {
  sites: MapSite[];
  emptyText?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<LeafletModule | null>(null);
  const markersRef = useRef<CircleMarker[]>([]);
  const pulseRef = useRef<Circle | null>(null);
  const pulseAnimRef = useRef(0);
  const sitesRef = useRef<MapSite[]>(sites);
  const indexRef = useRef(-1);
  const initializedRef = useRef(false);
  const nextAtRef = useRef(0); // epoch ms when the tour advances; 0 = not started
  const [ready, setReady] = useState(false);
  const [index, setIndex] = useState(-1); // -1 = overview until the tour starts
  const [secondsLeft, setSecondsLeft] = useState(
    Math.ceil(TOUR_INTERVAL_MS / 1000)
  );

  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  // Init the map once (Leaflet needs window — dynamic import keeps SSR safe).
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const L = (await import("leaflet")).default;
      if (disposed || !containerRef.current) return;
      leafletRef.current = L;
      const container = containerRef.current;
      const map = L.map(container, {
        center: [12.8797, 121.774], // Philippines
        zoom: 6,
        preferCanvas: true, // canvas renderer for 100+ circle markers
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setReady(true);
      // The grid stretches this container after init — without re-measuring,
      // Leaflet keeps the smaller size and the overflow area shows gray.
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(container);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      window.cancelAnimationFrame(pulseAnimRef.current);
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
      leafletRef.current = null;
      markersRef.current = [];
      pulseRef.current = null;
    };
  }, []);

  // Hide permanent labels that would overlap a higher-priority one: the
  // active site first, then the rest in index order. Runs after style
  // changes and on zoom/resize, when relative label positions change.
  const relayoutLabels = useCallback(() => {
    const markers = markersRef.current;
    if (markers.length === 0) return;

    const act = activeIndex(indexRef.current, markers.length);
    const order = markers.map((_, i) => i);
    if (act >= 0) {
      order.splice(act, 1);
      order.unshift(act);
    }

    const placed: { l: number; t: number; r: number; b: number }[] = [];
    for (const i of order) {
      const el = markers[i].getTooltip()?.getElement();
      if (!el) continue;
      el.style.visibility = "visible";
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const box = {
        l: rect.left - 2,
        t: rect.top - 2,
        r: rect.right + 2,
        b: rect.bottom + 2,
      };
      const collides = placed.some(
        (p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t
      );
      if (collides && i !== act) {
        el.style.visibility = "hidden";
        continue;
      }
      placed.push(box);
    }
  }, []);

  // Highlight the active marker: bigger dot, permanent name label on top,
  // and a pulsing radar ring. Runs after marker rebuilds and on tour ticks.
  const applyActiveStyle = useCallback(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    const list = sitesRef.current;
    const act = activeIndex(indexRef.current, list.length);

    markersRef.current.forEach((marker, i) => {
      const isActive = i === act;
      marker.setStyle({
        radius: isActive ? 9 : 5,
        weight: isActive ? 3 : 1.5,
        color: isActive ? "#1d4ed8" : "#ffffff",
        fillOpacity: isActive ? 1 : 0.95,
      });
      if (isActive) marker.bringToFront();
    });

    // Active marker may now collide with neighbour labels (or vice versa).
    relayoutLabels();

    // Swap the pulsing radar ring to the active site.
    window.cancelAnimationFrame(pulseAnimRef.current);
    pulseRef.current?.remove();
    pulseRef.current = null;

    const site = act >= 0 ? list[act] : null;
    if (!site) return;

    const circle = L.circle([site.latitude, site.longitude], {
      radius: 10,
      color: "#f87171",
      weight: 2,
      fillColor: "#fca5a5",
      fillOpacity: 0.35,
      interactive: false,
    });
    circle.addTo(map);
    pulseRef.current = circle;

    const startedAt = performance.now();
    const tick = (now: number) => {
      const phase = ((now - startedAt) % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
      circle.setRadius(10 + phase * 30);
      circle.setStyle({
        opacity: 1 - phase,
        fillOpacity: 0.35 * (1 - phase),
      });
      pulseAnimRef.current = window.requestAnimationFrame(tick);
    };
    pulseAnimRef.current = window.requestAnimationFrame(tick);
  }, [relayoutLabels]);

  // Relative label positions change when the view is zoomed or resized
  // (pure pans move every tooltip together, but re-running is harmless).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const relayout = () => relayoutLabels();
    map.on("zoomend moveend resize", relayout);
    return () => {
      map.off("zoomend moveend resize", relayout);
    };
  }, [ready, relayoutLabels]);

  // (Re)build markers whenever the site list changes (initial load + refreshes).
  useEffect(() => {
    if (!ready || sites.length === 0) return;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapRef.current || !layerRef.current) return;

      layerRef.current.clearLayers();
      markersRef.current = sites.map((site) => {
        const marker = L.circleMarker([site.latitude, site.longitude], {
          radius: 5,
          color: "#ffffff",
          weight: 1.5,
          fillColor: site.offlineCount > 0 ? "#ef4444" : "#22c55e",
          fillOpacity: 0.95,
        });
        marker.bindTooltip(site.name, {
          permanent: true,
          direction: "top",
          className: "map-site-label",
          offset: [0, -10],
        });
        marker.on("click", () => {
          const i = sitesRef.current.findIndex((s) => s.key === site.key);
          if (i >= 0) setIndex(i);
        });
        marker.addTo(layerRef.current!);
        return marker;
      });
      // Rebuild clears styles — re-apply the active highlight + label + pulse.
      applyActiveStyle();
    })();

    return () => {
      cancelled = true;
    };
  }, [sites, ready, applyActiveStyle]);

  // Tour: advance to the next site every TOUR_INTERVAL_MS.
  useEffect(() => {
    if (!ready || sites.length === 0) return;
    if (!nextAtRef.current) nextAtRef.current = Date.now() + TOUR_INTERVAL_MS;
    const id = window.setInterval(() => {
      nextAtRef.current = Date.now() + TOUR_INTERVAL_MS;
      setIndex((i) => (i + 1) % sitesRef.current.length);
    }, TOUR_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [ready, sites.length]);

  // Countdown ticker for the overlay badge.
  useEffect(() => {
    const id = window.setInterval(() => {
      const nextAt = nextAtRef.current || Date.now() + TOUR_INTERVAL_MS;
      setSecondsLeft(Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Move the view: fitBounds overview on first data, flyTo afterwards.
  useEffect(() => {
    if (!ready) return;
    const list = sitesRef.current;
    if (list.length === 0) return;

    if (index < 0) {
      // Overview until the first tick (or before data ever arrives).
      if (!initializedRef.current) {
        initializedRef.current = true;
        const bounds = list.map(
          (s) => [s.latitude, s.longitude] as [number, number]
        );
        if (bounds.length > 1) {
          mapRef.current?.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
        } else {
          mapRef.current?.flyTo(bounds[0], SITE_ZOOM, {
            duration: FLY_DURATION_S,
          });
        }
      }
      return;
    }

    const site = list[activeIndex(index, list.length)];
    if (!site) return;
    mapRef.current?.flyTo([site.latitude, site.longitude], SITE_ZOOM, {
      duration: FLY_DURATION_S,
      easeLinearity: 0.25,
    });
  }, [index, ready, sites.length]);

  // Re-highlight when the tour moves to another site.
  useEffect(() => {
    applyActiveStyle();
  }, [index, applyActiveStyle]);

  // Stop the pulse animation on unmount.
  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(pulseAnimRef.current);
      pulseRef.current?.remove();
    };
  }, []);

  const active = activeIndex(index, sites.length);
  const activeSite = active >= 0 ? sites[active] : null;

  return (
    <div className="relative h-full w-full bg-gray-100">
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      {sites.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">
          {emptyText}
        </div>
      )}

      {activeSite ? (
        <div className="absolute top-2 left-2 z-[1000] bg-white/95 border border-gray-200 rounded-lg shadow-sm px-3 py-1.5 flex items-center gap-2 text-xs">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${activeSite.offlineCount > 0 ? "bg-red-500" : "bg-green-500"}`}
          />
          <span className="font-semibold text-gray-900 truncate max-w-[16rem]">
            {activeSite.name}
          </span>
          <span className="text-gray-400 shrink-0">
            {active + 1} / {sites.length}
          </span>
        </div>
      ) : (
        sites.length > 0 && (
          <div className="absolute top-2 left-2 z-[1000] bg-white/95 border border-gray-200 rounded-lg shadow-sm px-3 py-1.5 text-xs text-gray-600">
            {sites.length} sites · overview
          </div>
        )
      )}

      {sites.length > 0 && (
        <div className="absolute bottom-2 right-2 z-[1000] bg-white/90 border border-gray-200 rounded px-2 py-0.5 text-[10px] text-gray-500">
          Next site in {secondsLeft}s
        </div>
      )}
    </div>
  );
}
