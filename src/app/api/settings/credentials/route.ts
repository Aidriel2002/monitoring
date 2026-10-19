import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheClear } from "@/lib/cache";
import { durableClear } from "@/lib/dashboard-cache";
import { expandSelectionToLeaves, fetchProjectTree, getRateLimitStatus } from "@/lib/ruijie";
import { parseProjectsCache } from "@/lib/projects-cache";

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

export async function GET(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabaseServiceRole();
    const { data, error } = await supabase
      .from("api_credentials")
      .select("id, name, app_id, secret, bootstrap_token, base_url, is_active, created_at, selected_group_ids, selected_received_group_ids, projects_cache")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Expand legacy parent IDs → leaf IDs so the UI label/count matches the tree.
    const credentials = await Promise.all(
      (data || []).map(async (cred) => {
        const {
          secret,
          bootstrap_token,
          projects_cache,
          ...pub
        } = cred as {
          secret: string;
          bootstrap_token: string | null;
          base_url: string | null;
          projects_cache?: unknown;
        } & Record<string, unknown>;
        // Live cooldown state (in-memory, per instance) — powers the
        // "API limit reached" badge in the API Credentials tab.
        const limit = getRateLimitStatus({
          appId: cred.app_id as string,
          secret,
          bootstrapToken: bootstrap_token || undefined,
          baseUrl: (pub.base_url as string | null) || undefined,
        });
        const rateLimit = {
          rate_limited_until: limit.limited
            ? Date.now() + limit.retryInSeconds * 1000
            : 0,
        };
        if (cred.selected_group_ids === null || cred.selected_group_ids === undefined) {
          return { ...pub, ...rateLimit };
        }
        // Disabled credentials are never called — no tree expansion either.
        if (cred.is_active === false) return { ...pub, ...rateLimit };
        try {
          // Prefer the snapshot persisted by Sync devices — hitting Ruijie's
          // live tree on every Settings load burned quota, and a failure
          // silently made the UI show (and re-save) "All projects".
          const cachedTree = parseProjectsCache(projects_cache)?.tree;
          const { tree } = cachedTree
            ? { tree: cachedTree }
            : await fetchProjectTree({
                appId: cred.app_id as string,
                secret,
                bootstrapToken: bootstrap_token || undefined,
                baseUrl: pub.base_url || undefined,
              });
          return {
            ...pub,
            ...rateLimit,
            selected_group_ids: expandSelectionToLeaves(
              tree,
              cred.selected_group_ids as number[] | null
            ),
          };
        } catch {
          // Tree unavailable — keep the raw saved selection (pub already
          // carries it) rather than reporting "all" for a saved subset.
          return { ...pub, ...rateLimit };
        }
      })
    );

    return NextResponse.json({ credentials });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, appId, secret, bootstrapToken, baseUrl } =
      await request.json();

    if (!name || !appId || !secret) {
      return NextResponse.json(
        { error: "Name, app ID, and secret are required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServiceRole();
    const { data, error } = await supabase
      .from("api_credentials")
      .insert({
        user_id: user.id,
        name,
        app_id: appId,
        secret,
        bootstrap_token: bootstrapToken || undefined,
        base_url: baseUrl || undefined,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ credential: data });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id, isActive } = await request.json();

    if (!id || typeof isActive !== "boolean") {
      return NextResponse.json(
        { error: "id and isActive are required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServiceRole();
    const { data, error } = await supabase
      .from("api_credentials")
      .update({ is_active: isActive })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id, name, is_active")
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message || "Credential not found" },
        { status: 404 }
      );
    }

    // A disabled credential must disappear from the dashboard immediately —
    // clear both the per-instance memory cache and the durable Supabase copy.
    cacheClear(`dashboard:${user.id}`);
    await durableClear(user.id);

    return NextResponse.json({ success: true, isActive: data.is_active });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "ID is required" }, { status: 400 });
    }

    const supabase = getSupabaseServiceRole();
    const { error } = await supabase
      .from("api_credentials")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
