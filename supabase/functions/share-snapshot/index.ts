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

function validSubmittedProgress(payload: Record<string, unknown>) {
  const keys = Object.keys(payload).sort();
  return JSON.stringify(keys) === JSON.stringify([
        "kind",
        "schemaVersion",
        "submittedCheckIns",
        "targetCheckIns",
      ]) &&
    payload.schemaVersion === 2 && payload.kind === "progress" &&
    typeof payload.submittedCheckIns === "number" &&
    Number.isInteger(payload.submittedCheckIns) &&
    payload.submittedCheckIns >= 0 && payload.submittedCheckIns <= 77 &&
    payload.targetCheckIns === 77;
}

// V3 adds the current configured challenge, never its private run or owner ID.
const publicChallenges: Record<string, readonly [string, number]> = {
  original_77: ["77-Day Dominion Challenge", 77],
  seven_day_reset: ["7-Day Reset", 7],
  twenty_one_day_prayer: ["21-Day Prayer Track", 21],
  thirty_day_strength: ["30-Day Strength Intensive", 30],
  forty_day_fast: ["40-Day Fasting & Prayer Track", 40],
  bible_in_a_year: ["Bible in a Year", 365],
};

function validInstanceProgress(payload: Record<string, unknown>) {
  const keys = Object.keys(payload).sort();
  const challenge = typeof payload.challengeKey === "string" &&
      Object.hasOwn(publicChallenges, payload.challengeKey)
    ? publicChallenges[payload.challengeKey]
    : null;
  return JSON.stringify(keys) === JSON.stringify([
        "challengeKey",
        "kind",
        "schemaVersion",
        "submittedCheckIns",
        "targetCheckIns",
        "title",
      ]) &&
    payload.schemaVersion === 3 && payload.kind === "progress" &&
    challenge !== null && payload.title === challenge[0] &&
    payload.targetCheckIns === challenge[1] &&
    typeof payload.submittedCheckIns === "number" &&
    Number.isInteger(payload.submittedCheckIns) &&
    payload.submittedCheckIns >= 0 && payload.submittedCheckIns <= challenge[1];
}

function normalizeSnapshot(value: unknown): ShareSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = String(record.kind || "") as ShareKind;
  if (
    !shareKinds.has(kind) || ![1, 2, 3].includes(record.schemaVersion as number)
  ) {
    return null;
  }
  if (
    !record.payload || typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) return null;
  if (
    record.schemaVersion === 3 && (kind !== "progress" ||
      !validInstanceProgress(record.payload as Record<string, unknown>))
  ) return null;
  if (
    record.schemaVersion === 2 &&
    (kind !== "progress" ||
      !validSubmittedProgress(record.payload as Record<string, unknown>))
  ) return null;
  return {
    schemaVersion: record.schemaVersion as number,
    kind,
    payload: record.payload as Record<string, unknown>,
    expiresAt: typeof record.expiresAt === "string"
      ? record.expiresAt
      : undefined,
  };
}

export function sharePresentation(snapshot: ShareSnapshot) {
  if (
    ![1, 2, 3].includes(snapshot.schemaVersion) ||
    (snapshot.schemaVersion === 2 &&
      (snapshot.kind !== "progress" ||
        !validSubmittedProgress(snapshot.payload))) ||
    (snapshot.schemaVersion === 3 &&
      (snapshot.kind !== "progress" ||
        !validInstanceProgress(snapshot.payload)))
  ) throw new Error("Share snapshot response was invalid.");
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
        ? `A Dominion challenger has shown up ${appStreak} days and completed all seven actions ${fullStandardStreak} days in a row.`
        : `A Dominion challenger has shown up ${appStreak} days in a row.`,
      metric: String(appStreak),
      metricLabel: "day app streak",
    };
  }

  if (snapshot.kind === "progress") {
    if (snapshot.schemaVersion === 3) {
      const count = snapshot.payload.submittedCheckIns as number;
      const target = snapshot.payload.targetCheckIns as number;
      const title = snapshot.payload.title as string;
      return {
        eyebrow: title,
        title: `${count} of ${target} Dominion check-ins`,
        description:
          `${title}: ${count} of ${target} check-ins submitted. Partial check-ins count.`,
        metric: `${count}/${target}`,
        metricLabel: "submitted check-ins",
      };
    }
    if (snapshot.schemaVersion === 2) {
      const count = snapshot.payload.submittedCheckIns as number;
      return {
        eyebrow: "Challenge progress",
        title: `${count} of 77 Dominion check-ins`,
        description:
          `${count} of 77 check-ins submitted. Partial check-ins count.`,
        metric: `${count}/77`,
        metricLabel: "submitted check-ins",
      };
    }
    // Stored V1 snapshots are immutable calendar-era presentations. Never
    // reinterpret their currentChallengeDay as a submitted-check-in count.
    const currentDay = wholeNumber(snapshot.payload.currentChallengeDay, 77);
    const length = wholeNumber(snapshot.payload.challengeLength, 77) || 77;
    return {
      eyebrow: "Challenge progress",
      title: `Day ${currentDay} of the ${length}-Day Dominion Challenge`,
      description: `A Dominion challenger is ${
        Math.round(currentDay / length * 100)
      }% through 77 days of faith, fitness, and follow-through.`,
      metric: `${currentDay}/${length}`,
      metricLabel: "challenge days",
    };
  }

  return {
    eyebrow: "Build the habit",
    title: "Take the 77-Day Dominion Challenge",
    description:
      "Complete seven daily actions for 77 days to build steady habits of faith, fitness, and follow-through.",
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
  if (
    message.includes("challenge_instance") ||
    message.includes("Challenge changed")
  ) {
    return new HttpError(
      "Your challenge changed. Reopen the share preview and try again.",
      409,
    );
  }
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
      const user = await dependencies.requireUser(req);
      const body = await parseJson(req);
      const action = String(body.action || "");
      const client = dependencies.createUserClient(req);

      if (action === "preview" || action === "create") {
        const kind = String(body.kind || "") as ShareKind;
        if (!shareKinds.has(kind)) {
          throw new HttpError("Choose a supported share type.", 400);
        }
        const contractVersion = body.contractVersion;
        if (contractVersion !== undefined && contractVersion !== 2) {
          throw new HttpError(
            "Choose a supported share request contract.",
            400,
          );
        }
        const usesInstanceContract = contractVersion === 2;
        if (
          !usesInstanceContract &&
          (Object.hasOwn(body, "expectedUserId") ||
            Object.hasOwn(body, "expectedInstanceId"))
        ) {
          throw new HttpError(
            "Choose a supported share request contract.",
            400,
          );
        }
        let expectedInstanceId: unknown = null;
        let rpcName: string;
        let args: Record<string, unknown>;
        if (usesInstanceContract) {
          if (body.expectedUserId !== user.id) {
            throw new HttpError(
              "The signed-in account changed. Reopen the share preview.",
              409,
            );
          }
          expectedInstanceId = body.expectedInstanceId ?? null;
          if (
            (expectedInstanceId !== null &&
              (typeof expectedInstanceId !== "string" ||
                !uuidPattern.test(expectedInstanceId))) ||
            (kind === "progress" && action === "create" &&
              expectedInstanceId === null) ||
            (kind !== "progress" && expectedInstanceId !== null)
          ) {
            throw new HttpError(
              "Reopen the share preview before creating a link.",
              400,
            );
          }
          rpcName = action === "preview"
            ? "preview_share_snapshot_v2"
            : "create_share_snapshot_v2";
          args = action === "preview"
            ? {
              target_kind: kind,
              target_expected_actor_id: user.id,
              target_expected_instance_id: expectedInstanceId,
            }
            : {
              target_kind: kind,
              target_expires_at: body.expiresAt || null,
              target_expected_actor_id: user.id,
              target_expected_instance_id: expectedInstanceId,
            };
        } else {
          rpcName = action === "preview"
            ? "preview_share_snapshot"
            : "create_share_snapshot";
          args = action === "preview"
            ? { target_kind: kind }
            : { target_kind: kind, target_expires_at: body.expiresAt || null };
        }
        const { data, error } = await client.rpc(rpcName, args);
        if (error) throw safeRpcError(error.message);
        const snapshot = normalizeSnapshot(data);
        if (!snapshot || (usesInstanceContract && snapshot.kind !== kind)) {
          throw new Error("Share snapshot response was invalid.");
        }
        if (usesInstanceContract) {
          const context = (data as Record<string, unknown>).context as
            | Record<string, unknown>
            | null;
          if (
            !context || context.schemaVersion !== 2 ||
            context.actorId !== user.id ||
            (kind === "progress"
              ? typeof context.instanceId !== "string" ||
                !uuidPattern.test(context.instanceId)
              : context.instanceId !== null) ||
            (expectedInstanceId !== null &&
              context.instanceId !== expectedInstanceId)
          ) {
            throw new Error("Share snapshot context was invalid.");
          }
        }
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
