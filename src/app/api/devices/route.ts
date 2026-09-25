import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { getDevices, RuijieCredentials } from "@/lib/ruijie";

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

export async function GET(request: NextRequest) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const groupId = Number(request.nextUrl.searchParams.get("groupId"));
    const credentialId = request.nextUrl.searchParams.get("credentialId");

    if (!groupId) {
      return NextResponse.json(
        { error: "groupId is required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServiceRole();

    // Fetch the specific credential
    let query = supabase
      .from("api_credentials")
      .select("*")
      .eq("user_id", user.id);

    if (credentialId) {
      query = query.eq("id", credentialId);
    }

    const { data: creds, error: credsError } = await query;

    if (credsError) {
      return NextResponse.json({ error: credsError.message }, { status: 500 });
    }

    if (!creds || creds.length === 0) {
      return NextResponse.json(
        { error: "No credentials found" },
        { status: 404 }
      );
    }

    // Use first matching credential
    const cred = creds[0];
    const credentials: RuijieCredentials = {
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    };

    const devices = await getDevices(credentials, groupId);
    return NextResponse.json({ devices });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch devices" },
      { status: 500 }
    );
  }
}
