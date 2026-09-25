import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseServiceRole();

    // Get token from cookie or Authorization header
    const cookieHeader = request.headers.get("cookie") || "";
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [key, ...val] = c.trim().split("=");
        return [key, val.join("=")];
      })
    );

    const accessToken = cookies["sb-access-token"];

    if (!accessToken) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
