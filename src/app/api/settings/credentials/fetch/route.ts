import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import {
  fetchProjectTree,
  getRateLimitStatus,
  getReceivedProjects,
  isRateLimitError,
  refreshCredentialInventory,
  RuijieCredentials,
} from "@/lib/ruijie";
import { mapSharedProjects, ProjectsCache } from "@/lib/projects-cache";
import { cacheClear } from "@/lib/cache";
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
  let credentials: RuijieCredentials | undefined;
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

    credentials = {
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

    // New inventory — drop the per-instance cache so the next dashboard load
    // rebuilds from it. The durable Supabase copy is deliberately KEPT: it is
    // the last-resort answer when that rebuild fails (e.g. the Ruijie daily
    // quota is exhausted right after this sync burned calls on it). Deleting
    // it here is what left the dashboard with nothing after a failed rebuild —
    // the rebuild overwrites it on success anyway (durableSave in runRebuild).
    cacheClear(`dashboard:${user.id}`);
    cacheClear(`contacts:v1:${user.id}`);
    void broadcastDashboardUpdate(user.id, {});

    return NextResponse.json({
      ok: true,
      credentialId,
      ...result,
    });
  } catch (error) {
    // A quota/rate-limit hit is not a server error — surface it as 429 with
    // the remaining cooldown so the UI can show "API limit reached" and time
    // the retry instead of guessing from a generic 500 message.
    if (isRateLimitError(error)) {
      const status = credentials ? getRateLimitStatus(credentials) : null;
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Ruijie rate limited",
          retryInSeconds: status?.retryInSeconds || 0,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch devices",
      },
      { status: 500 }
    );
  }
}
