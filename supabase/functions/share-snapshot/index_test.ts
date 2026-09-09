import { HttpError } from "../_shared/http.ts";
import {
  assert,
  assertEquals,
  quietLogger,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler, renderShareHtml, sharePresentation } from "./index.ts";
import { createPublicShareWorker } from "../../../src/cloudflare/public-share-worker.mjs";

const token = "a".repeat(64);
const snapshotId = "10000000-0000-4000-8000-000000000001";
const env = (name: string) => ({
  PUBLIC_SITE_URL: "https://dominion.example",
  PUBLIC_SHARE_URL: "https://share.dominion.example/s",
}[name]);
const productionShareEnv = (name: string) => ({
  PUBLIC_SITE_URL: "https://77dominion.com",
  PUBLIC_SHARE_URL: "https://77dominion.com/share",
}[name]);

const internalRequestBases = [
  "http://exampleproject.supabase.co/share-snapshot",
  "http://internal.gateway.invalid/rewritten/share-snapshot",
  "https://attacker.example/not-the-public-route",
];
const forgedForwardingHeaders = {
  Host: "attacker.example",
  Forwarded: "host=attacker.example;proto=http",
  "X-Forwarded-Host": "attacker.example",
  "X-Forwarded-Proto": "http",
  "X-Forwarded-Prefix": "/not-the-public-route",
  Origin: "https://77dominion.com",
};

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
      Origin: "https://dominion.example",
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

Deno.test("configured public share route overrides internal HTTP URLs and forged request locations on create", async () => {
  let rpcCalls = 0;
  const handler = testHandler({
    env: productionShareEnv,
    createUserClient: () =>
      rpcClient((name, args) => {
        rpcCalls += 1;
        assertEquals(name, "create_share_snapshot");
        assertEquals(args, {
          target_kind: "streak",
          target_expires_at: null,
        });
        return { ...streakSnapshot, snapshotId, token };
      }),
  });

  for (const base of internalRequestBases) {
    const response = await handler(
      new Request(`${base}?redirect=https://attacker.example#forged`, {
        method: "POST",
        headers: {
          ...forgedForwardingHeaders,
          Authorization: "Bearer synthetic-test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "create", kind: "streak" }),
      }),
    );

    assertEquals(response.status, 201);
    const payload = await responseJson(response);
    assertEquals(payload.url, `https://77dominion.com/share/${token}`);
    assertEquals(payload.snapshotId, snapshotId);
    assertEquals(payload.token, undefined);
  }
  assertEquals(rpcCalls, internalRequestBases.length);
});

Deno.test("configured public share route fixes GET canonical metadata independently of gateway and forwarding headers", async () => {
  let rpcCalls = 0;
  const handler = testHandler({
    env: productionShareEnv,
    createAdminClient: () =>
      rpcClient((name, args) => {
        rpcCalls += 1;
        assertEquals(name, "get_public_share_snapshot");
        assertEquals(args, { target_token: token });
        return streakSnapshot;
      }),
  });

  for (const base of internalRequestBases) {
    const response = await handler(
      new Request(
        `${base}/${token}?redirect=https://attacker.example#forged`,
        { headers: forgedForwardingHeaders },
      ),
    );

    assertEquals(response.status, 200);
    const html = await response.text();
    assert(
      html.includes(
        `<link rel="canonical" href="https://77dominion.com/share/${token}">`,
      ),
    );
    assert(
      html.includes(
        `<meta property="og:url" content="https://77dominion.com/share/${token}">`,
      ),
    );
    assert(!html.includes("attacker.example"));
    assert(!html.includes("exampleproject.supabase.co"));
    assert(!html.includes("internal.gateway.invalid"));
    assert(!html.includes("#forged"));
  }
  assertEquals(rpcCalls, internalRequestBases.length);
});

Deno.test("Cloudflare share route renders the actual Supabase HTML template delivered as plain text", async () => {
  const upstreamHtml = renderShareHtml(
    streakSnapshot as any,
    `http://exampleproject.supabase.co/share-snapshot/${token}`,
    "https://upstream.example",
  );
  let upstreamCalls = 0;
  const mockFetch: typeof fetch = async (input, options) => {
    upstreamCalls += 1;
    assertEquals(
      String(input),
      `https://mimolwojppbtsbvtqwpo.supabase.co/functions/v1/share-snapshot/${token}`,
    );
    assertEquals(Reflect.get(options || {}, "method"), "GET");
    return new Response(upstreamHtml, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  };
  const response = await createPublicShareWorker(mockFetch).fetch(
    new Request(`https://77dominion.com/share/${token}`),
    {
      ASSETS: {
        fetch: () => {
          throw new Error("A valid share route must not use static assets.");
        },
      },
    },
  );

  assertEquals(upstreamCalls, 1);
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  const html = await response.text();
  assert(html.includes("<title>12-day Dominion app streak | Dominion</title>"));
  assert(
    html.includes(
      `<link rel="canonical" href="https://77dominion.com/share/${token}">`,
    ),
  );
  assert(
    html.includes(
      `<meta property="og:url" content="https://77dominion.com/share/${token}">`,
    ),
  );
  assert(!html.includes("exampleproject.supabase.co"));
  assert(!html.includes("upstream.example"));
  assert(!html.includes("/functions/v1/"));
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
