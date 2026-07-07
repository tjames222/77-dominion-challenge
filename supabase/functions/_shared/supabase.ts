import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error("Missing Supabase function environment variables.");
}

export function createUserClient(req: Request) {
  return createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: req.headers.get("Authorization") || "",
      },
    },
  });
}

export function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function requireUser(req: Request) {
  const client = createUserClient(req);
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("Not authenticated.");
  return data.user;
}
