import { assert, assertEquals, responseJson } from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

const workerSecret = "retention-worker-secret-with-more-than-32-characters";
const drSecret = "retention-dr-signing-secret-with-more-than-32-characters";
const batchId = "10000000-0000-4000-8000-000000000001";
const workId = "20000000-0000-4000-8000-000000000002";
const workerToken = "30000000-0000-4000-8000-000000000003";
const objectId = "40000000-0000-4000-8000-000000000004";
const destinationId = "50000000-0000-4000-8000-000000000005";
const objectName =
  "60000000-0000-4000-8000-000000000006/70000000-0000-4000-8000-000000000007/photo.jpg";
const credentialKeys = JSON.stringify({
  1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
});

type RpcCall = { name: string; args: Record<string, unknown> };

function environment(name: string) {
  return {
    RETIRED_COMMUNITY_WORKER_SECRET: workerSecret,
    RETIRED_COMMUNITY_DR_HMAC_SECRET: drSecret,
    INTEGRATION_CREDENTIAL_KEYS: credentialKeys,
  }[name];
}

function request(
  body: unknown = { mode: "process", batchId },
  secret = workerSecret,
) {
  return new Request(
    "https://functions.test/process-retired-community-deletions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dominion-worker-key": secret,
      },
      body: JSON.stringify(body),
    },
  );
}

function storageClaim(bucketId = "community-post-images") {
  return {
    work_id: workId,
    bucket_id: bucketId,
    object_name: objectName,
    expected_row_sha256: "a".repeat(64),
  };
}

function credentialClaim() {
  return {
    work_id: workId,
    destination_id: destinationId,
    provider: "slack",
    provider_workspace_id: "T1",
    provider_destination_id: "C1",
    credential_ciphertext: "AA==",
    credential_nonce: "AAAAAAAAAAAAAAAA",
    credential_key_version: 1,
  };
}

function mockAdmin(options: {
  values?: Record<string, unknown>;
  calls?: RpcCall[];
  buckets?: string[];
  list?: (folder: string, options: Record<string, unknown>) => unknown[];
  remove?: (paths: string[]) => { error?: unknown };
}) {
  return {
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      options.calls?.push({ name, args });
      const value = options.values?.[name];
      if (value instanceof Error) return { data: null, error: value };
      return { data: value ?? null, error: null };
    },
    storage: {
      from: (bucket: string) => {
        assert([
          "community-post-images",
          "profile-photos",
          "journal-progress",
        ].includes(bucket));
        options.buckets?.push(bucket);
        return {
          list: async (
            folder: string,
            listOptions: Record<string, unknown>,
          ) => ({
            data: options.list?.(folder, listOptions) || [],
            error: null,
          }),
          remove: async (paths: string[]) =>
            options.remove?.(paths) || { error: null },
        };
      },
    },
  };
}

function workerHandler(
  admin: ReturnType<typeof mockAdmin>,
  overrides: Record<string, unknown> = {},
) {
  return createHandler({
    env: environment,
    createAdminClient: () => admin as any,
    randomUuid: () => workerToken,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    delay: async () => undefined,
    logger: { info: () => undefined, error: () => undefined },
    decryptProviderCredential: async () => ({
      accessToken: "provider-secret-token",
    }),
    revokeProviderCredential: async () => true,
    ...overrides,
  } as any);
}

Deno.test("retention worker rejects unsupported methods and unauthenticated callers", async () => {
  const handler = workerHandler(mockAdmin({}));
  const method = await handler(
    new Request("https://functions.test", { method: "GET" }),
  );
  assertEquals(method.status, 405);
  const unauthorized = await handler(request({}, "wrong-secret"));
  assertEquals(unauthorized.status, 401);
  assertEquals((await responseJson(unauthorized)).error, "Not authorized.");
});

Deno.test("account erasure deletes an exact profile-photo claim from its own bucket", async () => {
  const buckets: string[] = [];
  let present = true;
  const admin = mockAdmin({
    buckets,
    values: {
      claim_retired_community_storage_work: [storageClaim("profile-photos")],
      claim_retired_community_credential_work: [],
      verify_retired_community_storage_work: true,
      confirm_retired_community_storage_work: {},
    },
    list: (_folder, options) =>
      present && options.search === "photo.jpg"
        ? [{ id: objectId, name: "photo.jpg" }]
        : [],
    remove: () => {
      present = false;
      return { error: null };
    },
  });

  const result = await workerHandler(admin)(request());
  assertEquals(result.status, 200);
  assert(buckets.includes("profile-photos"));
  assert(!buckets.includes("community-post-images"));
});

Deno.test("Storage work is reverified, deleted by exact path, checked absent, and confirmed", async () => {
  const calls: RpcCall[] = [];
  const removed: string[][] = [];
  const logs: string[] = [];
  let present = true;
  const admin = mockAdmin({
    calls,
    values: {
      claim_retired_community_storage_work: [storageClaim()],
      claim_retired_community_credential_work: [],
      verify_retired_community_storage_work: true,
      confirm_retired_community_storage_work: {
        batchId,
        status: "ready",
        counts: { objects: 1 },
      },
    },
    list: (_folder, options) =>
      present && options.search === "photo.jpg"
        ? [{ id: objectId, name: "photo.jpg", metadata: { size: 10 } }]
        : [],
    remove: (paths) => {
      removed.push(paths);
      present = false;
      return { error: null };
    },
  });
  const result = await workerHandler(admin, {
    logger: {
      info: (value: string) => logs.push(value),
      error: () => undefined,
    },
  })(request());

  assertEquals(result.status, 200);
  const resultCounts = (await responseJson(result)).counts as Record<
    string,
    unknown
  >;
  assertEquals(resultCounts.storageConfirmed, 1);
  assertEquals(removed, [[objectName]]);
  assertEquals(calls.map((call) => call.name), [
    "claim_retired_community_storage_work",
    "claim_retired_community_credential_work",
    "verify_retired_community_storage_work",
    "confirm_retired_community_storage_work",
  ]);
  const verify = calls.find((call) =>
    call.name === "verify_retired_community_storage_work"
  );
  assertEquals(verify?.args.target_work_id, workId);
  assert(!logs.join(" ").includes(objectName));
  assert(!logs.join(" ").includes("a".repeat(64)));
});

Deno.test("exact Storage lookup paginates through more than 100 search collisions", async () => {
  const offsets: number[] = [];
  const removed: string[][] = [];
  let present = true;
  const result = await workerHandler(mockAdmin({
    values: {
      claim_retired_community_storage_work: [storageClaim()],
      claim_retired_community_credential_work: [],
      verify_retired_community_storage_work: true,
      confirm_retired_community_storage_work: {},
    },
    list: (_folder, options) => {
      const offset = Number(options.offset);
      offsets.push(offset);
      if (offset === 0) {
        return Array.from({ length: 100 }, (_, index) => ({
          id: `collision-${index}`,
          name: `photo.jpg-${index}`,
        }));
      }
      return present && offset === 100
        ? [{ id: objectId, name: "photo.jpg" }]
        : [];
    },
    remove: (paths) => {
      removed.push(paths);
      present = false;
      return { error: null };
    },
  }))(request());

  assertEquals(result.status, 200);
  assertEquals(removed, [[objectName]]);
  assert(offsets.filter((offset) => offset === 100).length >= 2);
});

Deno.test("an already-absent Storage path confirms safely without a second delete", async () => {
  const calls: RpcCall[] = [];
  let removed = false;
  const result = await workerHandler(mockAdmin({
    calls,
    values: {
      claim_retired_community_storage_work: [storageClaim()],
      claim_retired_community_credential_work: [],
      confirm_retired_community_storage_work: {},
    },
    list: () => [],
    remove: () => {
      removed = true;
      return { error: null };
    },
  }))(request());
  assertEquals(result.status, 200);
  assertEquals(removed, false);
  assert(
    !calls.some((call) =>
      call.name === "verify_retired_community_storage_work"
    ),
  );
  assert(
    calls.some((call) =>
      call.name === "confirm_retired_community_storage_work"
    ),
  );
});

Deno.test("credential work decrypts, revokes idempotently, confirms, and never logs secrets", async () => {
  const calls: RpcCall[] = [];
  const logs: string[] = [];
  let revokedToken = "";
  const result = await workerHandler(
    mockAdmin({
      calls,
      values: {
        claim_retired_community_storage_work: [],
        claim_retired_community_credential_work: [credentialClaim()],
        confirm_retired_community_credential_work: {},
      },
    }),
    {
      revokeProviderCredential: async (_provider: string, token: string) => {
        revokedToken = token;
        return true;
      },
      logger: {
        info: (value: string) => logs.push(value),
        error: (value: string) => logs.push(value),
      },
    },
  )(request());
  assertEquals(result.status, 200);
  assertEquals(revokedToken, "provider-secret-token");
  const resultCounts = (await responseJson(result)).counts as Record<
    string,
    unknown
  >;
  assertEquals(resultCounts.credentialsConfirmed, 1);
  const confirm = calls.find((call) =>
    call.name === "confirm_retired_community_credential_work"
  );
  assertEquals(
    confirm?.args.target_provider_revocation_reference,
    "slack:revoked",
  );
  assert(!logs.join(" ").includes("provider-secret-token"));
  assert(!logs.join(" ").includes("AA=="));
});

Deno.test("worker retries provider failures three times and returns only aggregate failure", async () => {
  let attempts = 0;
  const errors: string[] = [];
  const calls: RpcCall[] = [];
  const result = await workerHandler(
    mockAdmin({
      calls,
      values: {
        claim_retired_community_storage_work: [],
        claim_retired_community_credential_work: [credentialClaim()],
      },
    }),
    {
      revokeProviderCredential: async () => {
        attempts += 1;
        throw new Error("provider-secret-error-body");
      },
      logger: {
        info: () => undefined,
        error: (value: string) => errors.push(value),
      },
    },
  )(request());
  assertEquals(result.status, 200);
  assertEquals(attempts, 3);
  const resultCounts = (await responseJson(result)).counts as Record<
    string,
    unknown
  >;
  assertEquals(resultCounts.credentialsFailed, 1);
  const failure = calls.find((call) =>
    call.name === "fail_retired_community_work"
  );
  assertEquals(failure?.args.target_work_kind, "credential");
  assertEquals(
    failure?.args.target_error_code,
    "credential_retry_exhausted",
  );
  assert(!errors.join(" ").includes("provider-secret-error-body"));
});

Deno.test("scan mode recursively records one complete exact bucket inventory", async () => {
  const calls: RpcCall[] = [];
  const admin = mockAdmin({
    calls,
    values: {
      record_retired_community_orphan_scan: {
        scanId: workerToken,
        status: "complete",
        counts: { objects: 2 },
      },
    },
    list: (folder) => {
      if (folder === "") return [{ id: null, name: "crew-a" }];
      if (folder === "crew-a") {
        return [
          { id: objectId, name: "one.jpg" },
          { id: "80000000-0000-4000-8000-000000000008", name: "two.jpg" },
        ];
      }
      return [];
    },
  });
  const result = await workerHandler(admin)(request({ mode: "scan" }));
  assertEquals(result.status, 200);
  const record = calls.find((call) =>
    call.name === "record_retired_community_orphan_scan"
  );
  assertEquals(record?.args.target_scan_id, workerToken);
  assertEquals(record?.args.target_inventory, [
    {
      objectId,
      bucketId: "community-post-images",
      objectName: "crew-a/one.jpg",
    },
    {
      objectId: "80000000-0000-4000-8000-000000000008",
      bucketId: "community-post-images",
      objectName: "crew-a/two.jpg",
    },
  ]);
});

Deno.test("DR export is signed and only an untampered envelope can be reapplied", async () => {
  const calls: RpcCall[] = [];
  const manifest = {
    schemaVersion: 1,
    batchId,
    reason: "orphan_cleanup",
    executedAt: "2026-07-20T00:00:00Z",
    expiresAt: "2027-01-16T00:00:00Z",
    t0SourceSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64),
    bundleSha256: "c".repeat(64),
    counts: { posts: 0, comments: 0, likes: 0, objects: 1, credentials: 0 },
    manifestSha256: "d".repeat(64),
  };
  const admin = mockAdmin({
    calls,
    values: {
      export_retired_community_dr_ledger: [manifest],
      import_retired_community_dr_manifest: { status: "storage_pending" },
    },
  });
  const exported = await workerHandler(admin)(request({ mode: "dr-export" }));
  const envelope = (await responseJson(exported)).ledger as {
    signature: string;
    manifests: Array<{ counts: { objects: number } }>;
  };
  assertEquals(typeof envelope.signature, "string");
  assert(!JSON.stringify(envelope).includes("objectName"));

  const imported = await workerHandler(admin)(
    request({ mode: "dr-apply", envelope }),
  );
  assertEquals(imported.status, 200);
  const importedCounts = (await responseJson(imported)).counts as Record<
    string,
    unknown
  >;
  assertEquals(importedCounts.manifests, 1);
  assert(
    calls.some((call) => call.name === "import_retired_community_dr_manifest"),
  );

  envelope.manifests[0].counts.objects = 99;
  const tampered = await workerHandler(admin)(
    request({ mode: "dr-apply", envelope }),
  );
  assertEquals(tampered.status, 500);
  assertEquals(
    (await responseJson(tampered)).error,
    "Retired Community worker failed.",
  );
});

Deno.test("health and maintenance expose aggregate signals only", async () => {
  const health = {
    status: "ok",
    counts: { storagePending: 2, backupReverificationDue: 1 },
  };
  const admin = mockAdmin({
    values: {
      retired_community_deletion_health: health,
      purge_expired_retired_community_manifests: {
        status: "complete",
        counts: { manifestsDeleted: 3 },
      },
    },
  });
  const healthResponse = await workerHandler(admin)(
    request({ mode: "health" }),
  );
  assertEquals(await responseJson(healthResponse), health);
  const maintenance = await workerHandler(admin)(
    request({ mode: "maintenance" }),
  );
  const maintenanceBody = await responseJson(maintenance);
  assertEquals(maintenanceBody.status, "complete");
  assert(!JSON.stringify(maintenanceBody).includes(objectName));
});
