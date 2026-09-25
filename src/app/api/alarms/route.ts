import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = getSupabaseServiceRole();
    const { data, error } = await supabase
      .from("alarms")
      .select("*, project:projects(*)")
      .eq("alarm_type", "offline")
      .is("resolved_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ alarms: data });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch alarms" },
      { status: 500 }
    );
  }
}
