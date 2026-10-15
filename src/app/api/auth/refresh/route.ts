import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";

function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [key, ...val] = c.split("=");
        return [key, val.join("=")];
      })
  );
}

function setAuthCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string
) {
  response.cookies.set("sb-access-token", accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  response.cookies.set("sb-refresh-token", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return response;
}

export async function POST(request: Request) {
  try {
    const cookies = parseCookies(request);
    const refreshToken = cookies["sb-refresh-token"];

    if (!refreshToken) {
      // Never delete auth cookies here — a failed refresh must not log the
      // account out; the UI keeps the session and shows the expiry banner
      // until the user clicks "Log in again" or Logout themselves.
      return NextResponse.json({ error: "No refresh token" }, { status: 401 });
    }

    const supabase = getSupabaseServiceRole();
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      return NextResponse.json(
        { error: "Session refresh failed" },
        { status: 401 }
      );
    }

    return setAuthCookies(
      NextResponse.json({ ok: true }),
      data.session.access_token,
      data.session.refresh_token
    );
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
