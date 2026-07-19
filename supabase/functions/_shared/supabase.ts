import { createClient } from "jsr:@supabase/supabase-js@2.110.7";
import { type EnvReader, HttpError, readEnv } from "./http.ts";

type CreateClientFactory = (...args: any[]) => any;

type ClientOptions = {
  env?: EnvReader;
  createClient?: CreateClientFactory;
};

function getEnv(name: string, env: EnvReader) {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export function createUserClient(req: Request, options: ClientOptions = {}) {
  const env = options.env || readEnv;
  const create = options.createClient || createClient;
  return create(getEnv("SUPABASE_URL", env), getEnv("SUPABASE_ANON_KEY", env), {
    global: {
      headers: {
        Authorization: req.headers.get("Authorization") || "",
      },
    },
  });
}

export function createAdminClient(options: ClientOptions = {}) {
  const env = options.env || readEnv;
  const create = options.createClient || createClient;
  return create(
    getEnv("SUPABASE_URL", env),
    getEnv("SUPABASE_SERVICE_ROLE_KEY", env),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

export async function requireUser(req: Request, options: ClientOptions = {}) {
  if (!/^Bearer\s+\S+$/i.test(req.headers.get("Authorization") || "")) {
    throw new HttpError("Not authenticated.", 401);
  }

  const client = createUserClient(req, options);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError("Not authenticated.", 401);
  return data.user;
}
