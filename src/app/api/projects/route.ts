import { NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";
import { getProjects, RuijieCredentials } from "@/lib/ruijie";

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

    if (!creds || creds.length === 0) {
      return NextResponse.json({
        projects: [],
        message: "No credentials configured. Add credentials in Settings.",
      });
    }

    // Fetch projects from all credentials
    const allProjects = [];
    const errors = [];

    for (const cred of creds) {
      try {
        const credentials: RuijieCredentials = {
          appId: cred.app_id,
          secret: cred.secret,
          bootstrapToken: cred.bootstrap_token || undefined,
          baseUrl: cred.base_url || undefined,
        };

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
        });
      }
    }

    // For test mode, return after first credential
    if (isTest) {
      if (errors.length > 0 && allProjects.length === 0) {
        return NextResponse.json(
          { error: errors[0].error },
          { status: 400 }
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
