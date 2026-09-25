import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import path from "path";

/**
 * Offline warm-up: geocode every received site label that has no disk entry,
 * using the same query rules as src/lib/geo.ts. Fills .cache/ so Sync Data
 * only has to reverse-geocode (no Nominatim wait in the request path).
 */

const FACILITY_NOISE =
  /\b(HALL|HOSPITAL|HOSP|HOS|COLLEGE|SCHOOL|PARK|SHC|RHU|CAPITOL|PROV|PROVINCIAL|MUN|MUNICIPAL|CITY|BRGY|BARANGAY|PUBLIC|PRIVATE|CENTER|CENTRE|TERMINAL|MARKET|COVERED|COURT|GYM|STADIUM|FALLS|SPRING|POOL|RUINS|CHURCH|WING|BUILDING|ADMIN|LIBRARY|TRAINING|TESDA|AIRPORT|ARRIVAL|DEPARTURE|PAROLA|ISLAND|PORT|VIEW|DECK|DIAGNOSTIC|MEDICAL|MED|HEALTH|HEALT|UNIT|SITE|NODE|DATA|STO|NIÑO|NINO|COLD|SUPER|BUSINESS|RURAL|GENERAL|GEN|OLD|NEW|WHITE|SUNKEN|ARDENT|FREEDOM|OWAKAN|AQUINO|NINOY)\b/gi;

const PROVINCE_HINTS = [
  { re: /^BUKIDNON\b/i, province: "Bukidnon", bbox: [7.3, 123.8, 8.8, 125.7] },
  { re: /\bMIS\s*(OCC|OC)\b/i, province: "Misamis Occidental", bbox: [7.9, 123.3, 8.8, 124.5] },
  { re: /^PFIAPSC\b/i, province: "Camiguin", bbox: [9.0, 124.4, 9.4, 125.1] },
  { re: /^DICT\s*PICS\b/i, province: null, bbox: [7.3, 123.4, 9.3, 125.5], region: "Northern Mindanao" },
  { re: /^DICT[\s_-]*PHASE/i, province: null, bbox: [7.3, 123.5, 9.5, 125.5], region: "Northern Mindanao" },
];

function provinceHintFor(name) {
  const normalized = name.replace(/_/g, " ");
  for (const h of PROVINCE_HINTS) if (h.re.test(normalized)) return h;
  return null;
}

function inPh(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 4 && lat <= 22 && lng >= 116 && lng <= 127;
}

function inBbox(lat, lng, bbox) {
  return lat >= bbox[0] && lng >= bbox[1] && lat <= bbox[2] && lng <= bbox[3];
}

function siteNameQueries(name) {
  const hint = provinceHintFor(name);
  let s = name
    .replace(/_/g, " ")
    .replace(/\bOROQUITA\b/gi, "Oroquieta")
    .replace(/\bOZAMIS\b/gi, "Ozamiz")
    .replace(/\bS\.?\s*M\.?\s*LAO\b/gi, "Sagay")
    .replace(/\bMCGH\b/gi, "Memorial Hospital")
    .replace(/\bCDO\b/gi, "Cagayan de Oro")
    .replace(/\bEL\s*SAL\b/gi, "El Salvador")
    .replace(/\bS\.\s*PAUL\b/gi, "Saint Paul")
    .replace(/\bJAMPASON\s*\.?\s*ES\b/gi, "Jampason");
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

  const JUNK = new Set([
    "puv","st","paul","saint","the","of","and","new","old","ii","iii",
    "floor","wing","phase","phase3","camp","eva","imelda",
    "mohon","tcd","jampason","es","vic","don",
  ]);
  let tokens = s
    .split(" ")
    .map((t) => t.replace(/[^\p{L}\p{N}.'-]+/gu, ""))
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !JUNK.has(t.toLowerCase()));

  const leadingPlace = /^(Ozamiz|Cagayan de Oro|El Salvador|Tagoloan|Villanueva|Jasaan|Magsaysay|Mambajao|Oroquieta|Plaridel|Tudela|Concepcion|Jimenez|Aloran|Calamba|Don Victoriano|Yumbing|Sagay|Balingasag|Gingoog|El Salvador City)/i;
  const lead = tokens.find((t) => leadingPlace.test(t));
  if (lead) tokens = [lead, ...tokens.filter((t) => t !== lead)];

  if (tokens.length === 0) {
    if (hint?.province) return [`${hint.province}, Philippines`];
    if (hint?.region) return [`${hint.region}, Philippines`];
    return [];
  }

  const scope = hint?.province || hint?.region;
  const out = [];
  const push = (phrase) => {
    const base = phrase.trim();
    if (!base) return;
    if (scope) {
      const scoped = `${base}, ${scope}, Philippines`;
      if (!out.includes(scoped)) out.push(scoped);
    }
    const q = `${base}, Philippines`;
    if (!out.includes(q)) out.push(q);
  };

  if (tokens.length > 1) push(tokens.join(" "));
  for (const len of [2, 3]) {
    if (tokens.length >= len) push(tokens.slice(-len).join(" "));
  }
  push(tokens[0]);
  push(tokens[tokens.length - 1]);

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

function cacheFile(key) {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(".cache", `${h}.json`);
}

function readCache(key) {
  try {
    return JSON.parse(readFileSync(cacheFile(key), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  if (!existsSync(".cache")) mkdirSync(".cache", { recursive: true });
  writeFileSync(
    cacheFile(key),
    JSON.stringify({ key, value, storedAt: Date.now() }),
    "utf8"
  );
}

// Pull site list from Supabase + Ruijie (same as diag).
const { createClient } = await import("@supabase/supabase-js");
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: creds } = await supabase.from("api_credentials").select("*").eq("is_active", true);

const DEFAULT_BOOTSTRAP = "d63dss0a81e4415a889ac5b78fsc904a";
const DEFAULT_BASE = "https://cloud-as.ruijienetworks.com";
const tokenCache = new Map();

async function getToken(c) {
  const base = c.base_url || DEFAULT_BASE;
  const ck = base + c.app_id;
  const cached = tokenCache.get(ck);
  if (cached && cached.exp > Date.now()) return cached.t;
  const res = await fetch(`${base}/service/api/oauth20/client/access_token?token=${c.bootstrap_token || DEFAULT_BOOTSTRAP}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appid: c.app_id, secret: c.secret }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`${c.name}: ${JSON.stringify(data)}`);
  tokenCache.set(ck, { t: data.accessToken, exp: Date.now() + (data.expiresIn || 3600) * 1000 - 60000 });
  return data.accessToken;
}

async function api(c, p) {
  const base = c.base_url || DEFAULT_BASE;
  const t = await getToken(c);
  const sep = p.includes("?") ? "&" : "?";
  const res = await fetch(`${base}${p}${sep}access_token=${t}`);
  return res.json();
}

const sites = new Map(); // groupId → name
for (const c of creds) {
  try {
    const rec = await api(c, "/service/api/network/cooperate/share/imported-project/list?pageNum=1&pageSize=500");
    for (const r of rec.sharedGroupList || []) {
      let total = 0;
      for (const dt of r.devTypeDetail || []) total += dt.totalCount;
      if (total > 0) sites.set(r.groupId, r.groupName);
    }
  } catch (e) {
    console.error(`received ${c.name}: ${e.message}`);
  }
  try {
    const tree = await api(c, "/service/api/group/single/tree");
    const walk = (n) => {
      const kids = n.subGroups || [];
      if (n.groupId !== 0 && kids.length === 0 && n.name) {
        if (!sites.has(n.groupId)) sites.set(n.groupId, n.name);
      }
      for (const k of kids) walk(k);
    };
    if (tree.code === 0 && tree.groups) walk(tree.groups);
  } catch (e) {
    console.error(`tree ${c.name}: ${e.message}`);
  }
}

let geocoded = 0;
let skipped = 0;
let failed = 0;
let lastReq = 0;

// Drop permanent-nulls so improved queries can retry (typos, bad first pass).
for (const [groupId, name] of sites) {
  const key = `geo:site-name:${groupId}`;
  const existing = readCache(key);
  if (existing && existing.value === null) {
    try {
      unlinkSync(cacheFile(key));
      console.log(`cleared null ${key} (${name})`);
    } catch {}
  }
}

for (const [groupId, name] of sites) {
  const key = `geo:site-name:${groupId}`;
  const existing = readCache(key);
  if (existing && existing.value != null) {
    // Enforce bbox on warm hits from the broken underscore-era pass.
    const hint = provinceHintFor(name);
    const v = existing.value;
    if (
      hint &&
      typeof v.latitude === "number" &&
      !inBbox(v.latitude, v.longitude, hint.bbox)
    ) {
      try {
        unlinkSync(cacheFile(key));
        console.log(`cleared out-of-bbox ${key} (${name}) ${v.latitude},${v.longitude}`);
      } catch {}
    } else {
      skipped++;
      continue;
    }
  }

  const hint = provinceHintFor(name);
  const queries = siteNameQueries(name);
  let hit = null;
  let ok = 0;

  for (let i = 0; i < queries.length && i < 4; i++) {
    const wait = 1000 - (Date.now() - lastReq);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ph&q=` +
      encodeURIComponent(queries[i]);
    lastReq = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "monitoring-app/1.0 (site geocode warmup)" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        console.log(`  HTTP ${res.status} for ${name} q=${queries[i]}`);
        break;
      }
      ok++;
      const rows = await res.json();
      const r0 = rows[0];
      if (!r0) continue;
      const lat = Number(r0.lat);
      const lng = Number(r0.lon);
      if (!inPh(lat, lng)) continue;
      if (hint && !inBbox(lat, lng, hint.bbox)) continue;
      hit = { latitude: lat, longitude: lng };
      break;
    } catch (e) {
      console.log(`  err ${name}: ${e.message}`);
      break;
    }
  }

  if (hit) {
    writeCache(key, hit);
    geocoded++;
    console.log(`OK ${groupId} ${name} → ${hit.latitude.toFixed(4)},${hit.longitude.toFixed(4)}`);
  } else if (ok > 0) {
    // definitive miss under current queries — permanent null
    writeCache(key, null);
    failed++;
    console.log(`MISS ${groupId} ${name}`);
  } else {
    failed++;
    console.log(`SKIP ${groupId} ${name} (no ok response)`);
  }
}

console.log(`\ndone: geocoded=${geocoded} skipped=${skipped} failed=${failed} total=${sites.size}`);
