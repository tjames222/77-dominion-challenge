import { assert, assertEquals, responseJson } from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

const secret = "profile-photo-worker-secret-at-least-32-characters";
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
      name === "PROFILE_PHOTO_WORKER_SECRET" ? secret : undefined,
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
