import {
  createAdminClient,
  createUserClient,
  requireUser,
} from "../_shared/supabase.ts";
import {
  type EnvReader,
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
  readEnv,
} from "../_shared/http.ts";

type ShareKind = "streak" | "progress" | "general";

type ShareSnapshot = {
  schemaVersion: number;
  kind: ShareKind;
  payload: Record<string, unknown>;
  expiresAt?: string;
};

type RpcResult = { data: unknown; error: { message?: string } | null };
type RpcClient = {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<RpcResult>;
};

type Dependencies = {
  requireUser: typeof requireUser;
  createUserClient: (req: Request) => RpcClient;
  createAdminClient: () => RpcClient;
  env: EnvReader;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  requireUser,
  createUserClient,
  createAdminClient,
  env: readEnv,
  logger: console,
};

const shareKinds = new Set<ShareKind>(["streak", "progress", "general"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[0-9a-f]{64}$/;

function wholeNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(Math.max(Math.floor(number), 0), maximum)
    : 0;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character] || character);
}

function configuredOrigin(name: string, env: EnvReader) {
  const value = env(name);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" && url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function siteOrigin(env: EnvReader) {
  const origin = configuredOrigin("PUBLIC_SITE_URL", env);
  if (!origin) throw new Error("PUBLIC_SITE_URL must be a valid HTTPS origin.");
  return origin;
}

function shareBaseUrl(req: Request, env: EnvReader) {
  const configured = env("PUBLIC_SHARE_URL");
  if (configured) {
    try {
      const url = new URL(configured);
      if (
        url.protocol === "https:" || url.hostname === "localhost" ||
        url.hostname === "127.0.0.1"
      ) {
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
      }
    } catch {
      // Fall through to the deployed function URL.
    }
  }
  const url = new URL(req.url);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/[0-9a-f]{64}\/?$/, "").replace(
    /\/$/,
    "",
  );
  return url.toString().replace(/\/$/, "");
}

function requestedToken(req: Request) {
  const url = new URL(req.url);
  const segment = url.pathname.split("/").filter(Boolean).at(-1) || "";
  return tokenPattern.test(segment) ? segment : null;
}

function normalizeSnapshot(value: unknown): ShareSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = String(record.kind || "") as ShareKind;
  if (!shareKinds.has(kind) || record.schemaVersion !== 1) return null;
  if (
    !record.payload || typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) return null;
  return {
    schemaVersion: 1,
    kind,
    payload: record.payload as Record<string, unknown>,
    expiresAt: typeof record.expiresAt === "string"
      ? record.expiresAt
      : undefined,
  };
}

export function sharePresentation(snapshot: ShareSnapshot) {
  if (snapshot.kind === "streak") {
    const appStreak = wholeNumber(snapshot.payload.appStreak, 100000);
    const fullStandardStreak = wholeNumber(
      snapshot.payload.fullStandardStreak,
      100000,
    );
    return {
      eyebrow: "Consistency in motion",
      title: `${appStreak}-day Dominion app streak`,
      description: fullStandardStreak > 0
        ? `A Dominion challenger has shown up ${appStreak} days and completed every standard ${fullStandardStreak} days in a row.`
        : `A Dominion challenger has shown up ${appStreak} days in a row.`,
      metric: String(appStreak),
      metricLabel: "day app streak",
    };
  }

  if (snapshot.kind === "progress") {
    const currentDay = wholeNumber(snapshot.payload.currentChallengeDay, 77);
    const length = wholeNumber(snapshot.payload.challengeLength, 77) || 77;
    return {
      eyebrow: "Challenge progress",
      title: `Day ${currentDay} of the ${length}-Day Dominion Challenge`,
      description: `A Dominion challenger is ${
        Math.round(currentDay / length * 100)
      }% through a disciplined rhythm of faith, fitness, and follow-through.`,
      metric: `${currentDay}/${length}`,
      metricLabel: "challenge days",
    };
  }

  return {
    eyebrow: "Build the standard",
    title: "Take the 77-Day Dominion Challenge",
    description:
      "Commit to seven daily standards for 77 days and build a disciplined rhythm of faith, fitness, and follow-through.",
    metric: "77",
    metricLabel: "days of dominion",
  };
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy":
        "default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

export function renderShareHtml(
  snapshot: ShareSnapshot,
  canonicalUrl: string,
  publicSiteOrigin: string,
) {
  const presentation = sharePresentation(snapshot);
  const title = escapeHtml(presentation.title);
  const description = escapeHtml(presentation.description);
  const canonical = escapeHtml(canonicalUrl);
  const image = escapeHtml(`${publicSiteOrigin}/images/dominion-77-mark.jpg`);
  const destination = escapeHtml(publicSiteOrigin);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Dominion</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="77 Dominion Challenge">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${image}">
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#070807;color:#f4f0e7;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.share{width:min(100%,720px);padding:clamp(28px,7vw,64px);border:1px solid #665527;border-radius:28px;background:radial-gradient(circle at 90% 0%,#4c3d1f 0,transparent 42%),#11130f;box-shadow:0 28px 90px #000}.eyebrow{margin:0;color:#d8b85b;font-size:.72rem;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.metric{margin:26px 0 0;font-size:clamp(4.5rem,19vw,9rem);font-weight:950;letter-spacing:-.08em;line-height:.8}.metric-label{margin:14px 0 0;color:#d8b85b;font-weight:850;text-transform:uppercase;letter-spacing:.1em}.share h1{margin:42px 0 0;font-size:clamp(2rem,7vw,4rem);line-height:.98;letter-spacing:-.05em}.copy{max-width:58ch;margin:18px 0 0;color:#bbb8af;font-size:1.05rem;line-height:1.65}.cta{display:inline-flex;margin-top:32px;padding:14px 18px;border-radius:14px;background:#e1c46b;color:#19150a;font-weight:900;text-decoration:none}.mark{margin:44px 0 0;color:#88867f;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
  </style>
</head>
<body>
  <main class="share">
    <p class="eyebrow">${escapeHtml(presentation.eyebrow)}</p>
    <p class="metric">${escapeHtml(presentation.metric)}</p>
    <p class="metric-label">${escapeHtml(presentation.metricLabel)}</p>
    <h1>${title}</h1>
    <p class="copy">${description}</p>
    <a class="cta" href="${destination}" rel="noopener noreferrer">Explore the challenge</a>
    <p class="mark">77 Dominion Challenge</p>
  </main>
</body>
</html>`;
}

function renderUnavailableHtml(publicSiteOrigin: string) {
  const destination = escapeHtml(publicSiteOrigin);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Share unavailable | Dominion</title><style>:root{color-scheme:dark}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#070807;color:#f4f0e7;font:16px/1.6 system-ui,sans-serif}main{max-width:560px}h1{font-size:clamp(2rem,8vw,4rem);line-height:1}p{color:#bbb8af}a{color:#e1c46b;font-weight:800}</style></head><body><main><h1>This share is no longer available.</h1><p>The link may have expired or been revoked. No account or group information has been exposed.</p><a href="${destination}" rel="noopener noreferrer">Visit Dominion</a></main></body></html>`;
}

function safeRpcError(message = "") {
  if (message.includes("rate limit")) {
    return new HttpError(
      "Share link rate limit reached. Try again later.",
      429,
    );
  }
  if (message.includes("Revoke an existing")) {
    return new HttpError(
      "Revoke an existing share link before creating another.",
      409,
    );
  }
  if (message.includes("expiration")) {
    return new HttpError(
      "Choose an expiration between one hour and 90 days.",
      400,
    );
  }
  if (message.includes("Unsupported share type")) {
    return new HttpError("Choose a supported share type.", 400);
  }
  return new Error("Share snapshot RPC failed.");
}

async function parseJson(req: Request) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError("Request body must be valid JSON.", 400);
  }
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async (req: Request) => {
    if (req.method === "OPTIONS") return optionsResponse(req, dependencies.env);

    if (req.method === "GET") {
      let publicSiteOrigin: string;
      try {
        publicSiteOrigin = siteOrigin(dependencies.env);
      } catch (error) {
        dependencies.logger.error(error);
        return htmlResponse(
          renderUnavailableHtml("https://example.invalid"),
          500,
        );
      }

      const token = requestedToken(req);
      if (!token) {
        return htmlResponse(renderUnavailableHtml(publicSiteOrigin), 404);
      }

      try {
        const admin = dependencies.createAdminClient();
        const { data, error } = await admin.rpc("get_public_share_snapshot", {
          target_token: token,
        });
        if (error) throw error;
        const snapshot = normalizeSnapshot(data);
        if (!snapshot) {
          return htmlResponse(renderUnavailableHtml(publicSiteOrigin), 404);
        }
        const canonicalUrl = `${shareBaseUrl(req, dependencies.env)}/${token}`;
        return htmlResponse(
          renderShareHtml(snapshot, canonicalUrl, publicSiteOrigin),
        );
      } catch (error) {
        dependencies.logger.error(error);
        return htmlResponse(renderUnavailableHtml(publicSiteOrigin), 500);
      }
    }

    if (req.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed." },
        405,
        req,
        dependencies.env,
      );
    }

    try {
      await dependencies.requireUser(req);
      const body = await parseJson(req);
      const action = String(body.action || "");
      const client = dependencies.createUserClient(req);

      if (action === "preview" || action === "create") {
        const kind = String(body.kind || "") as ShareKind;
        if (!shareKinds.has(kind)) {
          throw new HttpError("Choose a supported share type.", 400);
        }
        const rpcName = action === "preview"
          ? "preview_share_snapshot"
          : "create_share_snapshot";
        const args = action === "preview"
          ? { target_kind: kind }
          : { target_kind: kind, target_expires_at: body.expiresAt || null };
        const { data, error } = await client.rpc(rpcName, args);
        if (error) throw safeRpcError(error.message);
        const snapshot = normalizeSnapshot(data);
        if (!snapshot) throw new Error("Share snapshot response was invalid.");
        const presentation = sharePresentation(snapshot);
        if (action === "preview") {
          return jsonResponse(
            { ...data as object, presentation },
            200,
            req,
            dependencies.env,
          );
        }
        const response = data as Record<string, unknown>;
        const token = String(response.token || "");
        if (!tokenPattern.test(token)) {
          throw new Error("Share token response was invalid.");
        }
        return jsonResponse(
          {
            ...response,
            token: undefined,
            url: `${shareBaseUrl(req, dependencies.env)}/${token}`,
            presentation,
          },
          201,
          req,
          dependencies.env,
        );
      }

      if (action === "revoke") {
        const snapshotId = String(body.snapshotId || "");
        if (!uuidPattern.test(snapshotId)) {
          throw new HttpError("Choose a valid share link.", 400);
        }
        const { data, error } = await client.rpc("revoke_share_snapshot", {
          target_snapshot_id: snapshotId,
        });
        if (error) throw safeRpcError(error.message);
        return jsonResponse(
          { revoked: data === true },
          200,
          req,
          dependencies.env,
        );
      }

      throw new HttpError("Choose a supported share action.", 400);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        dependencies.logger.error(error);
      }
      return errorResponse(
        error,
        "Unable to manage the share link.",
        req,
        dependencies.env,
      );
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
