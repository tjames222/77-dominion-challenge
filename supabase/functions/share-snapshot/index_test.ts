import { HttpError } from "../_shared/http.ts";
import {
  assert,
  assertEquals,
  quietLogger,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler, renderShareHtml, sharePresentation } from "./index.ts";

const token = "a".repeat(64);
const snapshotId = "10000000-0000-4000-8000-000000000001";
const env = (name: string) => ({
  PUBLIC_SITE_URL: "https://dominion.example",
  PUBLIC_SHARE_URL: "https://share.dominion.example/s",
}[name]);

function rpcClient(
  handler: (name: string, args?: Record<string, unknown>) => unknown,
) {
  return {
    rpc: async (name: string, args?: Record<string, unknown>) => ({
      data: handler(name, args),
      error: null,
    }),
  };
}

function request(method: string, body?: unknown, path = "share-snapshot") {
  return new Request(`https://functions.example/${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-token",
      Origin: "http://localhost:5173",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function testHandler(overrides: Record<string, unknown> = {}) {
  return createHandler({
    requireUser: async () => ({ id: "user-1" }),
    createUserClient: () => rpcClient(() => null),
    createAdminClient: () => rpcClient(() => null),
    env,
    logger: quietLogger,
    ...overrides,
  } as any);
}

const streakSnapshot = {
  schemaVersion: 1,
  kind: "streak",
  payload: {
    schemaVersion: 1,
    kind: "streak",
    appStreak: 12,
    fullStandardStreak: 5,
  },
  expiresAt: "2026-08-19T00:00:00Z",
};

Deno.test("share presentation distinguishes streak, progress, and general payloads", () => {
  assertEquals(sharePresentation(streakSnapshot as any).metric, "12");
  assertEquals(
    sharePresentation({
      schemaVersion: 1,
      kind: "progress",
      payload: { currentChallengeDay: 21, challengeLength: 77 },
    }).metric,
    "21/77",
  );
  assertEquals(
    sharePresentation({
      schemaVersion: 1,
      kind: "general",
      payload: {},
    }).metricLabel,
    "days of dominion",
  );
});

Deno.test("server-rendered share HTML includes crawler metadata and no private fields", () => {
  const html = renderShareHtml(
    streakSnapshot as any,
    `https://share.dominion.example/s/${token}`,
    "https://dominion.example",
  );

  assert(
    html.includes(
      '<meta property="og:title" content="12-day Dominion app streak">',
    ),
  );
  assert(
    html.includes('<meta name="twitter:card" content="summary_large_image">'),
  );
  assert(
    html.includes(
      `<link rel="canonical" href="https://share.dominion.example/s/${token}">`,
    ),
  );
  assert(html.includes("https://dominion.example/images/dominion-77-mark.jpg"));
  assert(!html.includes("email"));
  assert(!html.includes("crew"));
  assert(!html.includes("journal"));
});

Deno.test("public GET resolves an opaque token and emits hardened no-store HTML", async () => {
  let receivedToken = "";
  const response = await testHandler({
    createAdminClient: () =>
      rpcClient((_name, args) => {
        receivedToken = String(args?.target_token || "");
        return streakSnapshot;
      }),
  })(request("GET", undefined, `share-snapshot/${token}`));

  assertEquals(response.status, 200);
  assertEquals(receivedToken, token);
  assertEquals(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assertEquals(response.headers.get("referrer-policy"), "no-referrer");
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  const html = await response.text();
  assert(html.includes("12-day Dominion app streak"));
  assert(html.includes(`https://share.dominion.example/s/${token}`));
});

Deno.test("invalid, expired, and revoked public links fail with the same generic page", async () => {
  const invalid = await testHandler()(
    request("GET", undefined, "share-snapshot/not-a-token"),
  );
  const unavailable = await testHandler({
    createAdminClient: () => rpcClient(() => null),
  })(request("GET", undefined, `share-snapshot/${token}`));

  assertEquals(invalid.status, 404);
  assertEquals(unavailable.status, 404);
  assert((await invalid.text()).includes("This share is no longer available."));
  assert(
    (await unavailable.text()).includes("This share is no longer available."),
  );
});

Deno.test("preview requires authentication and returns the exact public presentation", async () => {
  const unauthorized = await testHandler({
    requireUser: async () => {
      throw new HttpError("Not authenticated.", 401);
    },
  })(request("POST", { action: "preview", kind: "streak" }));
  assertEquals(unauthorized.status, 401);

  const preview = await testHandler({
    createUserClient: () =>
      rpcClient((name, args) => {
        assertEquals(name, "preview_share_snapshot");
        assertEquals(args, { target_kind: "streak" });
        return streakSnapshot;
      }),
  })(request("POST", { action: "preview", kind: "streak" }));

  assertEquals(preview.status, 200);
  const payload = await responseJson(preview);
  assertEquals((payload.presentation as Record<string, unknown>).metric, "12");
  assertEquals((payload.payload as Record<string, unknown>).appStreak, 12);
});

Deno.test("create returns the public URL but never returns a standalone raw token", async () => {
  const response = await testHandler({
    createUserClient: () =>
      rpcClient((name, args) => {
        assertEquals(name, "create_share_snapshot");
        assertEquals(args, {
          target_kind: "progress",
          target_expires_at: null,
        });
        return {
          schemaVersion: 1,
          snapshotId,
          token,
          kind: "progress",
          payload: { currentChallengeDay: 21, challengeLength: 77 },
          expiresAt: "2026-08-19T00:00:00Z",
        };
      }),
  })(request("POST", { action: "create", kind: "progress" }));

  assertEquals(response.status, 201);
  const payload = await responseJson(response);
  assertEquals(payload.token, undefined);
  assertEquals(payload.url, `https://share.dominion.example/s/${token}`);
  assertEquals(payload.snapshotId, snapshotId);
});

Deno.test("create maps rate limits without exposing database details", async () => {
  const response = await testHandler({
    createUserClient: () => ({
      rpc: async () => ({
        data: null,
        error: {
          message:
            "Share link rate limit reached. Try again later. internal row 42",
        },
      }),
    }),
  })(request("POST", { action: "create", kind: "general" }));

  assertEquals(response.status, 429);
  assertEquals(await responseJson(response), {
    error: "Share link rate limit reached. Try again later.",
  });
});

Deno.test("revoke validates identifiers and preserves owner-scoped RPC results", async () => {
  const invalid = await testHandler()(
    request("POST", { action: "revoke", snapshotId: "wrong" }),
  );
  assertEquals(invalid.status, 400);

  const response = await testHandler({
    createUserClient: () =>
      rpcClient((name, args) => {
        assertEquals(name, "revoke_share_snapshot");
        assertEquals(args, { target_snapshot_id: snapshotId });
        return false;
      }),
  })(request("POST", { action: "revoke", snapshotId }));
  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), { revoked: false });
});

Deno.test("share endpoint handles preflight, malformed bodies, and unsupported methods", async () => {
  assertEquals((await testHandler()(request("OPTIONS"))).status, 200);
  assertEquals((await testHandler()(request("DELETE"))).status, 405);

  const malformed = await testHandler()(
    new Request("https://functions.example/share-snapshot", {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        Origin: "http://localhost:5173",
      },
      body: "{",
    }),
  );
  assertEquals(malformed.status, 400);

  const unsupported = await testHandler()(
    request("POST", { action: "publish" }),
  );
  assertEquals(unsupported.status, 400);
});
