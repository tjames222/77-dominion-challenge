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
import {
  type ClaimedDelivery,
  decryptProviderCredential,
  encryptProviderCredential,
  parseCredentialKeys,
  sendProviderMessage,
} from "../_shared/integration_delivery.ts";
import {
  base64ToPostgresBytea,
  createIntegrationOAuthState,
  currentCredentialKeyVersion,
  integrationStateSecret,
  sha256Hex,
} from "../_shared/integration_oauth.ts";
import {
  listProviderChannels,
  providerAuthorizationUrl,
  ProviderConnectionError,
  requireProviderChannel,
  revokeProviderCredential,
} from "../_shared/integration_providers.ts";

type IntegrationProvider = "slack" | "discord";
type AdminClient = ReturnType<typeof createAdminClient>;

type Dependencies = {
  requireUser: typeof requireUser;
  createAdminClient: typeof createAdminClient;
  createUserClient: typeof createUserClient;
  env: EnvReader;
  createIntegrationOAuthState: typeof createIntegrationOAuthState;
  providerAuthorizationUrl: typeof providerAuthorizationUrl;
  listProviderChannels: typeof listProviderChannels;
  requireProviderChannel: typeof requireProviderChannel;
  revokeProviderCredential: typeof revokeProviderCredential;
  encryptProviderCredential: typeof encryptProviderCredential;
  decryptProviderCredential: typeof decryptProviderCredential;
  sendProviderMessage: typeof sendProviderMessage;
  now: () => Date;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  requireUser,
  createAdminClient,
  createUserClient,
  env: readEnv,
  createIntegrationOAuthState,
  providerAuthorizationUrl,
  listProviderChannels,
  requireProviderChannel,
  revokeProviderCredential,
  encryptProviderCredential,
  decryptProviderCredential,
  sendProviderMessage,
  now: () => new Date(),
  logger: console,
};

async function rpc<T>(
  client: any,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`Integration connection RPC failed: ${name}.`);
  return data as T;
}

function one<T>(value: T | T[] | null | undefined): T {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error("Expected one integration record.");
    return value[0];
  }
  if (!value) throw new Error("Integration record is unavailable.");
  return value;
}

function bodyObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("Request body must be an object.", 400);
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) throw new HttpError(`Invalid ${label}.`, 400);
  return value;
}

function provider(value: unknown): IntegrationProvider {
  if (value !== "slack" && value !== "discord") {
    throw new HttpError("Unsupported integration provider.", 400);
  }
  return value;
}

function token(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 24 || value.length > 256) {
    throw new HttpError(`Invalid ${label}.`, 400);
  }
  return value;
}

function channel(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 200) {
    throw new HttpError("Select an available provider channel.", 400);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new HttpError(`${label} must be enabled or disabled.`, 400);
  }
  return value;
}

function recapCadence(value: unknown) {
  if (value !== "off" && value !== "weekly") {
    throw new HttpError("Unsupported leaderboard recap cadence.", 400);
  }
  return value;
}

function credentialKeys(env: EnvReader) {
  const serialized = env("INTEGRATION_CREDENTIAL_KEYS");
  if (!serialized) {
    throw new Error("Integration credential keys are unavailable.");
  }
  return parseCredentialKeys(serialized);
}

type PendingConnection = {
  pending_id: string;
  provider: IntegrationProvider;
  crew_id: string;
  provider_workspace_id: string;
  provider_workspace_name: string;
  credential_ciphertext: string;
  credential_nonce: string;
  credential_key_version: number;
  credential_fingerprint: string;
  scopes: string[];
};

type DestinationSecret = {
  destination_id: string;
  crew_id: string;
  provider: IntegrationProvider;
  provider_workspace_id: string;
  provider_destination_id: string;
  status: string;
  credential_ciphertext: string | null;
  credential_nonce: string | null;
  credential_key_version: number | null;
  credential_fingerprint: string | null;
  revoke_safe: boolean;
};

async function pendingConnection(
  admin: AdminClient,
  setupToken: string,
  userId: string,
) {
  return one(
    await rpc<PendingConnection | PendingConnection[]>(
      admin,
      "get_pending_integration_connection",
      {
        target_setup_token_hash: await sha256Hex(setupToken),
        target_user_id: userId,
      },
    ),
  );
}

async function decryptPending(
  pending: PendingConnection,
  dependencies: Dependencies,
) {
  return await dependencies.decryptProviderCredential({
    destination_id: pending.pending_id,
    provider: pending.provider,
    credential_ciphertext: pending.credential_ciphertext,
    credential_nonce: pending.credential_nonce,
    credential_key_version: pending.credential_key_version,
  }, credentialKeys(dependencies.env));
}

function normalizedDestination(item: Record<string, unknown>) {
  return {
    id: item.destination_id,
    provider: item.provider,
    workspaceId: item.workspace_id,
    workspaceName: item.workspace_name,
    channelId: item.channel_id,
    channelName: item.channel_name,
    status: item.status,
    lastVerifiedAt: item.last_verified_at,
    lastTestedAt: item.last_tested_at,
    lastDeliveredAt: item.last_delivered_at,
    healthCode: item.health_code,
    lastErrorCode: item.last_error_code,
    correctiveAction: item.corrective_action,
    checkInsEnabled: item.check_ins_enabled,
    streakMilestonesEnabled: item.streak_milestones_enabled,
    badgesRewardsEnabled: item.badges_rewards_enabled,
    membershipEnabled: item.membership_enabled,
    recapCadence: item.recap_cadence,
    includeSafeLink: item.include_safe_link,
    canManage: item.can_manage,
  };
}

async function listDestinations(
  req: Request,
  crewId: string,
  dependencies: Dependencies,
) {
  const userClient = dependencies.createUserClient(req);
  const data = await rpc<Record<string, unknown>[]>(
    userClient,
    "list_crew_integration_destinations",
    { target_crew_id: crewId },
  );
  return (data || []).map(normalizedDestination);
}

async function beginAuthorization(
  admin: AdminClient,
  userId: string,
  crewId: string,
  selectedProvider: IntegrationProvider,
  dependencies: Dependencies,
) {
  const stateSecret = integrationStateSecret(dependencies.env);
  const oauthState = await dependencies.createIntegrationOAuthState(
    selectedProvider,
    stateSecret,
    dependencies.now(),
  );
  await rpc(admin, "create_integration_oauth_state", {
    target_user_id: userId,
    target_crew_id: crewId,
    target_provider: selectedProvider,
    target_nonce_hash: oauthState.nonceHash,
    target_return_path: "/community.html",
    target_expires_at: oauthState.expiresAt.toISOString(),
  });
  return dependencies.providerAuthorizationUrl(
    selectedProvider,
    oauthState.state,
    dependencies.env,
  );
}

async function confirmDestination(
  admin: AdminClient,
  userId: string,
  setupToken: string,
  channelId: string,
  dependencies: Dependencies,
) {
  const pending = await pendingConnection(admin, setupToken, userId);
  const credential = await decryptPending(pending, dependencies);
  const selected = await dependencies.requireProviderChannel(
    pending.provider,
    credential.accessToken,
    pending.provider_workspace_id,
    channelId,
  );
  const destinationId = await rpc<string>(
    admin,
    "prepare_integration_destination_id",
    {
      target_crew_id: pending.crew_id,
      target_provider: pending.provider,
      target_user_id: userId,
    },
  );
  const keys = credentialKeys(dependencies.env);
  const keyVersion = currentCredentialKeyVersion(keys);
  const encrypted = await dependencies.encryptProviderCredential(
    credential,
    destinationId,
    pending.provider,
    keyVersion,
    keys,
  );
  await rpc(admin, "complete_pending_integration_connection", {
    target_setup_token_hash: await sha256Hex(setupToken),
    target_user_id: userId,
    target_destination_id: destinationId,
    target_provider_destination_id: selected.id,
    target_destination_name: selected.name,
    target_credential_ciphertext: base64ToPostgresBytea(encrypted.ciphertext),
    target_credential_nonce: base64ToPostgresBytea(encrypted.nonce),
    target_credential_key_version: encrypted.keyVersion,
    target_credential_fingerprint: await sha256Hex(credential.accessToken),
  });
  return {
    id: destinationId,
    crewId: pending.crew_id,
    provider: pending.provider,
  };
}

async function destinationSecret(
  admin: AdminClient,
  destinationId: string,
  userId: string,
) {
  return one(
    await rpc<DestinationSecret | DestinationSecret[]>(
      admin,
      "get_integration_destination_secret",
      { target_destination_id: destinationId, target_user_id: userId },
    ),
  );
}

async function testDestination(
  admin: AdminClient,
  secret: DestinationSecret,
  userId: string,
  dependencies: Dependencies,
) {
  if (
    secret.status === "disconnected" || !secret.credential_ciphertext ||
    !secret.credential_nonce || !secret.credential_key_version
  ) throw new HttpError("Reconnect this destination before testing it.", 409);
  const credential = await dependencies.decryptProviderCredential({
    destination_id: secret.destination_id,
    provider: secret.provider,
    credential_ciphertext: secret.credential_ciphertext,
    credential_nonce: secret.credential_nonce,
    credential_key_version: secret.credential_key_version,
  }, credentialKeys(dependencies.env));
  const testDelivery: ClaimedDelivery = {
    delivery_id: secret.destination_id,
    crew_id: secret.crew_id,
    destination_id: secret.destination_id,
    subject_user_id: null,
    source_reference: "integration:test",
    provider: secret.provider,
    provider_workspace_id: secret.provider_workspace_id,
    provider_destination_id: secret.provider_destination_id,
    event_type: "integration.test",
    payload: {
      text:
        "[TEST] 77 Dominion connection confirmed. Group updates can be delivered here.",
    },
    attempt_number: 1,
    max_attempts: 1,
    credential_ciphertext: secret.credential_ciphertext,
    credential_nonce: secret.credential_nonce,
    credential_key_version: secret.credential_key_version,
  };
  const result = await dependencies.sendProviderMessage(
    testDelivery,
    credential,
  );
  if (result.outcome === "delivered") {
    await rpc(admin, "mark_integration_destination_health", {
      target_destination_id: secret.destination_id,
      target_user_id: userId,
      target_healthy: true,
      target_error_code: null,
    });
    return { delivered: true, status: "active" };
  }

  const needsAttention = [
    "provider_authorization_failed",
    "provider_destination_missing",
    "provider_rejected",
  ].includes(result.errorCode || "");
  if (needsAttention) {
    await rpc(admin, "mark_integration_destination_health", {
      target_destination_id: secret.destination_id,
      target_user_id: userId,
      target_healthy: false,
      target_error_code: result.errorCode,
    });
  }
  throw new HttpError(
    needsAttention
      ? "The provider connection needs attention. Reconnect it and verify the channel."
      : "The provider is temporarily unavailable. Try the test again.",
    needsAttention ? 409 : 503,
  );
}

async function disconnectDestination(
  admin: AdminClient,
  secret: DestinationSecret,
  userId: string,
  dependencies: Dependencies,
) {
  let providerRevoked = false;
  if (
    secret.revoke_safe && secret.credential_ciphertext &&
    secret.credential_nonce &&
    secret.credential_key_version
  ) {
    try {
      const credential = await dependencies.decryptProviderCredential({
        destination_id: secret.destination_id,
        provider: secret.provider,
        credential_ciphertext: secret.credential_ciphertext,
        credential_nonce: secret.credential_nonce,
        credential_key_version: secret.credential_key_version,
      }, credentialKeys(dependencies.env));
      providerRevoked = await dependencies.revokeProviderCredential(
        secret.provider,
        credential.accessToken,
        secret.provider_workspace_id,
      );
    } catch {
      providerRevoked = false;
    }
  }
  await rpc(admin, "disconnect_integration_destination", {
    target_destination_id: secret.destination_id,
    target_user_id: userId,
  });
  return { disconnected: true, providerRevoked };
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
      const user = await dependencies.requireUser(req);
      let parsed: Record<string, unknown>;
      try {
        parsed = bodyObject(await req.json());
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError("Request body must be valid JSON.", 400);
      }
      const action = parsed.action;
      if (typeof action !== "string") {
        throw new HttpError("An action is required.", 400);
      }
      const admin = dependencies.createAdminClient();

      if (action === "list") {
        const crewId = uuid(parsed.crewId, "group ID");
        return jsonResponse(
          { destinations: await listDestinations(req, crewId, dependencies) },
          200,
          req,
          dependencies.env,
        );
      }

      if (action === "begin") {
        const crewId = uuid(parsed.crewId, "group ID");
        const selectedProvider = provider(parsed.provider);
        const authorizationUrl = await beginAuthorization(
          admin,
          user.id,
          crewId,
          selectedProvider,
          dependencies,
        );
        return jsonResponse({ authorizationUrl }, 200, req, dependencies.env);
      }

      if (action === "channels") {
        const setupToken = token(parsed.setupToken, "integration setup token");
        const pending = await pendingConnection(admin, setupToken, user.id);
        const credential = await decryptPending(pending, dependencies);
        const channels = await dependencies.listProviderChannels(
          pending.provider,
          credential.accessToken,
          pending.provider_workspace_id,
        );
        return jsonResponse(
          {
            provider: pending.provider,
            crewId: pending.crew_id,
            workspace: {
              id: pending.provider_workspace_id,
              name: pending.provider_workspace_name,
            },
            channels,
          },
          200,
          req,
          dependencies.env,
        );
      }

      if (action === "confirm") {
        const setupToken = token(parsed.setupToken, "integration setup token");
        const selectedChannel = channel(parsed.channelId);
        const destination = await confirmDestination(
          admin,
          user.id,
          setupToken,
          selectedChannel,
          dependencies,
        );
        return jsonResponse({ destination }, 200, req, dependencies.env);
      }

      if (action === "test") {
        const destinationId = uuid(parsed.destinationId, "destination ID");
        const secret = await destinationSecret(admin, destinationId, user.id);
        return jsonResponse(
          await testDestination(admin, secret, user.id, dependencies),
          200,
          req,
          dependencies.env,
        );
      }

      if (action === "configure") {
        const destinationId = uuid(parsed.destinationId, "destination ID");
        await rpc(admin, "update_integration_destination_settings", {
          target_destination_id: destinationId,
          target_actor_id: user.id,
          target_check_ins_enabled: requiredBoolean(
            parsed.checkInsEnabled,
            "Daily Check-In updates",
          ),
          target_streak_milestones_enabled: requiredBoolean(
            parsed.streakMilestonesEnabled,
            "Streak milestone updates",
          ),
          target_badges_rewards_enabled: requiredBoolean(
            parsed.badgesRewardsEnabled,
            "Badge and reward updates",
          ),
          target_membership_enabled: requiredBoolean(
            parsed.membershipEnabled,
            "Membership updates",
          ),
          target_recap_cadence: recapCadence(parsed.recapCadence),
          target_include_safe_link: requiredBoolean(
            parsed.includeSafeLink,
            "Dominion links",
          ),
        });
        return jsonResponse(
          { configured: true, destinationId },
          200,
          req,
          dependencies.env,
        );
      }

      if (action === "disconnect") {
        const destinationId = uuid(parsed.destinationId, "destination ID");
        const secret = await destinationSecret(admin, destinationId, user.id);
        return jsonResponse(
          await disconnectDestination(admin, secret, user.id, dependencies),
          200,
          req,
          dependencies.env,
        );
      }

      throw new HttpError("Unsupported integration action.", 400);
    } catch (error) {
      if (error instanceof ProviderConnectionError) {
        const status = error.retryable ? 503 : 409;
        return jsonResponse(
          { error: error.message },
          status,
          req,
          dependencies.env,
        );
      }
      if (!(error instanceof HttpError) || error.status >= 500) {
        dependencies.logger.error(JSON.stringify({
          event: "integration.connection.failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }));
      }
      return errorResponse(
        error,
        "Unable to manage the group integration.",
        req,
        dependencies.env,
      );
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
