import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import {
  fetchProjectTree,
  getReceivedProjects,
  refreshCredentialInventory,
  RuijieCredentials,
} from "@/lib/ruijie";
import { mapSharedProjects, ProjectsCache } from "@/lib/projects-cache";
import { cacheClear } from "@/lib/cache";
import { durableClear } from "@/lib/dashboard-cache";
import { broadcastDashboardUpdate } from "@/lib/realtime";

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

/**
 * POST /api/settings/credentials/fetch
 * Body: { credentialId }
 *
 * Full inventory refresh for one credential: site tree, device membership,
 * meta, and received projects. Also drops the user's dashboard cache so the
 * next dashboard load shows new devices/sites.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { credentialId } = await request.json();
    if (!credentialId) {
      return NextResponse.json(
        { error: "credentialId is required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServiceRole();
    const { data: cred, error: credError } = await supabase
      .from("api_credentials")
      .select("*")
      .eq("id", credentialId)
      .eq("user_id", user.id)
      .single();

    if (credError || !cred) {
      return NextResponse.json(
        { error: "Credential not found" },
        { status: 404 }
      );
    }

    if (cred.is_active === false) {
      return NextResponse.json(
        { error: "Credential is disabled — enable it in Settings first." },
        { status: 400 }
      );
    }

    const credentials: RuijieCredentials = {
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    };

    const result = await refreshCredentialInventory(credentials);

    try {
      const { tree, flat } = await fetchProjectTree(credentials);
      const received = await getReceivedProjects(credentials).catch(
        () => null
      );
      const built: ProjectsCache = {
        fetchedAt: Date.now(),
        projects: flat.map((p) => ({
          groupId: p.groupId,
          name: p.name,
          type: p.type,
          description: p.description,
        })),
        tree,
        sharedProjects: received ? mapSharedProjects(received) : [],
      };
      const { error: cacheError } = await supabase
        .from("api_credentials")
        .update({ projects_cache: built })
        .eq("id", credentialId)
        .eq("user_id", user.id);
      if (cacheError) {
        console.warn("projects_cache save failed:", cacheError.message);
      }
    } catch (e) {
      console.warn(
        "projects_cache save failed:",
        e instanceof Error ? e.message : e
      );
    }

    // New inventory — drop both cache layers so the next dashboard load
    // rebuilds from it (memory alone is per-instance on serverless).
    cacheClear(`dashboard:${user.id}`);
    await durableClear(user.id);
    void broadcastDashboardUpdate(user.id, {});

    return NextResponse.json({
      ok: true,
      credentialId,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch devices",
      },
      { status: 500 }
    );
  }
}
