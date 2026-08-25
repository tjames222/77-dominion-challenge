import { assertEquals, responseJson } from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const crewId = "20000000-0000-4000-8000-000000000002";
const postId = "30000000-0000-4000-8000-000000000003";
const attachmentPath = `${crewId}/${userId}/authored.jpg`;

function environment(name: string) {
  return {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    PUBLIC_SITE_URL: "https://app.example.com",
  }[name];
}

function request(body?: string) {
  return new Request("https://functions.test/retired-community-export", {
    method: "POST",
    headers: {
      Authorization: "Bearer caller-jwt",
      Origin: "https://app.example.com",
    },
    body,
  });
}

function handler(options: {
  rpcData?: unknown;
  rpcError?: unknown;
  onSign?: (path: string, expires: number, options: unknown) => void;
}) {
  return createHandler({
    env: environment,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    requireUser: async () => ({ id: userId }) as any,
    createUserClient: () =>
      ({
        rpc: async (name: string) => {
          assertEquals(name, "export_own_retired_community_content");
          return { data: options.rpcData, error: options.rpcError || null };
        },
      }) as any,
    createAdminClient: () =>
      ({
        storage: {
          from: (bucket: string) => {
            assertEquals(bucket, "community-post-images");
            return {
              createSignedUrl: async (
                path: string,
                expires: number,
                signOptions: unknown,
              ) => {
                options.onSign?.(path, expires, signOptions);
                return {
                  data: {
                    signedUrl: `https://signed.example/${
                      encodeURIComponent(path)
                    }`,
                  },
                  error: null,
                };
              },
            };
          },
        },
      }) as any,
  } as any);
}

Deno.test("authored export keeps JSON intact and signs only its caller-owned path", async () => {
  const authored = {
    schemaVersion: 1,
    posts: [{ postId, body: "My body", attachmentPath }],
    comments: [{ commentId: postId, body: "My comment" }],
    likes: [],
  };
  let signed: unknown[] = [];
  const response = await handler({
    rpcData: authored,
    onSign: (...args) => signed = args,
  })(request());
  assertEquals(response.status, 200);
  const body = await responseJson(response);
  assertEquals(body.export, authored);
  assertEquals(signed, [attachmentPath, 300, { download: true }]);
  const downloads = body.attachmentDownloads as Array<{
    postId: string;
    expiresAt: string;
  }>;
  assertEquals(downloads[0].postId, postId);
  assertEquals(
    downloads[0].expiresAt,
    "2026-07-20T12:05:00.000Z",
  );
});

Deno.test("another member attachment path is denied and never signed", async () => {
  let signed = false;
  const response = await handler({
    rpcData: {
      posts: [{
        postId,
        attachmentPath:
          `${crewId}/90000000-0000-4000-8000-000000000009/not-mine.jpg`,
      }],
    },
    onSign: () => signed = true,
  })(request());
  assertEquals(response.status, 500);
  assertEquals(signed, false);
  assertEquals(
    (await responseJson(response)).error,
    "The authored Community export could not be created.",
  );
});

Deno.test("closed export window returns 410 without signing", async () => {
  const response = await handler({
    rpcError: { code: "55000", message: "internal window detail" },
  })(request());
  assertEquals(response.status, 410);
  assertEquals(
    (await responseJson(response)).error,
    "The authored export window has closed.",
  );
});

Deno.test("export boundary rejects arbitrary path or user parameters", async () => {
  let signed = false;
  const response = await handler({
    rpcData: { posts: [] },
    onSign: () => signed = true,
  })(request(JSON.stringify({ path: attachmentPath, userId })));
  assertEquals(response.status, 400);
  assertEquals(signed, false);
  assertEquals(
    (await responseJson(response)).error,
    "This export does not accept request parameters.",
  );
});
