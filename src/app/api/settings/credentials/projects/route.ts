import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheClear } from "@/lib/cache";
import {
  expandSelectionToLeaves,
  fetchProjectTree,
  getReceivedProjects,
  RuijieCredentials,
} from "@/lib/ruijie";

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

// GET: List available projects for a credential
export async function GET(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const credentialId = searchParams.get("credentialId");

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
      return NextResponse.json({ error: "Credential not found" }, { status: 404 });
    }

    const credentials: RuijieCredentials = {
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    };

    const { tree, flat } = await fetchProjectTree(credentials);

    // Shared/received projects (flat list — no parent tree).
    let sharedProjects: {
      groupId: number;
      name: string;
      type: string;
      description: string;
      tenantName: string;
      totalCount: number;
    }[] = [];
    try {
      const received = await getReceivedProjects(credentials);
      sharedProjects = received.map((rp) => ({
        groupId: rp.groupId,
        name: rp.groupName,
        type: "RECEIVED",
        description: `Shared by ${rp.tenantName}`,
        tenantName: rp.tenantName,
        totalCount: (rp.devTypeDetail || []).reduce(
          (sum, dt) => sum + (dt.totalCount || 0),
          0
        ),
      }));
    } catch {
      // Shared list may be denied — owned projects still return.
    }

    return NextResponse.json({
      projects: flat.map((p) => ({
        groupId: p.groupId,
        name: p.name,
        type: p.type,
        description: p.description,
      })),
      tree,
      selectedGroupIds: expandSelectionToLeaves(
        tree,
        cred.selected_group_ids as number[] | null
      ),
      sharedProjects,
      selectedReceivedGroupIds:
        (cred.selected_received_group_ids as number[] | null) ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch projects" },
      { status: 500 }
    );
  }
}

// POST: Save selected project IDs for a credential
export async function POST(request: Request) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { credentialId, selectedGroupIds } = body;
    const hasReceivedSel = Object.prototype.hasOwnProperty.call(
      body,
      "selectedReceivedGroupIds"
    );
    const selectedReceivedGroupIds = body.selectedReceivedGroupIds as
      | number[]
      | null
      | undefined;

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
      return NextResponse.json({ error: "Credential not found" }, { status: 404 });
    }

    const credentials: RuijieCredentials = {
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    };

    // Always persist leaf IDs only (expand parents; drop unknown IDs).
    const { tree } = await fetchProjectTree(credentials);
    const normalized =
      selectedGroupIds === null || selectedGroupIds === undefined
        ? null
        : expandSelectionToLeaves(
            tree,
            selectedGroupIds as number[] | null
          );

    // Shared projects are a flat list — only drop IDs no longer present.
    let normalizedReceived: number[] | null = null;
    if (hasReceivedSel) {
      if (selectedReceivedGroupIds === null || selectedReceivedGroupIds === undefined) {
        normalizedReceived = null;
      } else {
        try {
          const received = await getReceivedProjects(credentials);
          const valid = new Set(received.map((rp) => rp.groupId));
          const requested = Array.isArray(selectedReceivedGroupIds)
            ? selectedReceivedGroupIds
            : [];
          const filtered = requested.filter((id) => valid.has(id));
          if (filtered.length === 0) {
            normalizedReceived = [];
          } else if (filtered.length >= valid.size) {
            normalizedReceived = null;
          } else {
            normalizedReceived = filtered;
          }
        } catch {
          // If received list is unavailable, persist the raw selection.
          normalizedReceived = Array.isArray(selectedReceivedGroupIds)
            ? selectedReceivedGroupIds
            : [];
        }
      }
    }

    const update: Record<string, unknown> = {
      selected_group_ids: normalized,
    };
    if (hasReceivedSel) {
      update.selected_received_group_ids = normalizedReceived;
    }

    const { error } = await supabase
      .from("api_credentials")
      .update(update)
      .eq("id", credentialId)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Selection changed — rebuild the dashboard on next poll.
    cacheClear(`dashboard:${user.id}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save" },
      { status: 500 }
    );
  }
}
