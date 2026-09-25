import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { getRuijieToken, clearTokenCache, RuijieCredentials } from "@/lib/ruijie";

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
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const credentialId = searchParams.get("credentialId");
    if (!credentialId) return NextResponse.json({ error: "credentialId required" }, { status: 400 });

    const supabase = getSupabaseServiceRole();
    const { data: cred } = await supabase
      .from("api_credentials")
      .select("*")
      .eq("id", credentialId)
      .eq("user_id", user.id)
      .single();

    if (!cred) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const credentials: RuijieCredentials = {
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    };

    const baseUrl = credentials.baseUrl || "https://cloud-as.ruijienetworks.com";
    clearTokenCache(credentials.appId);
    const token = await getRuijieToken(credentials);

    // Try various endpoints that might return received/shared projects
    const endpoints = [
      "/service/api/group/single/tree",
      "/service/api/group/share/tree",
      "/service/api/group/received/tree",
      "/service/api/group/share/list",
      "/service/api/group/received/list",
      "/service/api/open/v1/group/share",
      "/service/api/open/v1/group/received",
      "/service/api/org/group/share",
      "/service/api/org/group/received",
    ];

    const results: Record<string, unknown> = {};
    for (const ep of endpoints) {
      try {
        const url = `${baseUrl}${ep}?access_token=${token}`;
        const res = await fetch(url);
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const data = await res.json();
          results[ep] = { code: data.code, msg: data.msg, hasData: !!data.groups || !!data.data || !!data.list, keys: Object.keys(data) };
        } else {
          results[ep] = { status: res.status, contentType: ct };
        }
      } catch (e) {
        results[ep] = { error: e instanceof Error ? e.message : "unknown" };
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
