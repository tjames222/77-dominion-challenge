import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import {
  type EnvReader,
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
  readEnv,
  resolveSiteOrigin,
} from "../_shared/http.ts";
import {
  type EncodedProfileImage,
  inspectProfileImage,
  PROFILE_IMAGE_MAX_BYTES,
  ProfileImageValidationError,
  reencodeProfileThumbnail,
  sha256Hex,
} from "../_shared/profile_image.ts";

type RpcError = { code?: string; message?: string };
type RpcResult = { data: any; error: RpcError | null };
type StoredObject = {
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};
type AdminClient = {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<RpcResult>;
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        bytes: Uint8Array,
        options: Record<string, unknown>,
      ) => Promise<{ data: { path?: string } | null; error: RpcError | null }>;
      download: (
        path: string,
      ) => Promise<{ data: StoredObject | null; error: RpcError | null }>;
    };
  };
};

type Dependencies = {
  requireUser: typeof requireUser;
  createAdminClient: () => AdminClient;
  transform: (
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<EncodedProfileImage>;
  env: EnvReader;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  requireUser,
  createAdminClient,
  transform: reencodeProfileThumbnail,
  env: readEnv,
  logger: console,
};

const bucket = "profile-photos";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storagePathPattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/avatar-[0-9]{13}-[a-f0-9]{32}\.webp$/i;

function noStoreJson(
  body: unknown,
  status: number,
  req: Request,
  env: EnvReader,
) {
  const response = jsonResponse(body, status, req, env);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

async function readBoundedBody(req: Request) {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HttpError("The upload size is invalid.", 400);
    }
    if (Number(declaredLength) > PROFILE_IMAGE_MAX_BYTES) {
      throw new HttpError("Profile pictures must be 150 KB or smaller.", 413);
    }
  }
  if (!req.body) throw new HttpError("Choose a profile picture first.", 400);

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = req.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > PROFILE_IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new HttpError("Profile pictures must be 150 KB or smaller.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength < 1) {
    throw new HttpError("Choose a profile picture first.", 400);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function trustedReservation(value: unknown, userId: string) {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const registrationId = String(
    row.registrationId ?? row.registration_id ?? "",
  );
  const storagePath = String(row.storagePath ?? row.storage_path ?? "");
  const expiresAt = String(row.expiresAt ?? row.expires_at ?? "");
  const pathMatch = storagePath.match(storagePathPattern);
  if (
    !uuidPattern.test(registrationId) ||
    !pathMatch ||
    pathMatch[1].toLowerCase() !== userId.toLowerCase() ||
    !Number.isFinite(Date.parse(expiresAt))
  ) return null;
  return { registrationId, storagePath, expiresAt };
}

function databaseError(error: RpcError | null): Error {
  const code = String(error?.code || "");
  if (code === "P8003" || code === "P8004") {
    return new HttpError(
      code === "P8003"
        ? "You have reached the hourly profile-picture upload limit. Try again later."
        : "You have reached the daily profile-picture upload limit. Try again tomorrow.",
      429,
    );
  }
  if (code === "P8001" || code === "P8002") {
    return new HttpError(
      "Profile-picture cleanup is still catching up. Wait a few minutes, then try again.",
      409,
    );
  }
  if (/erasure|frozen/i.test(error?.message || "")) {
    return new HttpError(
      "Profile pictures cannot change while account deletion is pending.",
      409,
    );
  }
  return new Error("Profile-picture database authorization failed.");
}

async function existingObjectMatches(
  admin: AdminClient,
  storagePath: string,
  expected: EncodedProfileImage,
) {
  const result = await admin.storage.from(bucket).download(storagePath);
  if (result.error || !result.data) return false;
  if (
    result.data.size !== expected.bytes.byteLength ||
    result.data.type.toLowerCase().trim() !== "image/webp"
  ) return false;

  try {
    const bytes = new Uint8Array(await result.data.arrayBuffer());
    if (bytes.byteLength !== expected.bytes.byteLength) return false;
    const inspected = inspectProfileImage(bytes, "image/webp");
    return inspected.width === expected.width &&
      inspected.height === expected.height &&
      await sha256Hex(bytes) === expected.sha256;
  } catch {
    return false;
  }
}

async function abandonReservation(
  admin: AdminClient,
  userId: string,
  registrationId: string,
) {
  try {
    await admin.rpc("abandon_profile_photo_upload_service", {
      target_user_id: userId,
      target_registration_id: registrationId,
    });
  } catch {
    // Expiration and the service cleanup sweep remain the durable fallback.
  }
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

    let admin: AdminClient | null = null;
    let userId = "";
    let registrationId = "";
    let finalized = false;
    try {
      resolveSiteOrigin(req, dependencies.env);
      const user = await dependencies.requireUser(req);
      userId = String(user.id || "");
      const expectedUserId = String(
        req.headers.get("x-profile-user-id") || "",
      );
      const requestId = String(
        req.headers.get("x-profile-upload-request-id") || "",
      );
      if (!uuidPattern.test(userId) || expectedUserId !== userId) {
        throw new HttpError("The signed-in account changed. Try again.", 409);
      }
      if (!uuidPattern.test(requestId)) {
        throw new HttpError("The upload request is invalid. Try again.", 400);
      }

      const contentType = String(req.headers.get("content-type") || "")
        .toLowerCase()
        .split(";", 1)[0]
        .trim();
      if (contentType !== "image/jpeg" && contentType !== "image/webp") {
        throw new HttpError("Choose a JPEG or WebP profile picture.", 415);
      }

      const input = await readBoundedBody(req);
      inspectProfileImage(input, contentType);
      const sourceSha256 = await sha256Hex(input);
      admin = dependencies.createAdminClient();
      const reserved = await admin.rpc("reserve_profile_photo_upload_service", {
        target_user_id: userId,
        target_request_id: requestId,
        target_source_sha256: sourceSha256,
      });
      if (reserved.error) throw databaseError(reserved.error);
      const reservation = trustedReservation(reserved.data, userId);
      if (!reservation) throw new Error("The upload reservation was invalid.");
      registrationId = reservation.registrationId;

      const encoded = await dependencies.transform(input, contentType);
      if (
        encoded.contentType !== "image/webp" ||
        encoded.bytes.byteLength < 1 ||
        encoded.bytes.byteLength > PROFILE_IMAGE_MAX_BYTES ||
        encoded.width !== encoded.height ||
        encoded.sha256 !== await sha256Hex(encoded.bytes)
      ) {
        throw new Error("The profile-picture transformer contract failed.");
      }
      const verifiedOutput = inspectProfileImage(encoded.bytes, "image/webp");
      if (
        verifiedOutput.width !== encoded.width ||
        verifiedOutput.height !== encoded.height
      ) throw new Error("The profile-picture transformer dimensions failed.");

      const storage = admin.storage.from(bucket);
      const uploaded = await storage.upload(
        reservation.storagePath,
        encoded.bytes,
        {
          cacheControl: "31536000",
          contentType: "image/webp",
          upsert: false,
        },
      );
      if (
        uploaded.error &&
        !await existingObjectMatches(admin, reservation.storagePath, encoded)
      ) {
        throw new Error("The trusted Storage upload failed.");
      }
      if (
        uploaded.data?.path && uploaded.data.path !== reservation.storagePath
      ) {
        throw new Error("Storage returned an unexpected object path.");
      }

      const completed = await admin.rpc(
        "finalize_profile_photo_upload_service",
        {
          target_user_id: userId,
          target_registration_id: registrationId,
          target_storage_path: reservation.storagePath,
          target_output_sha256: encoded.sha256,
          target_size_bytes: encoded.bytes.byteLength,
          target_width: encoded.width,
          target_height: encoded.height,
        },
      );
      if (completed.error) throw databaseError(completed.error);
      if (
        completed.data?.finalized !== true ||
        completed.data?.storagePath !== reservation.storagePath ||
        completed.data?.registrationId !== registrationId
      ) throw new Error("The trusted upload could not be finalized.");
      finalized = true;

      return noStoreJson(
        {
          avatarUrl: reservation.storagePath,
          storagePath: reservation.storagePath,
          registrationId,
          contentType: "image/webp",
          sizeBytes: encoded.bytes.byteLength,
          width: encoded.width,
          height: encoded.height,
        },
        200,
        req,
        dependencies.env,
      );
    } catch (error) {
      if (admin && userId && registrationId && !finalized) {
        await abandonReservation(admin, userId, registrationId);
      }
      dependencies.logger.error(
        "Profile-picture upload failed",
        error instanceof HttpError ||
          error instanceof ProfileImageValidationError
          ? error.message
          : "internal",
      );
      const safeError = error instanceof ProfileImageValidationError
        ? new HttpError(error.message, 400)
        : error;
      const response = errorResponse(
        safeError,
        "Profile pictures are temporarily unavailable. Try again later.",
        req,
        dependencies.env,
      );
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
