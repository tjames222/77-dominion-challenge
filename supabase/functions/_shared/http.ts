const localOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export type EnvReader = (name: string) => string | undefined;

export const readEnv: EnvReader = (name) => Deno.env.get(name);

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

function normalizeOrigin(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredOrigins(env: EnvReader) {
  return [
    env("PUBLIC_SITE_URL"),
    env("PUBLIC_ALLOWED_SITE_URLS"),
    env("ALLOWED_SITE_ORIGINS"),
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => Boolean(value));
}

export function isAllowedOrigin(
  origin: string | null | undefined,
  env: EnvReader = readEnv,
) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (localOrigins.has(normalized)) return true;
  if (configuredOrigins(env).includes(normalized)) return true;

  try {
    const url = new URL(normalized);
    const projectPagesHost = env("CLOUDFLARE_PAGES_PROJECT_HOST") ||
      "77-dominion-challenge.pages.dev";
    return url.protocol === "https:" &&
      (url.hostname === projectPagesHost ||
        url.hostname.endsWith(`.${projectPagesHost}`));
  } catch {
    return false;
  }
}

export function resolveSiteOrigin(req: Request, env: EnvReader = readEnv) {
  const requestOrigin = normalizeOrigin(req.headers.get("origin"));
  if (requestOrigin) {
    if (!isAllowedOrigin(requestOrigin, env)) {
      throw new HttpError("Request origin is not allowed.", 403);
    }
    return requestOrigin;
  }

  const configured = normalizeOrigin(env("PUBLIC_SITE_URL"));
  if (!configured) {
    throw new HttpError(
      "PUBLIC_SITE_URL is required when the request has no origin.",
      500,
    );
  }
  return configured;
}

export function corsHeaders(req?: Request, env: EnvReader = readEnv) {
  const origin = req?.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, stripe-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin) || origin;
  }
  return headers;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  req?: Request,
  env: EnvReader = readEnv,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req, env),
      "Content-Type": "application/json",
    },
  });
}

export function optionsResponse(req?: Request, env: EnvReader = readEnv) {
  if (
    req?.headers.get("origin") &&
    !isAllowedOrigin(req.headers.get("origin"), env)
  ) {
    return new Response("origin not allowed", {
      status: 403,
      headers: corsHeaders(req, env),
    });
  }

  return new Response("ok", {
    status: 200,
    headers: corsHeaders(req, env),
  });
}

export function errorResponse(
  error: unknown,
  fallbackMessage: string,
  req?: Request,
  env: EnvReader = readEnv,
) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError && error.status < 500
    ? error.message
    : fallbackMessage;
  return jsonResponse({ error: message }, status, req, env);
}
