import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import {
  getProjects,
  getRateLimitStatus,
  isRateLimitError,
  RuijieCredentials,
} from "@/lib/ruijie";

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
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const credentialId = searchParams.get("credentialId");
    const isTest = searchParams.get("test") === "true";

    const supabase = getSupabaseServiceRole();

    // Fetch user's credentials
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

    if (credentialId && (creds || []).some((c) => c.is_active === false)) {
      return NextResponse.json(
        { error: "Credential is disabled — enable it in Settings first." },
        { status: 400 }
      );
    }

    // Disabled credentials are never queried — they would only burn quota.
    const activeCreds = (creds || []).filter((c) => c.is_active !== false);

    if (activeCreds.length === 0) {
      return NextResponse.json({
        projects: [],
        message: "No credentials configured. Add credentials in Settings.",
      });
    }

    // Fetch projects from all credentials
    const allProjects = [];
    const errors = [];

    for (const cred of activeCreds) {
      const credentials: RuijieCredentials = {
        appId: cred.app_id,
        secret: cred.secret,
        bootstrapToken: cred.bootstrap_token || undefined,
        baseUrl: cred.base_url || undefined,
      };
      try {
        const projects = await getProjects(credentials);
        allProjects.push(
          ...projects.map((p) => ({
            ...p,
            credentialId: cred.id,
            credentialName: cred.name,
          }))
        );
      } catch (error) {
        errors.push({
          credentialId: cred.id,
          credentialName: cred.name,
          error: error instanceof Error ? error.message : "Unknown error",
          rateLimited: isRateLimitError(error),
          retryInSeconds: getRateLimitStatus(credentials).retryInSeconds,
        });
      }
    }

    // For test mode, return after first credential
    if (isTest) {
      if (errors.length > 0 && allProjects.length === 0) {
        const first = errors[0];
        return NextResponse.json(
          {
            error: first.error,
            retryInSeconds: first.rateLimited ? first.retryInSeconds : undefined,
          },
          { status: first.rateLimited ? 429 : 400 }
        );
      }
    }

    return NextResponse.json({
      projects: allProjects,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
