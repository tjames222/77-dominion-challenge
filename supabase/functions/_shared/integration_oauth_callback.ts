import { createAdminClient } from "./supabase.ts";
import { type EnvReader, readEnv } from "./http.ts";
import {
  base64ToPostgresBytea,
  createOpaqueToken,
  currentCredentialKeyVersion,
  integrationStateSecret,
  publicSiteUrl,
  sha256Hex,
  verifyIntegrationOAuthState,
} from "./integration_oauth.ts";
import {
  encryptProviderCredential,
  parseCredentialKeys,
} from "./integration_delivery.ts";
import {
  exchangeProviderCode,
  type ProviderAuthorization,
} from "./integration_providers.ts";

type IntegrationProvider = "slack" | "discord";
type AdminClient = ReturnType<typeof createAdminClient>;

type Dependencies = {
  createAdminClient: typeof createAdminClient;
  env: EnvReader;
  verifyIntegrationOAuthState: typeof verifyIntegrationOAuthState;
  exchangeProviderCode: typeof exchangeProviderCode;
  encryptProviderCredential: typeof encryptProviderCredential;
  createOpaqueToken: typeof createOpaqueToken;
  randomUuid: () => string;
  now: () => Date;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  createAdminClient,
  env: readEnv,
  verifyIntegrationOAuthState,
  exchangeProviderCode,
  encryptProviderCredential,
  createOpaqueToken,
  randomUuid: () => crypto.randomUUID(),
  now: () => new Date(),
  logger: console,
};

async function rpc<T>(
  admin: AdminClient,
  name: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`Integration callback RPC failed: ${name}.`);
  return data as T;
}

function one<T>(value: T | T[] | null): T {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error("Expected one authorization state.");
    }
    return value[0];
  }
  if (!value) throw new Error("Authorization state is unavailable.");
  return value;
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function callbackLocation(
  env: EnvReader,
  returnPath: string,
  values: Record<string, string>,
) {
  const location = new URL(returnPath, publicSiteUrl(env));
  location.hash = new URLSearchParams(values).toString();
  return location.toString();
}

type ConsumedState = {
  user_id: string;
  crew_id: string;
  return_path: string;
};

async function createPendingConnection(
  provider: IntegrationProvider,
  authorization: ProviderAuthorization,
  state: ConsumedState,
  admin: AdminClient,
  dependencies: Dependencies,
) {
  const keySource = dependencies.env("INTEGRATION_CREDENTIAL_KEYS");
  if (!keySource) {
    throw new Error("Integration credential keys are unavailable.");
  }
  const keys = parseCredentialKeys(keySource);
  const keyVersion = currentCredentialKeyVersion(keys);
  const pendingId = dependencies.randomUuid();
  const setupToken = dependencies.createOpaqueToken();
  const encrypted = await dependencies.encryptProviderCredential(
    { accessToken: authorization.accessToken },
    pendingId,
    provider,
    keyVersion,
    keys,
  );
  await rpc(admin, "create_pending_integration_connection", {
    target_pending_id: pendingId,
    target_setup_token_hash: await sha256Hex(setupToken),
    target_provider: provider,
    target_crew_id: state.crew_id,
    target_user_id: state.user_id,
    target_workspace_id: authorization.workspaceId,
    target_workspace_name: authorization.workspaceName,
    target_credential_ciphertext: base64ToPostgresBytea(encrypted.ciphertext),
    target_credential_nonce: base64ToPostgresBytea(encrypted.nonce),
    target_credential_key_version: encrypted.keyVersion,
    target_credential_fingerprint: await sha256Hex(authorization.accessToken),
    target_scopes: authorization.scopes,
    target_expires_at: new Date(dependencies.now().getTime() + 15 * 60_000)
      .toISOString(),
  });
  return setupToken;
}

export function createOAuthCallbackHandler(
  provider: IntegrationProvider,
  overrides: Partial<Dependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async (req: Request) => {
    if (req.method !== "GET") {
      return new Response("Method not allowed.", {
        status: 405,
        headers: { "Cache-Control": "no-store" },
      });
    }

    let returnPath = "/community.html";
    try {
      const url = new URL(req.url);
      const serializedState = url.searchParams.get("state") || "";
      const verified = await dependencies.verifyIntegrationOAuthState(
        serializedState,
        provider,
        integrationStateSecret(dependencies.env),
        dependencies.now(),
      );
      const admin = dependencies.createAdminClient();
      const consumed = one(
        await rpc<ConsumedState | ConsumedState[]>(
          admin,
          "consume_integration_oauth_state",
          { target_provider: provider, target_nonce_hash: verified.nonceHash },
        ),
      );
      returnPath = consumed.return_path;

      if (url.searchParams.has("error") || !url.searchParams.get("code")) {
        return redirect(callbackLocation(dependencies.env, returnPath, {
          "integration-error": "authorization_denied",
          provider,
        }));
      }

      const authorization = await dependencies.exchangeProviderCode(
        provider,
        url.searchParams.get("code") || "",
        {
          guildId: url.searchParams.get("guild_id") || undefined,
          env: dependencies.env,
        },
      );
      const setupToken = await createPendingConnection(
        provider,
        authorization,
        consumed,
        admin,
        dependencies,
      );
      return redirect(callbackLocation(dependencies.env, returnPath, {
        "integration-setup": setupToken,
        provider,
      }));
    } catch (error) {
      dependencies.logger.error(JSON.stringify({
        event: "integration.oauth_callback.failed",
        provider,
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
      try {
        return redirect(callbackLocation(dependencies.env, returnPath, {
          "integration-error": "authorization_failed",
          provider,
        }));
      } catch {
        return new Response("Integration authorization failed.", {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
  };
}
