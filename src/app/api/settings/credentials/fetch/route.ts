import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { refreshCredentialInventory, RuijieCredentials } from "@/lib/ruijie";
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

    const credentials: RuijieCredentials = {
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    };

    const result = await refreshCredentialInventory(credentials);

    cacheClear(`dashboard:${user.id}`);
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
