import {
  createAdminClient,
  createUserClient,
  requireUser,
} from "../_shared/supabase.ts";
import {
  type EnvReader,
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
  readEnv,
} from "../_shared/http.ts";

type Dependencies = {
  createAdminClient: typeof createAdminClient;
  createUserClient: typeof createUserClient;
  requireUser: typeof requireUser;
  env: EnvReader;
  now: () => Date;
};

const defaultDependencies: Dependencies = {
  createAdminClient,
  createUserClient,
  requireUser,
  env: readEnv,
  now: () => new Date(),
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bucketId = "community-post-images";
const signedUrlLifetimeSeconds = 300;

function exportObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The authored export response is invalid.");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.posts)) {
    throw new Error("The authored export response is invalid.");
  }
  return result;
}

function safeAuthoredAttachmentPath(value: unknown, userId: string) {
  if (typeof value !== "string" || value.length > 1024) return null;
  const parts = value.split("/");
  if (
    parts.length < 3 || !uuidPattern.test(parts[0]) || parts[1] !== userId ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("The authored export returned an unsafe attachment path.");
  }
  return value;
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (req: Request) => {
    if (req.method === "OPTIONS") return optionsResponse(req, dependencies.env);
    if (req.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed." },
        405,
        req,
        dependencies.env,
      );
    }
    try {
      if ((await req.text()).trim()) {
        throw new HttpError(
          "This export does not accept request parameters.",
          400,
        );
      }
      const user = await dependencies.requireUser(req, {
        env: dependencies.env,
      });
      const userClient = dependencies.createUserClient(req, {
        env: dependencies.env,
      });
      const { data, error } = await userClient.rpc(
        "export_own_retired_community_content",
      );
      if (error) {
        if (error.code === "55000") {
          throw new HttpError("The authored export window has closed.", 410);
        }
        throw new Error("The authored export RPC failed.");
      }
      const authoredExport = exportObject(data);
      const admin = dependencies.createAdminClient({ env: dependencies.env });
      const attachmentDownloads: Array<{
        postId: string;
        signedUrl: string;
        expiresAt: string;
      }> = [];
      for (const postValue of authoredExport.posts as unknown[]) {
        if (
          !postValue || typeof postValue !== "object" ||
          Array.isArray(postValue)
        ) {
          throw new Error("The authored export response is invalid.");
        }
        const post = postValue as Record<string, unknown>;
        const path = safeAuthoredAttachmentPath(post.attachmentPath, user.id);
        if (!path) continue;
        if (typeof post.postId !== "string" || !uuidPattern.test(post.postId)) {
          throw new Error("The authored export response is invalid.");
        }
        const { data: signed, error: signingError } = await admin.storage
          .from(bucketId)
          .createSignedUrl(path, signedUrlLifetimeSeconds, { download: true });
        if (signingError || !signed?.signedUrl) {
          throw new Error("An authored attachment could not be signed.");
        }
        attachmentDownloads.push({
          postId: post.postId,
          signedUrl: signed.signedUrl,
          expiresAt: new Date(
            dependencies.now().getTime() + signedUrlLifetimeSeconds * 1000,
          ).toISOString(),
        });
      }
      return jsonResponse(
        { export: authoredExport, attachmentDownloads },
        200,
        req,
        dependencies.env,
      );
    } catch (error) {
      return errorResponse(
        error,
        "The authored Community export could not be created.",
        req,
        dependencies.env,
      );
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
