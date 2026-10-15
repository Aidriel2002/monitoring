import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheClear } from "@/lib/cache";
import { invalidateDeviceStatus } from "@/lib/ruijie";

/**
 * TEMPORARY: expires exactly the resources that share the 100-minute status
 * window, so the next dashboard request measures a real refresh cycle.
 */
export async function GET() {
  const supabase = getSupabaseServiceRole();
  const { data: creds } = await supabase
    .from("api_credentials")
    .select("app_id, secret, bootstrap_token, base_url");

  cacheClear("received:");
  cacheClear("warns:");
  cacheClear("dashboard:");

  for (const cred of creds || []) {
    invalidateDeviceStatus({
      appId: cred.app_id,
      secret: cred.secret,
      bootstrapToken: cred.bootstrap_token || undefined,
      baseUrl: cred.base_url || undefined,
    });
  }

  return NextResponse.json({ cleared: true, creds: (creds || []).length });
}
