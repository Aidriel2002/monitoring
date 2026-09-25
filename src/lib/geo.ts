import { cacheGet, cacheSet } from "@/lib/cache";
import { diskGet, diskSet } from "@/lib/disk-cache";

/** Province labels do not change — cache essentially forever. */
const TTL_PROVINCE_MS = 365 * 24 * 60 * 60_000;
/** Failed lookups only — retry soon; never write these to disk. */
const TTL_NEGATIVE_MS = 10 * 60_000;

interface BigDataAdmin {
  name?: string;
  description?: string;
  isoCode?: string;
  adminLevel?: number;
}

interface BigDataCloudResponse {
  localityInfo?: { administrative?: BigDataAdmin[] };
  principalSubdivision?: string;
  principalSubdivisionCode?: string;
  countryName?: string;
}

/**
 * Extract Philippine province (or equivalent first-level area) from
 * BigDataCloud reverse-geocode response.
 *
 * BigDataCloud puts the province in localityInfo.administrative with
 * description "province of the Philippines" — not in the top-level
 * `province` field (which is often undefined for PH).
 */
function extractProvince(data: BigDataCloudResponse): string | null {
  const admin = data.localityInfo?.administrative || [];

  for (const a of admin) {
    const desc = (a.description || "").toLowerCase();
    if (desc.includes("province of the philippines") || desc === "province") {
      if (a.name) return a.name;
    }
  }

  for (const a of admin) {
    const m = (a.description || "").match(
      /capital of the province of ([A-Za-z\sÀ-ÿ'-]+)/i
    );
    if (m?.[1]) return m[1].trim();
  }

  const code = data.principalSubdivisionCode || "";
  const sub = data.principalSubdivision || "";
  if (code === "PH-00" || /national capital region|\bncr\b/i.test(sub)) {
    return "Metro Manila";
  }

  if (sub && !/\(region\b/i.test(sub) && !/metropolitan area/i.test(sub)) {
    return sub;
  }

  for (const a of admin) {
    const desc = (a.description || "").toLowerCase();
    if (desc.includes("province") && a.name) return a.name;
  }

  // Never fall back to country name — "Philippines" is not a province badge.
  return null;
}

function geoCacheKey(lat: number, lng: number): string {
  return `geo:province:${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/**
 * Reverse-geocode site coordinates → province label.
 * Cached in memory + disk so restarts do not re-call the external API.
 * Returns null when coordinates are missing or lookup fails.
 */
export async function reverseGeocodeProvince(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Promise<string | null> {
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  const key = geoCacheKey(latitude, longitude);

  const mem = cacheGet<string | null>(key);
  if (mem !== undefined) return mem;

  const disk = diskGet<string | null>(key);
  if (disk !== undefined) {
    cacheSet(key, disk, TTL_PROVINCE_MS);
    return disk;
  }

  try {
    const url =
      `https://api.bigdatacloud.net/data/reverse-geocode-client` +
      `?latitude=${encodeURIComponent(String(latitude))}` +
      `&longitude=${encodeURIComponent(String(longitude))}` +
      `&localityLanguage=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
    const data = (await res.json()) as BigDataCloudResponse;
    const province = extractProvince(data);
    if (province) {
      cacheSet(key, province, TTL_PROVINCE_MS);
      diskSet(key, province);
      return province;
    }
    // HTTP OK but no province field — retry later; never disk-cache null.
    cacheSet(key, null, TTL_NEGATIVE_MS);
    return null;
  } catch {
    // Negative-cache briefly so a down geocoder does not hammer on every poll.
    cacheSet(key, null, TTL_NEGATIVE_MS);
    return null;
  }
}

interface SiteGeo {
  latitude: number;
  longitude: number;
}

/** Rough Philippines bounding box — reject foreign Nominatim hits. */
function inPh(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 4 &&
    lat <= 22 &&
    lng >= 116 &&
    lng <= 127
  );
}

/**
 * Build place-name search queries from a Ruijie site label.
 * Strips org/facility noise, keeps a province hint from the prefix, and
 * prefers municipality tokens so Nominatim hits on query #1 when possible.
 */
const FACILITY_NOISE =
  /\b(HALL|HOSPITAL|HOSP|HOS|COLLEGE|SCHOOL|PARK|SHC|RHU|CAPITOL|PROV|PROVINCIAL|MUN|MUNICIPAL|CITY|BRGY|BARANGAY|PUBLIC|PRIVATE|CENTER|CENTRE|TERMINAL|MARKET|COVERED|COURT|GYM|STADIUM|FALLS|SPRING|POOL|RUINS|CHURCH|WING|BUILDING|ADMIN|LIBRARY|TRAINING|TESDA|AIRPORT|ARRIVAL|DEPARTURE|PAROLA|ISLAND|PORT|VIEW|DECK|DIAGNOSTIC|MEDICAL|MED|HEALTH|HEALT|UNIT|SITE|NODE|DATA|STO|NIÑO|NINO|COLD|SUPER|BUSINESS|RURAL|GENERAL|GEN|OLD|NEW|WHITE|SUNKEN|ARDENT|FREEDOM|OWAKAN|AQUINO|NINOY)\b/gi;

const PROVINCE_HINTS: Array<{
  re: RegExp;
  /** Query suffix (omit for bbox-only validation). */
  province?: string;
  /** Optional region suffix for bbox-only hints. */
  region?: string;
  bbox: [number, number, number, number];
}> = [
  // rough PH province boxes: [minLat, minLng, maxLat, maxLng]
  // Match after normalizing `_` → space (underscore is a word char, so \b fails on FOO_BAR).
  { re: /^BUKIDNON\b/i, province: "Bukidnon", bbox: [7.3, 123.8, 8.8, 125.7] },
  {
    re: /\bMIS\s*(OCC|OC)\b/i,
    province: "Misamis Occidental",
    bbox: [7.9, 123.3, 8.8, 124.5],
  },
  // PFIAPSC sites are Camiguin provincial projects.
  { re: /^PFIAPSC\b/i, province: "Camiguin", bbox: [9.0, 124.4, 9.4, 125.1] },
  // PICS spans Northern Mindanao (Lanao / MisOr / CDO) — bbox-only.
  // Do not use \b after PHASE: PHASE3 has no boundary between E and 3.
  {
    re: /^DICT\s*PICS\b/i,
    bbox: [7.3, 123.4, 9.3, 125.5],
  },
  {
    re: /^DICT[\s_-]*PHASE/i,
    bbox: [7.3, 123.5, 9.5, 125.5],
    /** Query scope for ambiguous tokens (Magsaysay, etc.). */
    region: "Northern Mindanao",
  },
];

export function provinceHintFor(name: string): {
  province?: string;
  region?: string;
  bbox: [number, number, number, number];
} | null {
  const normalized = name.replace(/_/g, " ");
  for (const h of PROVINCE_HINTS) {
    if (h.re.test(normalized)) {
      return { province: h.province, region: h.region, bbox: h.bbox };
    }
  }
  return null;
}

function inBbox(
  lat: number,
  lng: number,
  bbox: [number, number, number, number]
): boolean {
  return lat >= bbox[0] && lng >= bbox[1] && lat <= bbox[2] && lng <= bbox[3];
}

export function siteNameQueries(name: string): string[] {
  const hint = provinceHintFor(name);
  let s = name
    .replace(/_/g, " ")
    // Common label typos / abbreviations in shared DICT sites.
    .replace(/\bOROQUITA\b/gi, "Oroquieta")
    .replace(/\bOZAMIS\b/gi, "Ozamiz")
    .replace(/\bS\.?\s*M\.?\s*LAO\b/gi, "Sagay")
    .replace(/\bMCGH\b/gi, "Memorial Hospital")
    .replace(/\bCDO\b/gi, "Cagayan de Oro")
    .replace(/\bEL\s*SAL\b/gi, "El Salvador")
    .replace(/\bS\.\s*PAUL\b/gi, "Saint Paul")
    .replace(/\bJAMPASON\s*\.?\s*ES\b/gi, "Jampason");

  // Drop org / phase / province-prefix tokens — keep the place core.
  s = s
    .replace(/\bDICT\b/gi, " ")
    .replace(/\bPHASE\s*\d+\b/gi, " ")
    .replace(/\bPFIAPSC\b/gi, " ")
    .replace(/\bBUKIDNON\b/gi, " ")
    .replace(/\bMIS\s*(OCC|OC)\b/gi, " ")
    .replace(/\bPICS\b/gi, " ")
    .replace(/\bUSTP\b/gi, " ")
    .replace(/\bCMU\b/gi, " ")
    .replace(/\bPOL\b[\s\S]*$/i, " ")
    .replace(/\bCOLL\b[\s\S]*$/i, " ")
    .replace(/\bT\.?C\.?\b/gi, " ")
    .replace(/\bDON\s*VIC\b/gi, "Don Victoriano")
    .replace(/\bDIS\b/gi, " ")
    .replace(/\b\.ES\b/gi, " ")
    .replace(/\.$/, "")
    .replace(FACILITY_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Tokens that are never a place (facility fragments, org leftovers).
  const JUNK = new Set([
    "puv","st","paul","saint","the","of","and","new","old","ii","iii",
    "floor","wing","phase","phase3","camp","eva","imelda",
    "mohon","tcd","jampason","es","vic","don",
  ]);
  let tokens = s
    .split(" ")
    .map((t) => t.replace(/[^\p{L}\p{N}.'-]+/gu, ""))
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !JUNK.has(t.toLowerCase()));

  // Prefer the leading municipality token when it looks like a place
  // (e.g. OZAMIS_S.M LAO → Ozamiz first, not "Sagay Memorial Hospital").
  const leadingPlace = /^(Ozamiz|Cagayan de Oro|El Salvador|Tagoloan|Villanueva|Jasaan|Magsaysay|Mambajao|Oroquieta|Plaridel|Tudela|Concepcion|Jimenez|Aloran|Calamba|Don Victoriano|Yumbing|Sagay|Balingasag|Gingoog|El Salvador City)/i;
  const lead = tokens.find((t) => leadingPlace.test(t));
  if (lead) tokens = [lead, ...tokens.filter((t) => t !== lead)];

  if (tokens.length === 0) {
    if (hint?.province) return [`${hint.province}, Philippines`];
    if (hint?.region) return [`${hint.region}, Philippines`];
    return [];
  }

  const scope = hint?.province || hint?.region;
  const out: string[] = [];
  const push = (phrase: string) => {
    const base = phrase.trim();
    if (!base) return;
    if (scope) {
      const scoped = `${base}, ${scope}, Philippines`;
      if (!out.includes(scoped)) out.push(scoped);
    }
    const q = `${base}, Philippines`;
    if (!out.includes(q)) out.push(q);
  };

  // Municipality / place first, then trailing windows.
  if (tokens.length > 1) push(tokens.join(" "));
  for (const len of [2, 3]) {
    if (tokens.length >= len) push(tokens.slice(-len).join(" "));
  }
  push(tokens[0]);
  push(tokens[tokens.length - 1]);

  // Province/region centroid early enough to fit in the 4-attempt budget.
  if (scope) {
    const q = `${scope}, Philippines`;
    if (!out.includes(q)) out.push(q);
    const idx = out.indexOf(q);
    if (idx > 3) {
      out.splice(idx, 1);
      out.splice(3, 0, q);
    }
  }

  return out.slice(0, 4);
}

/** Hard cap on Nominatim retries per site (each costs ≥1s rate-limit wait). */
const GEOCODE_MAX_ATTEMPTS = 4;
const GEOCODE_MIN_INTERVAL_MS = 1000;
const GEOCODE_FETCH_TIMEOUT_MS = 4000;
/** Stop trying this site after this long — leave uncached so next sync can retry. */
const GEOCODE_SITE_BUDGET_MS = 6000;

/**
 * Forward-geocode a site label when Ruijie has no coords (shared from an
 * external tenant we cannot read). Cached per groupId.
 */
export async function geocodeSiteName(
  siteName: string,
  groupId: number
): Promise<SiteGeo | null> {
  const key = `geo:site-name:${groupId}`;

  const mem = cacheGet<SiteGeo | null>(key);
  if (mem !== undefined) return mem;

  const disk = diskGet<SiteGeo | null>(key);
  if (disk !== undefined) {
    cacheSet(key, disk, TTL_PROVINCE_MS);
    return disk;
  }

  const started = Date.now();
  let okResponses = 0;
  const hint = provinceHintFor(siteName);
  try {
    const queries = siteNameQueries(siteName).slice(0, GEOCODE_MAX_ATTEMPTS);
    for (let i = 0; i < queries.length; i++) {
      if (Date.now() - started > GEOCODE_SITE_BUDGET_MS) break;
      if (i > 0) {
        // Nominatim usage policy: max 1 request/second.
        await new Promise((r) => setTimeout(r, GEOCODE_MIN_INTERVAL_MS));
      }
      if (Date.now() - started > GEOCODE_SITE_BUDGET_MS) break;
      const url =
        `https://nominatim.openstreetmap.org/search` +
        `?format=jsonv2&limit=1&countrycodes=ph&q=${encodeURIComponent(queries[i])}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "monitoring-app/1.0 (site geocode)" },
        signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // 403/429/etc — transient; short negative-cache, do not touch disk.
        cacheSet(key, null, TTL_NEGATIVE_MS);
        return null;
      }
      okResponses++;
      const rows = (await res.json()) as Array<{ lat: string; lon: string }>;
      const hit = rows[0];
      if (!hit) continue;
      const latitude = Number(hit.lat);
      const longitude = Number(hit.lon);
      if (!inPh(latitude, longitude)) continue;
      // Known province prefix — reject far-away Nominatim collisions
      // (e.g. "Old Church Ruins" matching Batangas instead of Camiguin).
      if (hint && !inBbox(latitude, longitude, hint.bbox)) continue;
      const result: SiteGeo = { latitude, longitude };
      cacheSet(key, result, TTL_PROVINCE_MS);
      diskSet(key, result);
      return result;
    }

    // Budget cut the pass short — leave uncached so the next sync retries.
    if (Date.now() - started > GEOCODE_SITE_BUDGET_MS) {
      return null;
    }

    // Every completed query was HTTP 200 with no PH hit — place name will
    // not resolve; permanent-negative is safe and avoids re-querying forever.
    if (okResponses > 0) {
      cacheSet(key, null, TTL_PROVINCE_MS);
      diskSet(key, null);
      return null;
    }

    // No successful responses (network-only failures) — retry next sync.
    cacheSet(key, null, TTL_NEGATIVE_MS);
    return null;
  } catch {
    // Transient network/timeout — short negative-cache only (retry next sync).
    cacheSet(key, null, TTL_NEGATIVE_MS);
    return null;
  }
}
