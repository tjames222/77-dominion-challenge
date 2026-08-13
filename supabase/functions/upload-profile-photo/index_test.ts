import {
  assert,
  assertEquals,
  quietLogger,
  responseJson,
} from "../_shared/test_helpers.ts";
import {
  PROFILE_IMAGE_MAX_BYTES,
  sha256Hex,
} from "../_shared/profile_image.ts";
import { createHandler } from "./index.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "20000000-0000-4000-8000-000000000002";
const requestId = "30000000-0000-4000-8000-000000000003";
const registrationId = "40000000-0000-4000-8000-000000000004";
const storagePath =
  `${userId}/avatar-1786500000000-0123456789abcdef0123456789abcdef.webp`;
const env = (name: string) => ({
  PUBLIC_SITE_URL: "https://dominion.example",
}[name]);

function webp(width = 32, height = 32) {
  const payload = new Uint8Array([
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >>> 8) & 0x3f,
    height & 0xff,
    (height >>> 8) & 0x3f,
  ]);
  const bytes = new Uint8Array(12 + 8 + payload.length);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8 "), 12);
  new DataView(bytes.buffer).setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

function request(
  body: BodyInit = webp(),
  headers: Record<string, string> = {},
) {
  return new Request("https://functions.example/upload-profile-photo", {
    method: "POST",
    headers: {
      Authorization: "Bearer trusted-test-token",
      Origin: "https://dominion.example",
      "Content-Type": "image/webp",
      "x-profile-user-id": userId,
      "x-profile-upload-request-id": requestId,
      ...headers,
    },
    body,
  });
}

type FixtureOptions = {
  reserveError?: { code?: string; message?: string };
  uploadError?: boolean;
  existingMatches?: boolean;
  finalizeError?: boolean;
};

async function fixture(options: FixtureOptions = {}) {
  const calls: Array<[string, unknown]> = [];
  const output = webp(32, 32);
  const sha256 = await sha256Hex(output);
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([`rpc:${name}`, args]);
      if (name === "reserve_profile_photo_upload_service") {
        return options.reserveError
          ? { data: null, error: options.reserveError }
          : {
            data: {
              registrationId,
              storagePath,
              expiresAt: "2026-08-13T20:00:00.000Z",
            },
            error: null,
          };
      }
      if (name === "finalize_profile_photo_upload_service") {
        return options.finalizeError
          ? { data: null, error: { message: "finalize failed" } }
          : {
            data: { finalized: true, registrationId, storagePath },
            error: null,
          };
      }
      return { data: true, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array, config: unknown) => {
          calls.push(["storage:upload", { bucket, path, bytes, config }]);
          return options.uploadError
            ? { data: null, error: { message: "already exists" } }
            : { data: { path }, error: null };
        },
        download: async (path: string) => {
          calls.push(["storage:download", { bucket, path }]);
          return options.existingMatches
            ? { data: new Blob([output], { type: "image/webp" }), error: null }
            : { data: null, error: { message: "not found" } };
        },
      }),
    },
  };
  const handle = createHandler({
    requireUser: async () => ({ id: userId }),
    createAdminClient: () => admin,
    transform: async () => {
      calls.push(["transform", null]);
      return {
        bytes: output,
        contentType: "image/webp",
        width: 32,
        height: 32,
        sha256,
      };
    },
    env,
    logger: quietLogger,
  } as any);
  return { admin, calls, handle, output, sha256 };
}

Deno.test("trusted profile upload binds the authenticated actor and returns only a finalized path", async () => {
  const test = await fixture();
  const response = await test.handle(request());
  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    avatarUrl: storagePath,
    storagePath,
    registrationId,
    contentType: "image/webp",
    sizeBytes: test.output.byteLength,
    width: 32,
    height: 32,
  });
  assertEquals(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");

  const reserve = test.calls.find(([name]) =>
    name === "rpc:reserve_profile_photo_upload_service"
  );
  assertEquals((reserve?.[1] as any).target_user_id, userId);
  assertEquals((reserve?.[1] as any).target_request_id, requestId);
  assertEquals(test.calls[0][0], "rpc:reserve_profile_photo_upload_service");
  assertEquals(test.calls[1][0], "transform");
  const upload = test.calls.find(([name]) => name === "storage:upload");
  assertEquals((upload?.[1] as any).bucket, "profile-photos");
  assertEquals((upload?.[1] as any).path, storagePath);
  assertEquals((upload?.[1] as any).config, {
    cacheControl: "31536000",
    contentType: "image/webp",
    upsert: false,
  });
  assert(
    test.calls.some(([name]) =>
      name === "rpc:finalize_profile_photo_upload_service"
    ),
  );
  assertEquals(
    test.calls.some(([name]) =>
      name === "rpc:abandon_profile_photo_upload_service"
    ),
    false,
  );
});

Deno.test("trusted profile upload rejects a stale actor before image or service work", async () => {
  const test = await fixture();
  const response = await test.handle(request(webp(), {
    "x-profile-user-id": otherUserId,
  }));
  assertEquals(response.status, 409);
  assertEquals(test.calls.length, 0);
});

Deno.test("trusted profile upload rejects unsupported MIME and bounded-stream overflow", async () => {
  const unsupported = await fixture();
  assertEquals(
    (await unsupported.handle(request(webp(), { "Content-Type": "image/png" })))
      .status,
    415,
  );
  assertEquals(unsupported.calls.length, 0);

  const oversized = await fixture();
  assertEquals(
    (await oversized.handle(
      request(new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1)),
    )).status,
    413,
  );
  assertEquals(oversized.calls.length, 0);
});

Deno.test("trusted profile upload maps admission limits without exposing database details", async () => {
  const test = await fixture({
    reserveError: { code: "P8003", message: "internal" },
  });
  const response = await test.handle(request());
  assertEquals(response.status, 429);
  assertEquals(await responseJson(response), {
    error:
      "You have reached the hourly profile-picture upload limit. Try again later.",
  });
  assertEquals(test.calls.some(([name]) => name === "transform"), false);
});

Deno.test("trusted profile upload recovers an exact idempotent object after a lost response", async () => {
  const test = await fixture({ uploadError: true, existingMatches: true });
  assertEquals((await test.handle(request())).status, 200);
  assert(test.calls.some(([name]) => name === "storage:download"));
  assert(
    test.calls.some(([name]) =>
      name === "rpc:finalize_profile_photo_upload_service"
    ),
  );
});

Deno.test("trusted profile upload abandons a reservation after Storage or finalization failure", async () => {
  for (
    const options of [
      { uploadError: true },
      { finalizeError: true },
    ]
  ) {
    const test = await fixture(options);
    const response = await test.handle(request());
    assertEquals(response.status, 500);
    assert(
      test.calls.some(([name]) =>
        name === "rpc:abandon_profile_photo_upload_service"
      ),
    );
    assertEquals(await responseJson(response), {
      error: "Profile pictures are temporarily unavailable. Try again later.",
    });
  }
});
