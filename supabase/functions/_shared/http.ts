const projectPagesHost = Deno.env.get("CLOUDFLARE_PAGES_PROJECT_HOST") || "77-dominion-challenge.pages.dev";
const localOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

function normalizeOrigin(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredOrigins() {
  return [
    Deno.env.get("PUBLIC_SITE_URL"),
    Deno.env.get("PUBLIC_ALLOWED_SITE_URLS"),
    Deno.env.get("ALLOWED_SITE_ORIGINS"),
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => Boolean(value));
}

export function isAllowedOrigin(origin: string | null | undefined) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (localOrigins.has(normalized)) return true;
  if (configuredOrigins().includes(normalized)) return true;

  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && (url.hostname === projectPagesHost || url.hostname.endsWith(`.${projectPagesHost}`));
  } catch {
    return false;
  }
}

export function resolveSiteOrigin(req: Request) {
  const requestOrigin = normalizeOrigin(req.headers.get("origin"));
  if (requestOrigin) {
    if (!isAllowedOrigin(requestOrigin)) throw new Error("Request origin is not allowed.");
    return requestOrigin;
  }

  const configured = normalizeOrigin(Deno.env.get("PUBLIC_SITE_URL"));
  if (!configured) throw new Error("PUBLIC_SITE_URL is required when the request has no origin.");
  return configured;
}

export function corsHeaders(req?: Request) {
  const origin = req?.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin) || origin;
  }
  return headers;
}

export function jsonResponse(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
    },
  });
}

export function optionsResponse(req?: Request) {
  if (req?.headers.get("origin") && !isAllowedOrigin(req.headers.get("origin"))) {
    return new Response("origin not allowed", {
      status: 403,
      headers: corsHeaders(req),
    });
  }

  return new Response("ok", {
    status: 200,
    headers: corsHeaders(req),
  });
}
