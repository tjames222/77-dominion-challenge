import { assert, assertEquals, responseJson } from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

const secret = "profile-photo-worker-secret-at-least-32-characters";
const healthSecret = "A".repeat(43);
const userId = "10000000-0000-4000-8000-000000000001";
const jobId = "20000000-0000-4000-8000-000000000002";
const objectId = "30000000-0000-4000-8000-000000000003";
const claimToken = "40000000-0000-4000-8000-000000000004";
const storagePath =
  `${userId}/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp`;

function request(body: Record<string, unknown> = {}, key = secret) {
  return new Request("https://functions.test/process-profile-photo-cleanup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-dominion-worker-key": key,
    },
    body: JSON.stringify(body),
  });
}

function claim() {
  return {
    job_id: jobId,
    user_id: userId,
    storage_path: storagePath,
    storage_object_id: objectId,
    claim_token: claimToken,
  };
}

function setup(options: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const removals: string[][] = [];
  let present = true;
  const values: Record<string, unknown> = {
    claim_profile_photo_cleanup_service: [claim()],
    verify_profile_photo_cleanup_service: true,
    confirm_profile_photo_cleanup_service: true,
    profile_photo_cleanup_health: { ready: 0, staleLeases: 0 },
    fail_profile_photo_cleanup_service: true,
    ...(options.values as Record<string, unknown> || {}),
  };
  const run = createHandler({
    env: (name: string) =>
      name === "PROFILE_PHOTO_WORKER_SECRET"
        ? secret
        : name === "PROFILE_PHOTO_HEALTH_SECRET"
        ? healthSecret
        : undefined,
    delay: async () => undefined,
    logger: { info: () => undefined, error: () => undefined },
    createAdminClient: () =>
      ({
        rpc: async (name: string, args: Record<string, unknown> = {}) => {
          calls.push({ name, args });
          return { data: values[name] ?? null, error: null };
        },
        storage: {
          from: (bucket: string) => {
            assertEquals(bucket, "profile-photos");
            return {
              list: async (
                _folder: string,
                listOptions: Record<string, unknown>,
              ) => ({
                data: present && listOptions.search
                  ? [{ id: objectId, name: storagePath.split("/").pop() }]
                  : [],
                error: null,
              }),
              remove: async (paths: string[]) => {
                removals.push(paths);
                present = false;
                return { error: null };
              },
            };
          },
        },
      }) as any,
    ...options,
  } as any);
  return { run, calls, removals };
}

Deno.test("cleanup worker rejects unsupported methods and bad secrets", async () => {
  const worker = setup();
  assertEquals(
    (await worker.run(new Request("https://functions.test"))).status,
    405,
  );
  assertEquals((await worker.run(request({}, "wrong"))).status, 401);
});

Deno.test("cleanup worker verifies, deletes one exact object, proves absence, and confirms", async () => {
  const worker = setup();
  const result = await worker.run(request({ limit: 10 }));
  assertEquals(result.status, 200);
  assertEquals((await responseJson(result)).counts, {
    claimed: 1,
    confirmed: 1,
    failed: 0,
  });
  assertEquals(worker.removals, [[storagePath]]);
  assertEquals(worker.calls.map((call) => call.name), [
    "claim_profile_photo_cleanup_service",
    "verify_profile_photo_cleanup_service",
    "confirm_profile_photo_cleanup_service",
    "profile_photo_cleanup_health",
  ]);
});

Deno.test("already absent cleanup is idempotently confirmed without delete", async () => {
  const worker = setup({
    createAdminClient: () => {
      const calls: string[] = [];
      return {
        rpc: async (name: string) => {
          calls.push(name);
          return {
            data: name === "claim_profile_photo_cleanup_service"
              ? [claim()]
              : name === "profile_photo_cleanup_health"
              ? { ready: 0 }
              : true,
            error: null,
          };
        },
        storage: {
          from: () => ({
            list: async () => ({ data: [], error: null }),
            remove: async () => {
              throw new Error("must not delete absent object");
            },
          }),
        },
      };
    },
  });
  assertEquals((await worker.run(request())).status, 200);
});

Deno.test("failed deletion is released to database backoff without leaking paths", async () => {
  const logs: string[] = [];
  const worker = setup({
    logger: {
      info: () => undefined,
      error: (value: string) => logs.push(value),
    },
    createAdminClient: () =>
      ({
        rpc: async (name: string) => ({
          data: name === "claim_profile_photo_cleanup_service"
            ? [claim()]
            : name === "profile_photo_cleanup_health"
            ? { ready: 0 }
            : true,
          error: null,
        }),
        storage: {
          from: () => ({
            list: async () => ({
              data: [{ id: objectId, name: storagePath.split("/").pop() }],
              error: null,
            }),
            remove: async () => ({ error: new Error("unavailable") }),
          }),
        },
      }) as any,
  });
  const result = await worker.run(request());
  const resultBody = await responseJson(result) as {
    counts: { failed: number };
  };
  assertEquals(resultBody.counts.failed, 1);
  assert(!logs.join(" ").includes(storagePath));
});

Deno.test("health mode is authenticated and read-only", async () => {
  const worker = setup({
    values: { profile_photo_cleanup_health: { ready: 2 } },
  });
  const result = await worker.run(request({ mode: "health" }));
  assertEquals(result.status, 200);
  const resultBody = await responseJson(result) as {
    health: { ready: number };
  };
  assertEquals(resultBody.health.ready, 2);
  assertEquals(worker.calls.map((call) => call.name), [
    "profile_photo_cleanup_health",
  ]);
});

function snapshot() {
  const time = "2026-09-28T20:00:00.123456+00:00";
  return {
    schemaVersion: 1,
    generatedAt: time,
    cleanup: {
      expiredPending: 0,
      ready: 2,
      leased: 0,
      staleLeases: 0,
      backingOff: 1,
      failuresLastHour: 0,
      oldestReadyAt: time,
      generatedAt: time,
    },
    cron: {
      extensionAvailable: true,
      catalogAvailable: true,
      jobState: "present",
      active: true,
      scheduleMatches: true,
      historyAvailable: true,
      stale: false,
      staleAfterSeconds: 900,
      transportEvidence: "enqueue-only",
      lastRuns: [{
        runId: "9007199254740993",
        status: "succeeded",
        startedAt: time,
        endedAt: time,
      }, {
        runId: "9007199254740992",
        status: "failed",
        startedAt: time,
        endedAt: time,
      }],
    },
  };
}

function rawRequest(
  text: BodyInit | null,
  headers: Record<string, string> = {},
) {
  return new Request("https://functions.test/process-profile-photo-cleanup", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-dominion-health-key": healthSecret,
      ...headers,
    },
  });
}

Deno.test("independent monitor credential calls only bounded monitor RPC, not Storage", async () => {
  const health = snapshot();
  const worker = setup({
    values: { profile_photo_cleanup_monitor_health: health },
  });
  const result = await worker.run(rawRequest('{"mode":"monitor-health"}'));
  assertEquals(result.status, 200);
  assertEquals(result.headers.get("cache-control"), "no-store");
  assertEquals(worker.calls, [{
    name: "profile_photo_cleanup_monitor_health",
    args: {},
  }]);
  assertEquals(worker.removals, []);
  const data = await result.json();
  assertEquals(data.health.cron.lastRuns[0].runId, "9007199254740993");
  assertEquals(data.health.cron.transportEvidence, "enqueue-only");
});

for (
  const [name, text] of Object.entries({
    empty: "",
    array: "[]",
    null: "null",
    malformed: '{"mode":',
    scalar: "true",
    unknown_mode: '{"mode":"delete"}',
    typo: '{"mod":"monitor-health"}',
    duplicate_mode: '{"mode":"health","mode":"monitor-health"}',
    duplicate_limit: '{"limit":1,"limit":2}',
    extra_key: '{"mode":"monitor-health","limit":1}',
    extra_worker_key: '{"limit":1,"unexpected":true}',
    nested: '{"mode":{"mode":"monitor-health"}}',
    escaped_key: '{"mo\\u0064e":"monitor-health"}',
    prototype: '{"__proto__":{}}',
    large: " ".repeat(257),
    string_limit: '{"limit":"1"}',
    null_limit: '{"limit":null}',
    low_limit: '{"limit":0}',
    high_limit: '{"limit":101}',
    fractional_limit: '{"limit":1.5}',
    infinite_limit: '{"limit":1e999}',
    trailing: "{}{}",
  })
) {
  Deno.test(`malformed ${name} never invokes an admin client for either credential`, async () => {
    let clients = 0;
    const worker = setup({
      createAdminClient: () => {
        clients++;
        throw new Error("must not initialize");
      },
    });
    for (const kind of ["monitor", "worker"]) {
      const req = kind === "monitor"
        ? rawRequest(text)
        : new Request("https://functions.test", {
          method: "POST",
          body: text,
          headers: {
            "content-type": "application/json",
            "x-dominion-worker-key": secret,
          },
        });
      assertEquals((await worker.run(req)).status, 400);
    }
    assertEquals(clients, 0);
  });
}

Deno.test("credential modes never cross and mixed headers are refused before client creation", async () => {
  let clients = 0;
  const worker = setup({
    createAdminClient: () => {
      clients++;
      throw new Error("no client");
    },
  });
  const attempts = [
    rawRequest("{}"),
    rawRequest('{"limit":25}'),
    rawRequest('{"mode":"health"}'),
    rawRequest('{"mode":"monitor-health"}', { "x-dominion-worker-key": "" }),
    rawRequest('{"mode":"monitor-health"}', {
      "x-dominion-worker-key": secret,
    }),
    rawRequest('{"mode":"monitor-health"}', {
      "x-dominion-health-key": secret,
    }),
    rawRequest('{"mode":"monitor-health"}', {
      "x-dominion-health-key": healthSecret.slice(0, 42) + "B",
    }),
    request({ mode: "monitor-health" }),
    request({}, healthSecret),
    new Request("https://functions.test", { method: "POST", body: "{}" }),
  ];
  for (const req of attempts) assertEquals((await worker.run(req)).status, 401);
  assertEquals(clients, 0);
});

for (
  const [name, expected] of Object.entries({
    missing: undefined,
    short: "x",
    alias: "A".repeat(42) + "B",
    padding: healthSecret + "=",
    long: "A".repeat(1000),
    collision: healthSecret,
  })
) {
  Deno.test(`invalid configured health credential ${name} fails closed`, async () => {
    const worker = setup({
      env: (key: string) =>
        key === "PROFILE_PHOTO_HEALTH_SECRET"
          ? expected
          : key === "PROFILE_PHOTO_WORKER_SECRET"
          ? (name === "collision" ? healthSecret : secret)
          : undefined,
    });
    assertEquals(
      (await worker.run(rawRequest('{"mode":"monitor-health"}'))).status,
      401,
    );
    assertEquals(worker.calls, []);
  });
}

for (
  const headers of [
    { "content-type": "text/plain" },
    { "content-encoding": "gzip" },
    { "content-length": "257" },
    { "content-length": "no" },
  ] as Array<Record<string, string>>
) {
  Deno.test(`invalid transport metadata ${JSON.stringify(headers)} refuses all RPCs`, async () => {
    const worker = setup();
    assertEquals(
      (await worker.run(rawRequest('{"mode":"monitor-health"}', headers)))
        .status,
      400,
    );
    assertEquals(worker.calls, []);
  });
}

Deno.test("streamed body bounds, invalid UTF8 and stalled body cannot reach cleanup", async () => {
  for (
    const input of [
      new Uint8Array([0xff]),
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(200));
          controller.enqueue(new Uint8Array(100));
          controller.close();
        },
      }),
      new ReadableStream({ cancel() {} }),
    ]
  ) {
    const worker = setup();
    assertEquals((await worker.run(rawRequest(input))).status, 400);
    assertEquals(worker.calls, []);
  }
});

Deno.test("valid default and numeric worker requests preserve bounded claim limits", async () => {
  for (
    const [text, limit] of [["{}", 25], ['{"limit":1}', 1], [
      '{"limit":1e2}',
      100,
    ]] as const
  ) {
    const worker = setup({
      values: { claim_profile_photo_cleanup_service: [] },
    });
    const req = new Request("https://functions.test", {
      method: "POST",
      body: text,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-dominion-worker-key": secret,
      },
    });
    assertEquals((await worker.run(req)).status, 200);
    assertEquals(worker.calls[0], {
      name: "claim_profile_photo_cleanup_service",
      args: { target_limit: limit },
    });
  }
});

Deno.test("monitor output strips unrelated payloads and does not log RPC content", async () => {
  const forbidden = `${storagePath}|${secret}|select net.http_post('secret')`;
  const health: any = snapshot();
  health.raw = forbidden;
  health.cleanup.paths = forbidden;
  health.cron.command = forbidden;
  health.cron.lastRuns[0].return_message = forbidden;
  const logs: string[] = [];
  const worker = setup({
    values: { profile_photo_cleanup_monitor_health: health },
    logger: {
      info: (value: string) => logs.push(value),
      error: (value: string) => logs.push(value),
    },
  });
  const result = await worker.run(rawRequest('{"mode":"monitor-health"}'));
  assertEquals(result.status, 200);
  assert(!(await result.text()).includes(forbidden));
  assertEquals(logs, []);
});

const invalidSnapshots: Record<string, (health: any) => unknown> = {
  missing: () => null,
  version: (h) => {
    h.schemaVersion = 2;
    return h;
  },
  negative: (h) => {
    h.cleanup.ready = -1;
    return h;
  },
  huge: (h) => {
    h.cleanup.ready = 2 ** 54;
    return h;
  },
  count_string: (h) => {
    h.cleanup.ready = "secret";
    return h;
  },
  date: (h) => {
    h.generatedAt = "secret";
    return h;
  },
  too_many_runs: (h) => {
    h.cron.lastRuns.push(h.cron.lastRuns[0]);
    return h;
  },
  run_alias: (h) => {
    h.cron.lastRuns[0].runId = "01";
    return h;
  },
  run_overflow: (h) => {
    h.cron.lastRuns[0].runId = "9223372036854775808";
    return h;
  },
  repeated_run: (h) => {
    h.cron.lastRuns[0].runId = h.cron.lastRuns[1].runId;
    return h;
  },
  unsafe_status: (h) => {
    h.cron.lastRuns[0].status = "secret/path";
    return h;
  },
  false_http_claim: (h) => {
    h.cron.transportEvidence = "delivered";
    return h;
  },
  inconsistent_history: (h) => {
    h.cron.historyAvailable = false;
    return h;
  },
  inconsistent_job: (h) => {
    h.cron.jobState = "missing";
    return h;
  },
  invalid_active: (h) => {
    h.cron.active = null;
    return h;
  },
  unavailable_catalog: (h) => {
    h.cron.catalogAvailable = false;
    return h;
  },
};
for (const [name, mutate] of Object.entries(invalidSnapshots)) {
  Deno.test(`invalid monitor response ${name} is fixed-error only and never starts cleanup`, async () => {
    const logs: string[] = [];
    const worker = setup({
      values: { profile_photo_cleanup_monitor_health: mutate(snapshot()) },
      logger: {
        info: (value: string) => logs.push(value),
        error: (value: string) => logs.push(value),
      },
    });
    const result = await worker.run(rawRequest('{"mode":"monitor-health"}'));
    assertEquals(result.status, 500);
    assertEquals(await result.json(), {
      error: "Unable to process profile-photo cleanup.",
    });
    assertEquals(logs, ['{"event":"profile-photo.cleanup.worker-failed"}']);
    assertEquals(worker.calls.map((x) => x.name), [
      "profile_photo_cleanup_monitor_health",
    ]);
    assertEquals(worker.removals, []);
  });
}

Deno.test("missing optional monitor secret never disables existing worker health", async () => {
  const worker = setup({
    env: (name: string) =>
      name === "PROFILE_PHOTO_WORKER_SECRET" ? secret : undefined,
  });
  assertEquals((await worker.run(request({ mode: "health" }))).status, 200);
  assertEquals(worker.calls.map((call) => call.name), [
    "profile_photo_cleanup_health",
  ]);
});

Deno.test("monitor RPC errors with private payloads remain fixed errors, not cleanup fallback", async () => {
  const calls: string[] = [], logs: string[] = [];
  const worker = setup({
    createAdminClient: () => ({
      rpc: async (name: string) => {
        calls.push(name);
        return {
          data: null,
          error: new Error(
            `${healthSecret}|${storagePath}|SECRET_CRON_COMMAND`,
          ),
        };
      },
    }),
    logger: {
      info: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    },
  });
  const result = await worker.run(rawRequest('{"mode":"monitor-health"}'));
  assertEquals(result.status, 500);
  assertEquals(await result.json(), {
    error: "Unable to process profile-photo cleanup.",
  });
  assertEquals(calls, ["profile_photo_cleanup_monitor_health"]);
  assertEquals(logs, ['{"event":"profile-photo.cleanup.worker-failed"}']);
});

for (const jobState of ["unavailable", "missing", "ambiguous"]) {
  Deno.test(`unhealthy ${jobState} snapshot remains explicit and bounded`, async () => {
    const data: any = snapshot();
    Object.assign(data.cron, {
      jobState,
      extensionAvailable: jobState !== "unavailable",
      catalogAvailable: jobState !== "unavailable",
      active: null,
      scheduleMatches: null,
      historyAvailable: false,
      stale: true,
      lastRuns: [],
    });
    const worker = setup({
      values: { profile_photo_cleanup_monitor_health: data },
    });
    const result = await worker.run(rawRequest('{"mode":"monitor-health"}'));
    assertEquals(result.status, 200);
    const output = await result.json();
    assertEquals(output.health.cron.jobState, jobState);
    assertEquals(output.health.cron.stale, true);
    assertEquals(output.health.cron.lastRuns, []);
  });
}

Deno.test("unsupported HTTP methods reject without credential or body processing", async () => {
  const worker = setup();
  for (const method of ["GET", "HEAD", "OPTIONS", "DELETE", "PUT", "PATCH"]) {
    const result = await worker.run(
      new Request("https://functions.test", {
        method,
        headers: { "x-dominion-health-key": healthSecret },
      }),
    );
    assertEquals(result.status, 405);
  }
  assertEquals(worker.calls, []);
});
