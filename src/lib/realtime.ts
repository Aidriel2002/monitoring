import { getSupabaseServiceRole } from "@/lib/supabase";

export const DASHBOARD_CHANNEL_PREFIX = "dashboard:";
export const DASHBOARD_EVENT = "dashboard-updated";

export interface DashboardRealtimePayload {
  rateLimitedCredentials?: { id: string; name: string }[];
  degraded?: boolean;
}

/**
 * Server → open dashboards push. Costs no Ruijie quota — clients refetch
 * from the in-memory dashboard cache instead of waiting for the 120s poll.
 * Failures are swallowed: realtime is best-effort, HTTP still returns data.
 */
export async function broadcastDashboardUpdate(
  userId: string,
  payload: DashboardRealtimePayload
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRole();
    const channel = supabase.channel(`${DASHBOARD_CHANNEL_PREFIX}${userId}`);
    await channel.send({
      type: "broadcast",
      event: DASHBOARD_EVENT,
      payload,
    });
    // Leave the channel so short-lived route invocations don't leak sockets.
    await supabase.removeChannel(channel);
  } catch (err) {
    console.error("dashboard realtime broadcast failed:", err);
  }
}
