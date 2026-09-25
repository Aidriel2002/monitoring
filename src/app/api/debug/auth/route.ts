import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const credentialId = searchParams.get("credentialId");

  if (!credentialId) {
    return NextResponse.json({ error: "credentialId required" }, { status: 400 });
  }

  const supabase = getSupabaseServiceRole();
  const { data: cred, error: credError } = await supabase
    .from("api_credentials")
    .select("*")
    .eq("id", credentialId)
    .single();

  if (credError || !cred) {
    return NextResponse.json({ error: "Credential not found", detail: credError?.message });
  }

  const baseUrl = cred.base_url || "https://cloud-as.ruijienetworks.com";
  const bootstrapToken = cred.bootstrap_token || "d63dss0a81e4415a889ac5b78fsc904a";

  const tokenUrl = `${baseUrl}/service/api/oauth20/client/access_token?token=${bootstrapToken}`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appid: cred.app_id,
      secret: cred.secret,
    }),
  });

  const data = await response.json();

  return NextResponse.json({
    baseUrl,
    bootstrapToken: bootstrapToken.substring(0, 8) + "...",
    appId: cred.app_id,
    secretLength: cred.secret.length,
    ruijieResponse: data,
  });
}
