import { createAdminClient } from "../_shared/supabase.ts";
import { type EnvReader, readEnv } from "../_shared/http.ts";
import {
  type ClaimedDelivery,
  decryptProviderCredential,
  type DeliveryResult,
  parseCredentialKeys,
  safeDeliveryLog,
  sendProviderMessage,
} from "../_shared/integration_delivery.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

type WorkerLogger = Pick<Console, "info" | "error">;

type Dependencies = {
  createAdminClient: typeof createAdminClient;
  env: EnvReader;
  decryptProviderCredential: typeof decryptProviderCredential;
  sendProviderMessage: typeof sendProviderMessage;
  randomUuid: () => string;
  now: () => Date;
  logger: WorkerLogger;
};

const defaultDependencies: Dependencies = {
  createAdminClient,
  env: readEnv,
  decryptProviderCredential,
  sendProviderMessage,
  randomUuid: () => crypto.randomUUID(),
  now: () => new Date(),
  logger: console,
};

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

async function validWorkerSecret(req: Request, env: EnvReader) {
  const expected = env("INTEGRATION_WORKER_SECRET") || "";
  const provided = req.headers.get("x-dominion-worker-key") || "";
  if (expected.length < 32 || !provided) return false;
  const [left, right] = await Promise.all([digest(expected), digest(provided)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function rpc<T>(
  admin: AdminClient,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`Integration runtime RPC failed: ${name}.`);
  return data as T;
}

function settleArgs(
  delivery: ClaimedDelivery,
  workerToken: string,
  startedAt: Date,
  result: DeliveryResult,
) {
  return {
    target_delivery_id: delivery.delivery_id,
    worker_token: workerToken,
    target_outcome: result.outcome,
    target_started_at: startedAt.toISOString(),
    target_http_status: result.httpStatus ?? null,
    target_provider_request_id: result.providerRequestId ?? null,
    target_retry_after_seconds: result.retryAfterSeconds ?? null,
    target_error_code: result.errorCode ?? null,
    target_error_summary: result.errorSummary ?? null,
    target_response_metadata: result.responseMetadata,
  };
}

async function processBatch(
  admin: AdminClient,
  dependencies: Dependencies,
  batchSize: number,
) {
  const keySource = dependencies.env("INTEGRATION_CREDENTIAL_KEYS");
  if (!keySource) {
    throw new Error("Integration credential keys are unavailable.");
  }
  const keys = parseCredentialKeys(keySource);
  const workerToken = dependencies.randomUuid();

  const deliveries = await rpc<ClaimedDelivery[]>(
    admin,
    "claim_outbound_deliveries",
    { worker_token: workerToken, batch_size: batchSize },
  ) || [];

  const counts = {
    claimed: deliveries.length,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
  };
  for (const delivery of deliveries) {
    const startedAt = dependencies.now();
    let result: DeliveryResult;
    const destinationActive = await rpc<boolean>(
      admin,
      "validate_claimed_outbound_delivery",
      {
        target_delivery_id: delivery.delivery_id,
        worker_token: workerToken,
      },
    );
    if (!destinationActive) {
      result = {
        outcome: "dead_letter",
        errorCode: "destination_disconnected",
        errorSummary: "The provider destination is no longer active.",
        responseMetadata: { provider: delivery.provider },
      };
    } else {
      try {
        const credential = await dependencies.decryptProviderCredential(
          delivery,
          keys,
        );
        result = await dependencies.sendProviderMessage(delivery, credential);
      } catch {
        result = {
          outcome: "dead_letter",
          errorCode: "credential_decryption_failed",
          errorSummary: "The provider credential could not be decrypted.",
          responseMetadata: { provider: delivery.provider },
        };
      }
    }

    const finalOutcome = await rpc<string>(
      admin,
      "settle_outbound_delivery",
      settleArgs(delivery, workerToken, startedAt, result),
    );
    const settledResult = {
      ...result,
      outcome: finalOutcome,
    } as DeliveryResult;
    if (finalOutcome === "delivered") counts.delivered += 1;
    else if (finalOutcome === "retry") counts.retried += 1;
    else counts.deadLettered += 1;
    dependencies.logger.info(
      JSON.stringify(
        safeDeliveryLog(
          "integration.delivery.settled",
          delivery,
          settledResult,
        ),
      ),
    );
  }
  return counts;
}

function parseBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function batchSize(value: unknown) {
  const parsed = Number(value ?? 20);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Invalid integration worker batch size.");
  }
  return parsed;
}

function requiredUuid(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

async function enqueueSynthetic(
  admin: AdminClient,
  body: Record<string, unknown>,
  randomUuid: () => string,
) {
  const crewId = requiredUuid(body.crewId, "crew ID");
  const destinationId = requiredUuid(body.destinationId, "destination ID");
  if (
    typeof body.text !== "string" || !body.text.trim() ||
    body.text.length > 2000
  ) {
    throw new Error("Invalid synthetic message text.");
  }
  const idempotencyKey = typeof body.idempotencyKey === "string"
    ? body.idempotencyKey
    : `synthetic:${randomUuid()}`;
  if (idempotencyKey.length < 8 || idempotencyKey.length > 240) {
    throw new Error("Invalid synthetic idempotency key.");
  }

  return await rpc<string>(admin, "enqueue_outbound_delivery", {
    target_crew_id: crewId,
    target_destination_id: destinationId,
    target_event_type: "synthetic.delivery",
    target_idempotency_key: idempotencyKey,
    target_payload: { text: body.text },
    target_max_attempts: 3,
  });
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
      let body: Record<string, unknown> = {};
      try {
        body = parseBody(await req.json());
      } catch {
        throw new Error("Request body must be valid JSON.");
      }
      const mode = typeof body.mode === "string" ? body.mode : "process";
      if (!["process", "health", "maintenance", "synthetic"].includes(mode)) {
        return response({ error: "Unsupported worker mode." }, 400);
      }

      const admin = dependencies.createAdminClient();
      if (mode === "health") {
        const health = await rpc<Record<string, unknown>>(
          admin,
          "integration_delivery_health",
        );
        return response({ health });
      }

      const releasedStale = await rpc<number>(
        admin,
        "release_stale_outbound_deliveries",
        {},
      );

      if (mode === "maintenance") {
        const retention = await rpc<Record<string, number>>(
          admin,
          "purge_integration_delivery_history",
        );
        const connectionSetup = await rpc<Record<string, number>>(
          admin,
          "purge_integration_connection_setup",
        );
        const health = await rpc<Record<string, unknown>>(
          admin,
          "integration_delivery_health",
        );
        return response({ releasedStale, retention, connectionSetup, health });
      }

      const syntheticDeliveryId = mode === "synthetic"
        ? await enqueueSynthetic(admin, body, dependencies.randomUuid)
        : undefined;
      const counts = await processBatch(
        admin,
        dependencies,
        batchSize(body.batchSize),
      );
      const health = await rpc<Record<string, unknown>>(
        admin,
        "integration_delivery_health",
      );
      return response({
        releasedStale,
        syntheticDeliveryId,
        ...counts,
        health,
      });
    } catch (error) {
      dependencies.logger.error(JSON.stringify({
        event: "integration.worker.failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
      return response({ error: "Integration delivery worker failed." }, 500);
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
