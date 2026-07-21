import { createAdminClient } from "../_shared/supabase.ts";
import { type EnvReader, readEnv } from "../_shared/http.ts";
import {
  decryptProviderCredential,
  parseCredentialKeys,
} from "../_shared/integration_delivery.ts";
import { revokeProviderCredential } from "../_shared/integration_providers.ts";

type AdminClient = ReturnType<typeof createAdminClient>;
type WorkerLogger = Pick<Console, "info" | "error">;
type StorageFile = {
  id?: string | null;
  name: string;
  metadata?: unknown;
};
type StorageClaim = {
  work_id: string;
  bucket_id: string;
  object_name: string;
  expected_row_sha256: string;
};
type CredentialClaim = {
  work_id: string;
  destination_id: string;
  provider: "slack" | "discord";
  provider_workspace_id: string;
  provider_destination_id: string;
  credential_ciphertext: string | Uint8Array;
  credential_nonce: string | Uint8Array;
  credential_key_version: number;
};

type Dependencies = {
  createAdminClient: typeof createAdminClient;
  env: EnvReader;
  decryptProviderCredential: typeof decryptProviderCredential;
  revokeProviderCredential: typeof revokeProviderCredential;
  randomUuid: () => string;
  now: () => Date;
  delay: (milliseconds: number) => Promise<void>;
  logger: WorkerLogger;
};

const defaultDependencies: Dependencies = {
  createAdminClient,
  env: readEnv,
  decryptProviderCredential,
  revokeProviderCredential,
  randomUuid: () => crypto.randomUUID(),
  now: () => new Date(),
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger: console,
};

const scanBucketId = "community-post-images";
const deletionBucketIds = new Set([
  "community-post-images",
  "profile-photos",
  "journal-progress",
]);
const actor = "edge-retention-worker";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shaPattern = /^[0-9a-f]{64}$/;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function validWorkerSecret(req: Request, env: EnvReader) {
  const expected = env("RETIRED_COMMUNITY_WORKER_SECRET") || "";
  const provided = req.headers.get("x-dominion-worker-key") || "";
  if (expected.length < 32 || !provided) return false;
  const [left, right] = await Promise.all([digest(expected), digest(provided)]);
  return constantTimeEqual(left, right);
}

async function rpc<T>(
  admin: AdminClient,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`Retired Community RPC failed: ${name}.`);
  return data as T;
}

function parseBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function boundedLimit(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("Invalid worker batch limit.");
  }
  return parsed;
}

function validateRuntimeConfiguration(dependencies: Dependencies) {
  const workerSecret = dependencies.env("RETIRED_COMMUNITY_WORKER_SECRET") ||
    "";
  const drSecret = dependencies.env("RETIRED_COMMUNITY_DR_HMAC_SECRET") || "";
  const credentialKeys = dependencies.env("INTEGRATION_CREDENTIAL_KEYS") || "";
  if (
    workerSecret.length < 32 || drSecret.length < 32 ||
    workerSecret === drSecret || !credentialKeys
  ) {
    throw new Error("Retired Community worker configuration is incomplete.");
  }
  parseCredentialKeys(credentialKeys);
}

function validObjectPath(value: string) {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") &&
    !value.endsWith("/") && !value.includes("//") &&
    value.split("/").every((part) => part !== "." && part !== "..");
}

function safeStorageClaim(value: unknown): StorageClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Storage claim.");
  }
  const claim = value as Record<string, unknown>;
  if (
    typeof claim.work_id !== "string" || !uuidPattern.test(claim.work_id) ||
    typeof claim.bucket_id !== "string" ||
    !deletionBucketIds.has(claim.bucket_id) ||
    typeof claim.object_name !== "string" ||
    !validObjectPath(claim.object_name) ||
    typeof claim.expected_row_sha256 !== "string" ||
    !shaPattern.test(claim.expected_row_sha256)
  ) {
    throw new Error("Invalid Storage claim.");
  }
  return claim as StorageClaim;
}

function safeCredentialClaim(value: unknown): CredentialClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid credential claim.");
  }
  const claim = value as Record<string, unknown>;
  if (
    typeof claim.work_id !== "string" || !uuidPattern.test(claim.work_id) ||
    typeof claim.destination_id !== "string" ||
    !uuidPattern.test(claim.destination_id) ||
    (claim.provider !== "slack" && claim.provider !== "discord") ||
    typeof claim.provider_workspace_id !== "string" ||
    !claim.provider_workspace_id ||
    typeof claim.provider_destination_id !== "string" ||
    !claim.provider_destination_id ||
    (typeof claim.credential_ciphertext !== "string" &&
      !(claim.credential_ciphertext instanceof Uint8Array)) ||
    (typeof claim.credential_nonce !== "string" &&
      !(claim.credential_nonce instanceof Uint8Array)) ||
    !Number.isInteger(claim.credential_key_version) ||
    Number(claim.credential_key_version) < 1
  ) {
    throw new Error("Invalid credential claim.");
  }
  return claim as CredentialClaim;
}

function splitObjectPath(objectName: string) {
  const parts = objectName.split("/");
  const name = parts.pop()!;
  return { folder: parts.join("/"), name };
}

async function listFolder(
  admin: AdminClient,
  bucket: string,
  folder: string,
  options: Record<string, unknown>,
) {
  const { data, error } = await admin.storage.from(bucket).list(
    folder,
    options,
  );
  if (error || !Array.isArray(data)) {
    throw new Error("Storage inventory could not be read.");
  }
  return data as StorageFile[];
}

async function findExactObject(
  admin: AdminClient,
  bucket: string,
  objectName: string,
) {
  const { folder, name } = splitObjectPath(objectName);
  let offset = 0;
  let exact: StorageFile | null = null;
  while (true) {
    const files = await listFolder(admin, bucket, folder, {
      limit: 100,
      offset,
      search: name,
      sortBy: { column: "name", order: "asc" },
    });
    for (const file of files) {
      if (file.id && file.name === name) {
        if (exact) throw new Error("Storage identity is ambiguous.");
        exact = file;
      }
    }
    if (files.length < 100) return exact;
    offset += files.length;
  }
}

async function collectBucketInventory(admin: AdminClient) {
  const folders = [""];
  const visited = new Set<string>();
  const inventory: Array<{
    objectId: string;
    bucketId: string;
    objectName: string;
  }> = [];

  while (folders.length) {
    const folder = folders.shift()!;
    if (visited.has(folder)) continue;
    visited.add(folder);
    let offset = 0;
    while (true) {
      const files = await listFolder(admin, scanBucketId, folder, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      for (const file of files) {
        if (!file.name || file.name.includes("/")) {
          throw new Error("Storage inventory returned an invalid child name.");
        }
        const objectName = folder ? `${folder}/${file.name}` : file.name;
        if (!validObjectPath(objectName)) {
          throw new Error("Storage inventory returned an invalid object path.");
        }
        if (file.id) {
          if (!uuidPattern.test(file.id)) {
            throw new Error("Storage inventory returned an invalid object ID.");
          }
          inventory.push({
            objectId: file.id,
            bucketId: scanBucketId,
            objectName,
          });
        } else {
          folders.push(objectName);
        }
      }
      if (files.length < 100) break;
      offset += files.length;
    }
  }
  inventory.sort((left, right) =>
    left.objectName.localeCompare(right.objectName) ||
    left.objectId.localeCompare(right.objectId)
  );
  return inventory;
}

async function withRetries(
  operation: () => Promise<void>,
  dependencies: Dependencies,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await dependencies.delay(100 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function processStorageClaim(
  admin: AdminClient,
  batchId: string,
  workerToken: string,
  claim: StorageClaim,
  dependencies: Dependencies,
) {
  await withRetries(async () => {
    const current = await findExactObject(
      admin,
      claim.bucket_id,
      claim.object_name,
    );
    if (current) {
      await rpc<boolean>(admin, "verify_retired_community_storage_work", {
        target_batch_id: batchId,
        target_work_id: claim.work_id,
        target_worker_token: workerToken,
      });
      const { error } = await admin.storage.from(claim.bucket_id).remove([
        claim.object_name,
      ]);
      if (error) {
        const afterError = await findExactObject(
          admin,
          claim.bucket_id,
          claim.object_name,
        );
        if (afterError) throw new Error("Storage API deletion failed.");
      }
    }
    if (await findExactObject(admin, claim.bucket_id, claim.object_name)) {
      throw new Error("Storage object remains after deletion.");
    }
    await rpc(admin, "confirm_retired_community_storage_work", {
      target_batch_id: batchId,
      target_work_id: claim.work_id,
      target_worker_token: workerToken,
      target_actor: actor,
    });
  }, dependencies);
}

async function processCredentialClaim(
  admin: AdminClient,
  batchId: string,
  workerToken: string,
  claim: CredentialClaim,
  keys: Map<number, Uint8Array>,
  dependencies: Dependencies,
) {
  await withRetries(async () => {
    const credential = await dependencies.decryptProviderCredential(
      claim,
      keys,
    );
    const revoked = await dependencies.revokeProviderCredential(
      claim.provider,
      credential.accessToken,
      claim.provider_workspace_id,
    );
    if (!revoked) throw new Error("Provider credential revocation failed.");
    await rpc(admin, "confirm_retired_community_credential_work", {
      target_batch_id: batchId,
      target_work_id: claim.work_id,
      target_worker_token: workerToken,
      target_actor: actor,
      target_provider_revocation_reference: `${claim.provider}:revoked`,
    });
  }, dependencies);
}

async function processBatch(
  admin: AdminClient,
  body: Record<string, unknown>,
  dependencies: Dependencies,
) {
  const batchId = requiredUuid(body.batchId, "batch ID");
  const workerToken = dependencies.randomUuid();
  const storageLimit = boundedLimit(body.storageLimit, 25, 100);
  const credentialLimit = boundedLimit(body.credentialLimit, 10, 20);
  const storageClaims = (await rpc<unknown[]>(
    admin,
    "claim_retired_community_storage_work",
    {
      target_batch_id: batchId,
      target_worker_token: workerToken,
      target_limit: storageLimit,
    },
  ) || []).map(safeStorageClaim);
  const credentialClaims = (await rpc<unknown[]>(
    admin,
    "claim_retired_community_credential_work",
    {
      target_batch_id: batchId,
      target_worker_token: workerToken,
      target_limit: credentialLimit,
    },
  ) || []).map(safeCredentialClaim);
  const counts = {
    storageClaimed: storageClaims.length,
    storageConfirmed: 0,
    storageFailed: 0,
    credentialsClaimed: credentialClaims.length,
    credentialsConfirmed: 0,
    credentialsFailed: 0,
  };

  for (const claim of storageClaims) {
    try {
      await processStorageClaim(
        admin,
        batchId,
        workerToken,
        claim,
        dependencies,
      );
      counts.storageConfirmed += 1;
    } catch {
      counts.storageFailed += 1;
      try {
        await rpc(admin, "fail_retired_community_work", {
          target_work_kind: "storage",
          target_batch_id: batchId,
          target_work_id: claim.work_id,
          target_worker_token: workerToken,
          target_error_code: "storage_retry_exhausted",
        });
      } catch {
        dependencies.logger.error(JSON.stringify({
          event: "retention.failure-telemetry.failed",
          batchId,
          workId: claim.work_id,
          workKind: "storage",
        }));
      }
      dependencies.logger.error(JSON.stringify({
        event: "retention.storage.failed",
        batchId,
        workId: claim.work_id,
      }));
    }
  }

  let keys: Map<number, Uint8Array> | null = null;
  if (credentialClaims.length) {
    const serialized = dependencies.env("INTEGRATION_CREDENTIAL_KEYS");
    if (!serialized) {
      throw new Error("Integration credential keys are unavailable.");
    }
    keys = parseCredentialKeys(serialized);
  }
  for (const claim of credentialClaims) {
    try {
      await processCredentialClaim(
        admin,
        batchId,
        workerToken,
        claim,
        keys!,
        dependencies,
      );
      counts.credentialsConfirmed += 1;
    } catch {
      counts.credentialsFailed += 1;
      try {
        await rpc(admin, "fail_retired_community_work", {
          target_work_kind: "credential",
          target_batch_id: batchId,
          target_work_id: claim.work_id,
          target_worker_token: workerToken,
          target_error_code: "credential_retry_exhausted",
        });
      } catch {
        dependencies.logger.error(JSON.stringify({
          event: "retention.failure-telemetry.failed",
          batchId,
          workId: claim.work_id,
          workKind: "credential",
        }));
      }
      dependencies.logger.error(JSON.stringify({
        event: "retention.credential.failed",
        batchId,
        workId: claim.work_id,
        provider: claim.provider,
      }));
    }
  }
  dependencies.logger.info(JSON.stringify({
    event: "retention.batch.processed",
    batchId,
    counts,
  }));
  return { batchId, status: "processed", counts };
}

function bytesToBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function hmac(value: string, secret: string) {
  if (secret.length < 32) {
    throw new Error("DR ledger signing secret is unavailable.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

function unsignedEnvelope(envelope: Record<string, unknown>) {
  return {
    schemaVersion: envelope.schemaVersion,
    exportedAt: envelope.exportedAt,
    manifests: envelope.manifests,
  };
}

async function exportDrLedger(
  admin: AdminClient,
  dependencies: Dependencies,
) {
  const manifests = await rpc<unknown[]>(
    admin,
    "export_retired_community_dr_ledger",
  ) || [];
  const envelope: Record<string, unknown> = {
    schemaVersion: 1,
    exportedAt: dependencies.now().toISOString(),
    manifests,
  };
  envelope.signature = await hmac(
    JSON.stringify(unsignedEnvelope(envelope)),
    dependencies.env("RETIRED_COMMUNITY_DR_HMAC_SECRET") || "",
  );
  return envelope;
}

async function importDrLedger(
  admin: AdminClient,
  body: Record<string, unknown>,
  dependencies: Dependencies,
) {
  if (
    !body.envelope || typeof body.envelope !== "object" ||
    Array.isArray(body.envelope)
  ) {
    throw new Error("A signed DR envelope is required.");
  }
  const envelope = body.envelope as Record<string, unknown>;
  if (
    envelope.schemaVersion !== 1 || typeof envelope.exportedAt !== "string" ||
    !Array.isArray(envelope.manifests) || typeof envelope.signature !== "string"
  ) {
    throw new Error("The signed DR envelope is invalid.");
  }
  const expected = await hmac(
    JSON.stringify(unsignedEnvelope(envelope)),
    dependencies.env("RETIRED_COMMUNITY_DR_HMAC_SECRET") || "",
  );
  if (
    !constantTimeEqual(await digest(expected), await digest(envelope.signature))
  ) {
    throw new Error("The signed DR envelope is invalid.");
  }
  let imported = 0;
  for (const manifest of envelope.manifests) {
    await rpc(admin, "import_retired_community_dr_manifest", {
      target_manifest: manifest,
      target_imported_by: actor,
    });
    imported += 1;
  }
  return { status: "imported", counts: { manifests: imported } };
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (req: Request) => {
    if (req.method !== "POST") {
      return response({ error: "Method not allowed." }, 405);
    }
    if (!(await validWorkerSecret(req, dependencies.env))) {
      return response({ error: "Not authorized." }, 401);
    }
    try {
      const body = parseBody(await req.json());
      const mode = typeof body.mode === "string" ? body.mode : "process";
      const admin = dependencies.createAdminClient();
      if (mode === "process") {
        return response(await processBatch(admin, body, dependencies));
      }
      if (mode === "scan") {
        const scanId = typeof body.scanId === "string"
          ? requiredUuid(body.scanId, "scan ID")
          : dependencies.randomUuid();
        const inventory = await collectBucketInventory(admin);
        const result = await rpc<Record<string, unknown>>(
          admin,
          "record_retired_community_orphan_scan",
          {
            target_scan_id: scanId,
            target_recorded_by: actor,
            target_inventory: inventory,
          },
        );
        return response(result);
      }
      if (mode === "health") {
        validateRuntimeConfiguration(dependencies);
        return response(await rpc(admin, "retired_community_deletion_health"));
      }
      if (mode === "maintenance") {
        const manifests = await rpc(
          admin,
          "purge_expired_retired_community_manifests",
        );
        const health = await rpc(admin, "retired_community_deletion_health");
        return response({ status: "complete", manifests, health });
      }
      if (mode === "verify-backup") {
        const result = await rpc(
          admin,
          "verify_retired_community_backup_after_30_days",
          {
            target_batch_id: requiredUuid(body.batchId, "batch ID"),
            target_bundle_sha256: body.bundleSha256,
            target_verification_reference_sha256:
              body.verificationReferenceSha256,
            target_verified_by: actor,
          },
        );
        return response(result);
      }
      if (mode === "dr-export") {
        return response({
          status: "exported",
          ledger: await exportDrLedger(admin, dependencies),
        });
      }
      if (mode === "dr-apply") {
        return response(await importDrLedger(admin, body, dependencies));
      }
      return response({ error: "Unsupported worker mode." }, 400);
    } catch (error) {
      dependencies.logger.error(JSON.stringify({
        event: "retention.worker.failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
      return response({ error: "Retired Community worker failed." }, 500);
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
