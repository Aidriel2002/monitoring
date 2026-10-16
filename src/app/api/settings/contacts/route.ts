import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheClear, cacheGet, cacheSet } from "@/lib/cache";
import { durableLoad } from "@/lib/dashboard-cache";
import { parseProjectsCache } from "@/lib/projects-cache";
import type { ProjectTreeNode } from "@/lib/ruijie";
import { normalizePhone } from "@/lib/notify";

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

type ContactRow = {
  id: string;
  name: string;
  telegram_chat_id: string;
  provinces: string[] | null;
  project_ids: number[] | null;
  created_at: string;
};

function toContactDto(row: ContactRow) {
  return {
    id: row.id,
    name: row.name,
    telegramChatId: row.telegram_chat_id,
    provinces: Array.isArray(row.provinces) ? row.provinces : [],
    projectIds: Array.isArray(row.project_ids) ? row.project_ids : [],
    createdAt: row.created_at,
  };
}

/** Loose shape of the cached dashboard payload (only what we need). */
type DashboardCacheShape = {
  projects?: Array<{
    groupId: number;
    name: string;
    province?: string | null;
    credentialName?: string | null;
  }>;
};

/** Region 10 (Northern Mindanao) — Lanao del Sur is BARMM, not Region 10. */
const REGION10_PROVINCES = [
  "Bukidnon",
  "Camiguin",
  "Lanao del Norte",
  "Misamis Occidental",
  "Misamis Oriental",
];

/** Infer a province from a project label like "BUKIDNON_LAKE_APO". */
function inferProvinceFromName(name: string): string | null {
  const normalized = name
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  for (const province of REGION10_PROVINCES) {
    if (normalized.startsWith(province.toLowerCase())) return province;
  }
  return null;
}

/** A dropdown "project": a group folder (or the whole credential) whose
 *  selection auto-ticks the leaf sites it covers. */
interface ProjectGroupDto {
  key: string;
  name: string;
  credentialName: string;
  siteIds: number[];
}

/** All leaf group ids under a node (recursively). */
function collectLeafIds(node: ProjectTreeNode): number[] {
  if (!node?.children || node.children.length === 0) {
    return node?.groupId ? [node.groupId] : [];
  }
  return node.children.flatMap(collectLeafIds);
}

/** Every non-leaf node in the tree is a "project" folder covering sites. */
function walkFolders(
  node: ProjectTreeNode,
  credentialName: string,
  out: ProjectGroupDto[]
) {
  if (!node?.children || node.children.length === 0) return;
  const siteIds = collectLeafIds(node);
  if (siteIds.length > 0) {
    out.push({
      key: `g:${node.groupId}`,
      name: node.name,
      credentialName,
      siteIds,
    });
  }
  for (const child of node.children) walkFolders(child, credentialName, out);
}

const CONTACT_COLUMNS = "id, name, telegram_chat_id, provinces, project_ids, created_at";

/** Server-side cache for the GET payload (contacts + picker options). */
const CONTACTS_CACHE_TTL_MS = 60_000;

function contactsCacheKey(userId: string) {
  return `contacts:v1:${userId}`;
}

interface ContactsResponsePayload {
  contacts: Array<ReturnType<typeof toContactDto>>;
  provinces: string[];
  projects: Array<{
    groupId: number;
    name: string;
    credentialName: string;
    province: string;
  }>;
  projectGroups: ProjectGroupDto[];
}

/**
 * GET /api/settings/contacts
 * Returns the user's contact inchaires plus picker options: every known
 * project, and only the provinces that have at least one project (geocoded
 * province when known, otherwise inferred from the project name prefix).
 */
export async function GET(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabaseServiceRole();
    const cacheKey = contactsCacheKey(user.id);
    const cachedPayload = cacheGet<ContactsResponsePayload>(cacheKey);
    if (cachedPayload) {
      return NextResponse.json(cachedPayload);
    }
    const { data: contacts, error } = await supabase
      .from("contact_incharges")
      .select(CONTACT_COLUMNS)
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Every known project: dashboard payload first (carries geocoded
    // province + owning credential), then the persisted inventory from
    // Sync devices (per credential name — "Phase 3", "Bukidnon", ...).
    //
    // The in-memory dashboard cache is per-instance on serverless and is
    // usually empty on a cold start — fall back to the durable Supabase
    // copy (same payload the dashboard itself falls back to) so geocoded
    // provinces and dashboard-known sites are not silently lost.
    const projectMap = new Map<
      number,
      { name: string; province?: string; credentialName?: string }
    >();
    let dashboardProjects: DashboardCacheShape["projects"] = [];
    const cached = cacheGet<DashboardCacheShape>(`dashboard:${user.id}`);
    if (cached?.projects?.length) {
      dashboardProjects = cached.projects;
    } else {
      const durable = await durableLoad<DashboardCacheShape>(user.id);
      if (durable?.payload?.projects?.length) {
        dashboardProjects = durable.payload.projects;
      }
    }
    for (const p of dashboardProjects || []) {
      if (!p.name) continue;
      projectMap.set(p.groupId, {
        name: p.name,
        province: p.province || undefined,
        credentialName: p.credentialName || undefined,
      });
    }

    // Credentials + their persisted inventory/tree. Older databases may not
    // have projects_cache (migration_v5) — degrade to names instead of 500.
    let credRows: Array<{ name: string | null; projects_cache: unknown }> = [];
    const withCache = await supabase
      .from("api_credentials")
      .select("name, projects_cache")
      .eq("user_id", user.id);
    if (withCache.error) {
      const namesOnly = await supabase
        .from("api_credentials")
        .select("name")
        .eq("user_id", user.id);
      if (namesOnly.error) {
        return NextResponse.json(
          { error: namesOnly.error.message },
          { status: 500 }
        );
      }
      credRows = (namesOnly.data || []).map((r) => ({
        name: r.name,
        projects_cache: null,
      }));
    } else {
      credRows = withCache.data || [];
    }

    // Folder-level "projects" from each credential's group tree — selecting
    // one in the dropdown auto-checks the leaf sites it covers.
    const projectGroups: ProjectGroupDto[] = [];
    for (const cred of credRows) {
      const credName = (cred.name || "").trim() || "Other";
      const pc = parseProjectsCache(cred.projects_cache);
      const entries = [
        ...(pc?.projects || []),
        ...(pc?.sharedProjects || []),
      ];
      for (const p of entries) {
        const existing = projectMap.get(p.groupId);
        if (existing) {
          if (!existing.credentialName) existing.credentialName = credName;
          continue;
        }
        projectMap.set(p.groupId, {
          name: p.name,
          province: inferProvinceFromName(p.name) || undefined,
          credentialName: credName,
        });
      }
      for (const root of pc?.tree || []) walkFolders(root, credName, projectGroups);
    }

    // Only expose coverage of sites that are actually in the picker, and
    // dedupe by key (a group id can surface under two credentials).
    const knownIds = new Set(projectMap.keys());
    const groupsByKey = new Map<string, ProjectGroupDto>();
    for (const g of projectGroups) {
      g.siteIds = g.siteIds.filter((id) => knownIds.has(id));
      if (g.siteIds.length > 0 && !groupsByKey.has(g.key)) {
        groupsByKey.set(g.key, g);
      }
    }
    // Credential-wide "All sites" entry — always present, even with no tree.
    const idsByCredential = new Map<string, number[]>();
    for (const [id, e] of projectMap) {
      const c = e.credentialName || "Other";
      const list = idsByCredential.get(c) || [];
      list.push(id);
      idsByCredential.set(c, list);
    }
    for (const [c, ids] of idsByCredential) {
      groupsByKey.set(`cred:${c}`, {
        key: `cred:${c}`,
        name: "All sites",
        credentialName: c,
        siteIds: ids,
      });
    }

    // Provinces: every geocoded province behind a project, plus Region 10
    // provinces inferred from project-name prefixes. ANY non-empty geocoded
    // province is accepted (not just Region 10) so the picker is not
    // silently truncated when a site geocodes outside the known list.
    // Deduped case-insensitively; Region 10 canonical spelling wins.
    const provinceByLower = new Map<string, string>();
    function addProvince(raw: string | null | undefined) {
      const name = (raw || "").replace(/\s+/g, " ").trim();
      if (!name) return;
      const lower = name.toLowerCase();
      const canonical =
        REGION10_PROVINCES.find((known) => known.toLowerCase() === lower) ||
        name;
      const existing = provinceByLower.get(lower);
      if (
        !existing ||
        (existing !== canonical &&
          REGION10_PROVINCES.some((k) => k.toLowerCase() === lower))
      ) {
        provinceByLower.set(lower, canonical);
      }
    }
    for (const entry of projectMap.values()) {
      addProvince(entry.province);
      // Fallback: infer from the project-name prefix when geocode is missing.
      // Store it back on the entry so province → site auto-select covers it.
      if (!entry.province) {
        const inferred = inferProvinceFromName(entry.name);
        if (inferred) entry.province = inferred;
        addProvince(inferred);
      }
    }
    const provinces = [...provinceByLower.values()].sort((a, b) =>
      a.localeCompare(b)
    );

    const payload: ContactsResponsePayload = {
      contacts: (contacts || []).map(toContactDto),
      provinces,
      projects: [...projectMap.entries()]
        .map(([groupId, e]) => ({
          groupId,
          name: e.name,
          credentialName: e.credentialName || "",
          // Normalize to the dropdown's canonical casing so the client's
          // province → site auto-selection map keys match exactly.
          province: provinceByLower.get((e.province || "").toLowerCase()) || "",
        }))
        .sort(
          (a, b) =>
            a.credentialName.localeCompare(b.credentialName) ||
            a.name.localeCompare(b.name)
        ),
      projectGroups: [...groupsByKey.values()].sort(
        (a, b) =>
          a.credentialName.localeCompare(b.credentialName) ||
          a.name.localeCompare(b.name)
      ),
    };
    cacheSet(cacheKey, payload, CONTACTS_CACHE_TTL_MS);
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

interface ContactBody {
  id?: string;
  name?: string;
  telegramChatId?: string;
  provinces?: string[] | null;
  projectIds?: number[] | null;
}

function parseBody(
  body: ContactBody
): { name: string; telegramChatId: string; provinces: string[]; projectIds: number[] } | { error: string } {
  const name = (body.name || "").trim();
  if (!name) return { error: "name is required" };

  // Phone number (09171234567 / +639171234567 → E.164) or @username.
  const raw = (body.telegramChatId || "").trim();
  const telegramChatId = raw.startsWith("@")
    ? /^@[a-zA-Z0-9_]{5,32}$/.test(raw)
      ? raw
      : null
    : normalizePhone(raw);
  if (!telegramChatId) {
    return {
      error:
        "telegramChatId must be a valid phone number (e.g. 09171234567) or @username",
    };
  }

  const provinces = Array.isArray(body.provinces)
    ? [...new Set(body.provinces.map((p) => String(p).trim()).filter(Boolean))]
    : [];
  const projectIds = Array.isArray(body.projectIds)
    ? [...new Set(body.projectIds.map((p) => Number(p)).filter(Number.isFinite))]
    : [];

  return { name, telegramChatId, provinces, projectIds };
}

/** POST /api/settings/contacts — create a contact incharge. */
export async function POST(request: NextRequest) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = parseBody(await request.json());
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const supabase = getSupabaseServiceRole();
    const { data: row, error } = await supabase
      .from("contact_incharges")
      .insert({
        user_id: user.id,
        name: parsed.name,
        telegram_chat_id: parsed.telegramChatId,
        provinces: parsed.provinces,
        project_ids: parsed.projectIds,
      })
      .select(CONTACT_COLUMNS)
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    cacheClear(contactsCacheKey(user.id));

    return NextResponse.json({ contact: toContactDto(row) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

/** PATCH /api/settings/contacts — update a contact incharge. */
export async function PATCH(request: NextRequest) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const parsed = parseBody(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const supabase = getSupabaseServiceRole();
    const { data: row, error } = await supabase
      .from("contact_incharges")
      .update({
        name: parsed.name,
        telegram_chat_id: parsed.telegramChatId,
        provinces: parsed.provinces,
        project_ids: parsed.projectIds,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .select(CONTACT_COLUMNS)
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    cacheClear(contactsCacheKey(user.id));

    return NextResponse.json({ contact: toContactDto(row) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

/** DELETE /api/settings/contacts?id=… — remove a contact incharge. */
export async function DELETE(request: NextRequest) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const supabase = getSupabaseServiceRole();
    const { error } = await supabase
      .from("contact_incharges")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    cacheClear(contactsCacheKey(user.id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
