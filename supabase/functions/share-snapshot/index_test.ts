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
const actorId = "20000000-0000-4000-8000-000000000002";
const instanceId = "30000000-0000-4000-8000-000000000003";
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
    rpc: async (name: string, args?: Record<string, unknown>) => {
      const data = handler(name, args);
      return {
        data: name.endsWith("_v2") && data && typeof data === "object" &&
            !Object.hasOwn(data, "context")
          ? {
            ...data,
            context: {
              schemaVersion: 2,
              actorId,
              instanceId: args?.target_kind === "progress" ? instanceId : null,
            },
          }
          : data,
        error: null,
      };
    },
  };
}

function legacyRequest(
  method: string,
  body?: unknown,
  path = "share-snapshot",
) {
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

function request(method: string, body?: unknown, path = "share-snapshot") {
  if (
    body && typeof body === "object" &&
    ["preview", "create"].includes((body as any).action)
  ) {
    body = {
      ...body,
      ...(!Object.hasOwn(body, "contractVersion")
        ? { contractVersion: 2 }
        : {}),
      ...(!Object.hasOwn(body, "expectedUserId")
        ? { expectedUserId: actorId }
        : {}),
    };
  }
  if (
    body && typeof body === "object" && (body as any).action === "create" &&
    (body as any).kind === "progress" &&
    !Object.hasOwn(body, "expectedInstanceId")
  ) body = { ...body, expectedInstanceId: instanceId };
  return legacyRequest(method, body, path);
}

function testHandler(overrides: Record<string, unknown> = {}) {
  return createHandler({
    requireUser: async () => ({ id: actorId }),
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

Deno.test("preview and create reject a changed actor before calling any RPC", async () => {
  let calls = 0;
  const handler = testHandler({
    createUserClient: () =>
      rpcClient(() => {
        calls += 1;
        return streakSnapshot;
      }),
  });
  for (const action of ["preview", "create"]) {
    for (const expectedUserId of [null, snapshotId]) {
      const response = await handler(
        request("POST", { action, kind: "streak", expectedUserId }),
      );
      assertEquals(response.status, 409);
    }
  }
  assertEquals(calls, 0);
});

Deno.test("unversioned old clients use only the exact pre-instance preview and create RPCs", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  let authenticated = 0;
  const handler = testHandler({
    requireUser: async () => {
      authenticated += 1;
      return { id: actorId };
    },
    createUserClient: () =>
      rpcClient((name, args) => {
        calls.push([name, args]);
        return name === "create_share_snapshot"
          ? { ...streakSnapshot, snapshotId, token }
          : streakSnapshot;
      }),
  });

  const preview = await handler(legacyRequest("POST", {
    action: "preview",
    kind: "streak",
  }));
  const create = await handler(legacyRequest("POST", {
    action: "create",
    kind: "streak",
  }));

  assertEquals(preview.status, 200);
  assertEquals(create.status, 201);
  assertEquals(authenticated, 2);
  assertEquals(calls, [["preview_share_snapshot", { target_kind: "streak" }], [
    "create_share_snapshot",
    { target_kind: "streak", target_expires_at: null },
  ]]);
});

Deno.test("share request contract rejects unsupported versions and mixed legacy-instance shapes", async () => {
  let calls = 0;
  const handler = testHandler({
    createUserClient: () =>
      rpcClient(() => {
        calls += 1;
        return streakSnapshot;
      }),
  });
  for (const contractVersion of [null, 0, 1, 3, "2", true, {}]) {
    const response = await handler(legacyRequest("POST", {
      action: "preview",
      kind: "streak",
      contractVersion,
    }));
    assertEquals(response.status, 400);
  }
  for (
    const fields of [
      { expectedUserId: actorId },
      { expectedInstanceId: instanceId },
      { expectedUserId: actorId, expectedInstanceId: instanceId },
    ]
  ) {
    const response = await handler(legacyRequest("POST", {
      action: "preview",
      kind: "streak",
      ...fields,
    }));
    assertEquals(response.status, 400);
  }
  assertEquals(calls, 0);
});

Deno.test("explicit instance contract failures never fall back to legacy RPCs", async () => {
  for (
    const [action, kind] of [["preview", "streak"], ["create", "progress"]]
  ) {
    const calls: string[] = [];
    const response = await testHandler({
      createUserClient: () => ({
        rpc: async (name: string) => {
          calls.push(name);
          return {
            data: null,
            error: {
              message: action === "preview"
                ? "function preview_share_snapshot_v2 does not exist"
                : "candidate V2 write failed",
            },
          };
        },
      }),
    })(request("POST", { action, kind }));
    assertEquals(response.status, 500);
    assertEquals(calls, [
      action === "preview"
        ? "preview_share_snapshot_v2"
        : "create_share_snapshot_v2",
    ]);
  }
});

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

Deno.test("V2 shares display submitted counts while immutable V1 retains calendar meaning", () => {
  for (const count of [0, 1, 76, 77]) {
    const snapshot = {
      schemaVersion: 2,
      kind: "progress" as const,
      payload: {
        schemaVersion: 2,
        kind: "progress",
        submittedCheckIns: count,
        targetCheckIns: 77,
      },
    };
    const presentation = sharePresentation(snapshot);
    assertEquals(presentation.metric, `${count}/77`);
    assertEquals(presentation.metricLabel, "submitted check-ins");
    assertEquals(
      presentation.description,
      `${count} of 77 check-ins submitted. Partial check-ins count.`,
    );
    const html = renderShareHtml(
      snapshot,
      `https://share.dominion.example/s/${token}`,
      "https://dominion.example",
    );
    assert(html.includes(`${count} of 77 Dominion check-ins`));
    assert(!html.includes("challenge days"));
    assert(!html.includes("Finisher"));
  }
  const legacy = sharePresentation({
    schemaVersion: 1,
    kind: "progress",
    payload: { currentChallengeDay: 77, challengeLength: 77 },
  });
  assertEquals(legacy.metricLabel, "challenge days");
  assertEquals(legacy.title, "Day 77 of the 77-Day Dominion Challenge");
});

Deno.test("V2 public snapshots reject malformed counts and private or calendar fields", async () => {
  const valid = {
    schemaVersion: 2,
    kind: "progress",
    submittedCheckIns: 76,
    targetCheckIns: 77,
  };
  for (
    const payload of [
      ...[-1, 78, 76.5, "76", null, undefined].map((submittedCheckIns) => ({
        ...valid,
        submittedCheckIns,
      })),
      { ...valid, targetCheckIns: 78 },
      { ...valid, schemaVersion: 1 },
      { ...valid, kind: "streak" },
      { ...valid, currentChallengeDay: 78 },
      { ...valid, userId: "private-owner" },
      { ...valid, completed: true },
    ]
  ) {
    const response = await testHandler({
      createAdminClient: () =>
        rpcClient(() => ({
          schemaVersion: 2,
          kind: "progress",
          payload,
        })),
    })(request("GET", undefined, `share-snapshot/${token}`));
    assertEquals(response.status, 404);
    assert(
      (await response.text()).includes("This share is no longer available."),
    );
  }
});

Deno.test("V2 preview, create and public delivery preserve the same bounded presentation", async () => {
  const snapshot = {
    schemaVersion: 2,
    kind: "progress",
    snapshotId,
    token,
    payload: {
      schemaVersion: 2,
      kind: "progress",
      submittedCheckIns: 77,
      targetCheckIns: 77,
    },
  };
  const handler = testHandler({
    createUserClient: () => rpcClient(() => snapshot),
    createAdminClient: () => rpcClient(() => snapshot),
  });
  for (const action of ["preview", "create"]) {
    const response = await handler(
      request("POST", { action, kind: "progress" }),
    );
    assertEquals(response.status, action === "preview" ? 200 : 201);
    const result = await responseJson(response);
    assertEquals(result.schemaVersion, 2);
    assertEquals(
      (result.presentation as Record<string, unknown>).metricLabel,
      "submitted check-ins",
    );
  }
  const response = await handler(
    request("GET", undefined, `share-snapshot/${token}`),
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
});

Deno.test("V3 shares support each configured run without exposing private identifiers", async () => {
  for (
    const [challengeKey, title, target] of [
      ["original_77", "77-Day Dominion Challenge", 77],
      ["seven_day_reset", "7-Day Reset", 7],
      ["twenty_one_day_prayer", "21-Day Prayer Track", 21],
      ["thirty_day_strength", "30-Day Strength Intensive", 30],
      ["forty_day_fast", "40-Day Fasting & Prayer Track", 40],
      ["bible_in_a_year", "Bible in a Year", 365],
    ] as const
  ) {
    const snapshot = {
      schemaVersion: 3,
      kind: "progress" as const,
      snapshotId,
      token,
      payload: {
        schemaVersion: 3,
        kind: "progress",
        challengeKey,
        title,
        submittedCheckIns: target,
        targetCheckIns: target,
      },
    };
    assertEquals(sharePresentation(snapshot).metric, `${target}/${target}`);
    assertEquals(sharePresentation(snapshot).eyebrow, title);
    const handler = testHandler({
      createUserClient: () => rpcClient(() => snapshot),
      createAdminClient: () => rpcClient(() => snapshot),
    });
    for (const action of ["preview", "create"]) {
      const response = await handler(
        request("POST", { action, kind: "progress" }),
      );
      assertEquals(response.status, action === "preview" ? 200 : 201);
      assertEquals((await responseJson(response)).schemaVersion, 3);
    }
    const response = await handler(
      request("GET", undefined, `share-snapshot/${token}`),
    );
    assertEquals(response.status, 200);
    const html = await response.text();
    assert(html.includes(`${target} of ${target} Dominion check-ins`));
    for (
      const privateTerm of ["instanceId", "actorId", "scopeKey", "Finisher"]
    ) assert(!html.includes(privateTerm));
  }
});

Deno.test("V3 public shares reject unknown definitions, false targets and private extra fields", async () => {
  const valid = {
    schemaVersion: 3,
    kind: "progress",
    challengeKey: "seven_day_reset",
    title: "7-Day Reset",
    submittedCheckIns: 6,
    targetCheckIns: 7,
  };
  for (
    const patch of [
      { challengeKey: "unknown" },
      { challengeKey: "__proto__" },
      { title: "<script>bad</script>" },
      { targetCheckIns: 77 },
      { targetCheckIns: "7" },
      { schemaVersion: 2 },
      { kind: "streak" },
      { submittedCheckIns: 8 },
      { submittedCheckIns: -1 },
      { submittedCheckIns: 1.5 },
      { submittedCheckIns: "6" },
      { submittedCheckIns: null },
      { actorId: "private-owner" },
      { instanceId: snapshotId },
      { scopeKey: `instance:${snapshotId}` },
      { completedAt: "2026-09-30T12:00:00Z" },
      { currentChallengeDay: 6 },
    ]
  ) {
    const response = await testHandler({
      createAdminClient: () =>
        rpcClient(() => ({
          schemaVersion: 3,
          kind: "progress",
          payload: { ...valid, ...patch },
        })),
    })(request("GET", undefined, `share-snapshot/${token}`));
    assertEquals(response.status, 404);
  }
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

Deno.test("progress creation requires the preview run and rejects mismatched protected context", async () => {
  let calls = 0;
  const handler = testHandler({
    createUserClient: () =>
      rpcClient(() => {
        calls++;
        return null;
      }),
  });
  for (const expectedInstanceId of [null, "bad", 1]) {
    const response = await handler(
      request("POST", {
        action: "create",
        kind: "progress",
        expectedInstanceId,
      }),
    );
    assertEquals(response.status, 400);
  }
  assertEquals(calls, 0);
  const snapshot = {
    schemaVersion: 3,
    kind: "progress",
    snapshotId,
    token,
    payload: {
      schemaVersion: 3,
      kind: "progress",
      challengeKey: "seven_day_reset",
      title: "7-Day Reset",
      submittedCheckIns: 1,
      targetCheckIns: 7,
    },
  };
  for (
    const context of [null, { schemaVersion: 1, actorId, instanceId }, {
      schemaVersion: 2,
      actorId: "another-actor",
      instanceId,
    }, { schemaVersion: 2, actorId, instanceId: snapshotId }]
  ) {
    const response = await testHandler({
      createUserClient: () => rpcClient(() => ({ ...snapshot, context })),
    })(
      request("POST", {
        action: "create",
        kind: "progress",
        expectedInstanceId: instanceId,
      }),
    );
    assertEquals(response.status, 500);
    const body = await responseJson(response);
    assertEquals(body.url, undefined);
    assertEquals(body.token, undefined);
  }
});

Deno.test("preview and create reject a valid snapshot for a different requested kind", async () => {
  for (const action of ["preview", "create"]) {
    const response = await testHandler({
      createUserClient: () =>
        rpcClient(() => ({ ...streakSnapshot, snapshotId, token })),
    })(request("POST", { action, kind: "progress" }));
    assertEquals(response.status, 500);
    const body = await responseJson(response);
    assertEquals(body.url, undefined);
    assertEquals(body.payload, undefined);
  }
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
        assertEquals(name, "preview_share_snapshot_v2");
        assertEquals(args, {
          target_kind: "streak",
          target_expected_actor_id: actorId,
          target_expected_instance_id: null,
        });
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
        assertEquals(name, "create_share_snapshot_v2");
        assertEquals(args, {
          target_kind: "progress",
          target_expires_at: null,
          target_expected_actor_id: actorId,
          target_expected_instance_id: instanceId,
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
        assertEquals(name, "create_share_snapshot_v2");
        assertEquals(args, {
          target_kind: "streak",
          target_expires_at: null,
          target_expected_actor_id: actorId,
          target_expected_instance_id: null,
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
        body: JSON.stringify({
          action: "create",
          kind: "streak",
          contractVersion: 2,
          expectedUserId: actorId,
        }),
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
