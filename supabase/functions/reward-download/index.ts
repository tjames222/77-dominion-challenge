import {
  createAdminClient,
  createUserClient,
  requireUser,
} from "../_shared/supabase.ts";
import {
  corsHeaders,
  type EnvReader,
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
  readEnv,
} from "../_shared/http.ts";

type RpcResult = { data: any; error: { message?: string } | null };
type UserClient = {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<RpcResult>;
};
type StorageObject = {
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};
type AdminClient = UserClient & {
  storage: {
    from: (bucket: string) => {
      download: (
        path: string,
      ) => Promise<
        { data: StorageObject | null; error: { message?: string } | null }
      >;
    };
  };
};

type Dependencies = {
  requireUser: typeof requireUser;
  createUserClient: (req: Request) => UserClient;
  createAdminClient: () => AdminClient;
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

const rewardKey = "nehemiah_leadership_handbook";
const rewardBucket = "reward-downloads";
const maximumRewardBytes = 52_428_800;

function safeDelivery(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const delivery = value as Record<string, unknown>;
  const bucket = typeof delivery.bucket_name === "string"
    ? delivery.bucket_name
    : "";
  const path = typeof delivery.object_path === "string"
    ? delivery.object_path
    : "";
  const filename = typeof delivery.download_filename === "string"
    ? delivery.download_filename
    : "";
  const contentType = typeof delivery.content_type === "string"
    ? delivery.content_type
    : "";
  const sha256Hex = typeof delivery.sha256_hex === "string"
    ? delivery.sha256_hex
    : "";
  const sizeBytes = typeof delivery.size_bytes === "number"
    ? delivery.size_bytes
    : Number.NaN;
  if (
    bucket !== rewardBucket ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.pdf$/.test(path) ||
    /(^\/|\.\.|\/\/)/.test(path) ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$/.test(filename) ||
    contentType !== "application/pdf" ||
    !/^[0-9a-f]{64}$/.test(sha256Hex) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > maximumRewardBytes
  ) return null;
  return { bucket, path, filename, sha256Hex, sizeBytes };
}

async function verifiedApprovedAsset(
  object: StorageObject | null,
  delivery: NonNullable<ReturnType<typeof safeDelivery>>,
) {
  if (
    !object ||
    !Number.isSafeInteger(object.size) ||
    object.size <= 0 ||
    object.size > maximumRewardBytes ||
    object.size !== delivery.sizeBytes ||
    object.type.toLowerCase().trim() !== "application/pdf"
  ) return null;

  try {
    const buffer = await object.arrayBuffer();
    if (buffer.byteLength !== object.size) return null;
    const bytes = new Uint8Array(buffer);
    if (
      bytes.length < 5 ||
      bytes[0] !== 0x25 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x44 ||
      bytes[3] !== 0x46 ||
      bytes[4] !== 0x2d
    ) return null;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const checksum = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return checksum === delivery.sha256Hex ? bytes : null;
  } catch {
    return null;
  }
}

async function safeBody(req: Request) {
  try {
    const body = await req.json();
    return body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
  } catch {
    throw new HttpError("A valid JSON request is required.", 400);
  }
}

function noStoreJson(
  body: unknown,
  status: number,
  req: Request,
  env: EnvReader,
) {
  const response = jsonResponse(body, status, req, env);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async (req: Request) => {
    if (req.method === "OPTIONS") return optionsResponse(req, dependencies.env);
    if (req.method !== "POST") {
      return noStoreJson(
        { error: "Method not allowed." },
        405,
        req,
        dependencies.env,
      );
    }

    let userId = "";
    let ticket = "";
    try {
      const user = await dependencies.requireUser(req);
      userId = user.id;
      const body = await safeBody(req);
      if (body.rewardKey !== rewardKey) {
        throw new HttpError("The requested download is unavailable.", 400);
      }
      if (body.expectedUserId !== userId) {
        throw new HttpError("The signed-in account changed. Try again.", 409);
      }

      const userClient = dependencies.createUserClient(req);
      const requested = await userClient.rpc("request_reward_download", {
        target_reward_key: rewardKey,
        target_expected_actor_id: userId,
      });
      if (requested.error) {
        if (requested.error.message?.includes("Too many download requests")) {
          throw new HttpError(
            "Too many download requests. Try again shortly.",
            429,
          );
        }
        if (requested.error.message?.includes("not been unlocked")) {
          throw new HttpError("This reward has not been unlocked.", 403);
        }
        throw new Error("Download authorization failed.");
      }
      if (
        requested.data?.availability !== "available" || !requested.data?.ticket
      ) {
        return noStoreJson(
          {
            status: "unavailable",
            availability: "unavailable",
            message:
              "You permanently own this reward. The approved handbook edition is being finalized.",
          },
          409,
          req,
          dependencies.env,
        );
      }
      ticket = String(requested.data.ticket);

      const admin = dependencies.createAdminClient();
      const redeemed = await admin.rpc("redeem_reward_download_ticket", {
        target_token: ticket,
        target_user_id: userId,
      });
      const delivery = safeDelivery(
        Array.isArray(redeemed.data) ? redeemed.data[0] : null,
      );
      if (redeemed.error || !delivery) {
        throw new HttpError("The download request expired. Try again.", 410);
      }

      const storage = admin.storage.from(delivery.bucket);
      const downloaded = await storage.download(delivery.path);
      const bytes = downloaded.error
        ? null
        : await verifiedApprovedAsset(downloaded.data, delivery);
      if (!bytes) {
        throw new HttpError(
          "The approved download failed its integrity check.",
          410,
        );
      }

      await admin.rpc("record_reward_download_result", {
        target_token: ticket,
        target_user_id: userId,
        target_success: true,
        target_outcome: "verified_bytes_streamed",
      });

      return new Response(bytes, {
        status: 200,
        headers: {
          ...corsHeaders(req, dependencies.env),
          "Access-Control-Expose-Headers":
            "Content-Disposition, X-Reward-Filename",
          "Cache-Control": "private, no-store, max-age=0",
          "Content-Disposition": `attachment; filename="${delivery.filename}"`,
          "Content-Length": String(bytes.byteLength),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type": "application/pdf",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Reward-Filename": delivery.filename,
        },
      });
    } catch (error) {
      if (ticket && userId) {
        try {
          await dependencies.createAdminClient().rpc(
            "record_reward_download_result",
            {
              target_token: ticket,
              target_user_id: userId,
              target_success: false,
              target_outcome: "verified_stream_failed",
            },
          );
        } catch {
          // The client receives the same generic safe failure either way.
        }
      }
      dependencies.logger.error(
        "Reward download failed",
        error instanceof HttpError ? error.message : "internal",
      );
      const response = errorResponse(
        error,
        "The handbook download is temporarily unavailable.",
        req,
        dependencies.env,
      );
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
