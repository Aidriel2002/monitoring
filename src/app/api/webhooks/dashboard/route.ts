import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { cacheClear } from "@/lib/cache";
import { durableClear } from "@/lib/dashboard-cache";

/**
 * POST /api/webhooks/dashboard
 *
 * External trigger (Supabase Database Webhook, cron, etc.) to drop cached
 * dashboard payloads so the next client fetch rebuilds from Ruijie —
 * without clients polling more often.
 *
 * Auth: `Authorization: Bearer <DASHBOARD_WEBHOOK_SECRET>` or `?secret=`.
 * Optional JSON body: `{ "userId": "..." }` to invalidate one user only.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.DASHBOARD_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "DASHBOARD_WEBHOOK_SECRET is not configured" },
      { status: 503 }
    );
  }

  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const urlSecret = request.nextUrl.searchParams.get("secret") || "";
  const provided = bearer || urlSecret;
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let userId: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.userId === "string") userId = body.userId;
  } catch {
    // Empty/non-JSON body → invalidate all dashboard caches.
  }

  cacheClear(userId ? `dashboard:${userId}` : "dashboard:");

  // Wake each affected tab via realtime so they refetch immediately.
  if (userId) {
    // Durable copy too — otherwise a cold start would keep serving it.
    await durableClear(userId);
    const { broadcastDashboardUpdate } = await import("@/lib/realtime");
    await broadcastDashboardUpdate(userId, {});
  } else {
    const supabase = getSupabaseServiceRole();
    const { data } = await supabase.from("api_credentials").select("user_id");
    const userIds = [...new Set((data || []).map((r) => r.user_id))];
    const { broadcastDashboardUpdate } = await import("@/lib/realtime");
    for (const id of userIds) {
      await durableClear(id);
      await broadcastDashboardUpdate(id, {});
    }
  }

  return NextResponse.json({ ok: true, userId: userId ?? null });
}
