import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import path from "path";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);

const { data: creds, error } = await supabase
  .from("api_credentials")
  .select("*")
  .eq("is_active", true);
if (error) throw error;

const DEFAULT_BOOTSTRAP = "d63dss0a81e4415a889ac5b78fsc904a";
const DEFAULT_BASE = "https://cloud-as.ruijienetworks.com";
const tokens = new Map();

async function getToken(c) {
  const key = c.base_url || DEFAULT_BASE;
  const cached = tokens.get(key + c.app_id);
  if (cached && cached.exp > Date.now()) return cached.t;
  const res = await fetch(
    `${key}/service/api/oauth20/client/access_token?token=${c.bootstrap_token || DEFAULT_BOOTSTRAP}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appid: c.app_id, secret: c.secret }),
    }
  );
  const data = await res.json();
  if (!data.accessToken) throw new Error(`${c.name}: ${JSON.stringify(data)}`);
  tokens.set(key + c.app_id, {
    t: data.accessToken,
    exp: Date.now() + (data.expiresIn || 3600) * 1000 - 60000,
  });
  return data.accessToken;
}

async function api(c, path) {
  const base = c.base_url || DEFAULT_BASE;
  const t = await getToken(c);
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `${base}${path}${sep}access_token=${t}`
  );
  return res.json();
}

function flatten(node, out = []) {
  const hasKids = node.subGroups?.length > 0;
  if (node.groupId !== 0 && !hasKids) {
    out.push({
      groupId: node.groupId,
      name: node.name,
      latitude: node.latitude,
      longitude: node.longitude,
    });
  }
  for (const ch of node.subGroups || []) flatten(ch, out);
  return out;
}

const siteNameKey = (id) => {
  const h = createHash("sha256").update(`geo:site-name:${id}`).digest("hex").slice(0, 24);
  return path.join(".cache", `${h}.json`);
};
const provinceKey = (lat, lng) => {
  const key = `geo:province:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const h = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(".cache", `${h}.json`);
};

function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const all = [];
for (const c of creds) {
  try {
    const tree = await api(c, "/service/api/group/single/tree");
    if (tree.code === 0 && tree.groups) {
      for (const p of flatten(tree.groups)) {
        all.push({ ...p, source: "owned", cred: c.name });
      }
    }
  } catch (e) {
    console.error(`tree ${c.name}: ${e.message}`);
  }
  try {
    const rec = await api(
      c,
      "/service/api/network/cooperate/share/imported-project/list?pageNum=1&pageSize=500"
    );
    for (const r of rec.sharedGroupList || []) {
      let total = 0;
      for (const dt of r.devTypeDetail || []) total += dt.totalCount;
      if (total <= 0) continue;
      const existing = all.find((x) => x.groupId === r.groupId);
      if (existing) {
        existing.receivedTotal = total;
      } else {
        all.push({
          groupId: r.groupId,
          name: r.groupName,
          latitude: undefined,
          longitude: undefined,
          source: "received",
          cred: c.name,
          receivedTotal: total,
        });
      }
    }
  } catch (e) {
    console.error(`received ${c.name}: ${e.message}`);
  }
}

console.log(`total groups: ${all.length}`);

const noCoords = all.filter((p) => p.latitude == null || p.longitude == null);
console.log(`no coords: ${noCoords.length}`);
for (const p of noCoords) {
  const hit = readCache(siteNameKey(p.groupId));
  const status =
    hit === null
      ? "no-cache"
      : hit.value == null
        ? "CACHED-NULL"
        : `HIT ${hit.value.latitude},${hit.value.longitude}`;
  console.log(`  ${p.groupId}\t${p.name}\t${status}\tsrc=${p.source}`);
}

const withCoords = all.filter((p) => p.latitude != null && p.longitude != null);
let noProv = 0;
for (const p of withCoords) {
  const hit = readCache(provinceKey(p.latitude, p.longitude));
  if (!hit || hit.value == null) {
    noProv++;
    console.log(
      `  no-prov ${p.groupId}\t${p.name}\t${p.latitude},${p.longitude}\t${hit ? "CACHED-NULL" : "no-cache"}`
    );
  }
}
console.log(`with coords: ${withCoords.length}, missing province: ${noProv}`);

const nullSite = readdirSync(".cache").filter((f) => {
  const e = readCache(path.join(".cache", f));
  return e?.key?.startsWith("geo:site-name:") && e.value == null;
});
const nullProv = readdirSync(".cache").filter((f) => {
  const e = readCache(path.join(".cache", f));
  return e?.key?.startsWith("geo:province:") && e.value == null;
});
console.log(`disk null site-name: ${nullSite.length}, disk null province: ${nullProv.length}`);
