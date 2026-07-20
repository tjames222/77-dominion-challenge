export type IntegrationProvider = "slack" | "discord";

export type ClaimedDelivery = {
  delivery_id: string;
  crew_id: string;
  destination_id: string;
  subject_user_id: string | null;
  source_reference: string | null;
  provider: IntegrationProvider;
  provider_workspace_id: string;
  provider_destination_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_number: number;
  max_attempts: number;
  credential_ciphertext: string | Uint8Array;
  credential_nonce: string | Uint8Array;
  credential_key_version: number;
};

export type DeliveryResult = {
  outcome: "delivered" | "retry" | "dead_letter";
  httpStatus?: number;
  providerRequestId?: string;
  retryAfterSeconds?: number;
  errorCode?: string;
  errorSummary?: string;
  responseMetadata: Record<string, unknown>;
};

export type ProviderCredential = {
  accessToken: string;
};

type Fetcher = typeof fetch;

const sensitiveKey =
  /(authorization|credential|secret|token|webhook|content|payload|body)/i;

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function decodeBase64(value: string) {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePostgresBytes(value: string | Uint8Array) {
  if (value instanceof Uint8Array) return value;
  if (value.startsWith("\\x")) {
    const hex = value.slice(2);
    if (!/^(?:[a-f\d]{2})+$/i.test(hex)) {
      throw new Error("Invalid PostgreSQL bytea value.");
    }
    return Uint8Array.from(
      hex.match(/.{2}/g) || [],
      (pair) => Number.parseInt(pair, 16),
    );
  }
  return decodeBase64(value);
}

export function parseCredentialKeys(serialized: string) {
  let source: unknown;
  try {
    source = JSON.parse(serialized);
  } catch {
    throw new Error("INTEGRATION_CREDENTIAL_KEYS must be valid JSON.");
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("INTEGRATION_CREDENTIAL_KEYS must be a versioned object.");
  }

  const keys = new Map<number, Uint8Array>();
  for (const [rawVersion, rawKey] of Object.entries(source)) {
    const version = Number(rawVersion);
    if (
      !Number.isInteger(version) || version < 1 || typeof rawKey !== "string"
    ) {
      throw new Error("Invalid credential key version.");
    }
    const decoded = decodeBase64(rawKey);
    if (decoded.byteLength !== 32) {
      throw new Error("Integration credential keys must contain 32 bytes.");
    }
    keys.set(version, decoded);
  }

  if (keys.size === 0) {
    throw new Error("At least one credential key is required.");
  }
  return keys;
}

async function importCredentialKey(raw: Uint8Array, usage: KeyUsage) {
  return await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw).buffer,
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

function credentialAad(destinationId: string, provider: IntegrationProvider) {
  return utf8(`77-dominion:${provider}:${destinationId}`);
}

export async function encryptProviderCredential(
  credential: ProviderCredential,
  destinationId: string,
  provider: IntegrationProvider,
  keyVersion: number,
  keys: Map<number, Uint8Array>,
  nonce = crypto.getRandomValues(new Uint8Array(12)),
) {
  if (!credential.accessToken || credential.accessToken.length > 8192) {
    throw new Error("Invalid provider credential.");
  }
  const rawKey = keys.get(keyVersion);
  if (!rawKey) throw new Error("Unknown integration credential key version.");
  if (nonce.byteLength !== 12) {
    throw new Error("Credential nonce must be 12 bytes.");
  }

  const key = await importCredentialKey(rawKey, "encrypt");
  const plaintext = utf8(JSON.stringify(credential));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: credentialAad(destinationId, provider),
      tagLength: 128,
    },
    key,
    plaintext,
  );

  return {
    ciphertext: encodeBase64(new Uint8Array(encrypted)),
    nonce: encodeBase64(nonce),
    keyVersion,
  };
}

export async function decryptProviderCredential(
  delivery: Pick<
    ClaimedDelivery,
    | "destination_id"
    | "provider"
    | "credential_ciphertext"
    | "credential_nonce"
    | "credential_key_version"
  >,
  keys: Map<number, Uint8Array>,
) {
  const rawKey = keys.get(delivery.credential_key_version);
  if (!rawKey) throw new Error("Unknown integration credential key version.");
  const key = await importCredentialKey(rawKey, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(decodePostgresBytes(delivery.credential_nonce))
        .buffer,
      additionalData: credentialAad(delivery.destination_id, delivery.provider),
      tagLength: 128,
    },
    key,
    Uint8Array.from(decodePostgresBytes(delivery.credential_ciphertext)).buffer,
  );

  let credential: unknown;
  try {
    credential = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Decrypted provider credential is invalid.");
  }
  if (
    !credential || typeof credential !== "object" ||
    !("accessToken" in credential) ||
    typeof (credential as ProviderCredential).accessToken !== "string" ||
    !(credential as ProviderCredential).accessToken
  ) {
    throw new Error("Decrypted provider credential is invalid.");
  }
  return credential as ProviderCredential;
}

export function redactIntegrationMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactIntegrationMetadata);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[redacted]" : redactIntegrationMetadata(item),
    ]),
  );
}

function textPayload(delivery: ClaimedDelivery) {
  const text = delivery.payload.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Delivery payload text is required.");
  }
  const limit = delivery.provider === "discord" ? 2000 : 40000;
  if (text.length > limit) {
    throw new Error("Delivery payload text is too long.");
  }
  return text;
}

function retryAfter(response: Response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(86400, Math.max(1, Math.ceil(seconds)));
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.min(86400, Math.max(1, Math.ceil((date - Date.now()) / 1000)));
}

function resultForHttpFailure(
  provider: IntegrationProvider,
  response: Response,
): DeliveryResult {
  const status = response.status;
  const shouldRetry = status === 408 || status === 425 || status === 429 ||
    status >= 500;
  return {
    outcome: shouldRetry ? "retry" : "dead_letter",
    httpStatus: status,
    providerRequestId: response.headers.get("x-request-id") ||
      response.headers.get("x-slack-req-id") || undefined,
    retryAfterSeconds: status === 429 ? retryAfter(response) : undefined,
    errorCode: status === 429
      ? "provider_rate_limited"
      : shouldRetry
      ? "provider_unavailable"
      : status === 401 || status === 403
      ? "provider_authorization_failed"
      : status === 404
      ? "provider_destination_missing"
      : "provider_rejected",
    errorSummary: shouldRetry
      ? `${provider} temporarily rejected the delivery.`
      : `${provider} permanently rejected the delivery.`,
    responseMetadata: {
      provider,
      rateLimited: status === 429,
    },
  };
}

const retryableSlackErrors = new Set([
  "ratelimited",
  "internal_error",
  "request_timeout",
  "service_unavailable",
]);

async function sendSlack(
  delivery: ClaimedDelivery,
  credential: ProviderCredential,
  fetcher: Fetcher,
): Promise<DeliveryResult> {
  const body: Record<string, unknown> = {
    channel: delivery.provider_destination_id,
    text: textPayload(delivery),
    link_names: false,
    mrkdwn: false,
  };
  if (Array.isArray(delivery.payload.blocks)) {
    body.blocks = delivery.payload.blocks;
  }

  const response = await fetcher("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "77-Dominion-Integration-Worker/1.0",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return resultForHttpFailure("slack", response);

  let responseBody: { ok?: boolean; error?: string } = {};
  try {
    responseBody = await response.json();
  } catch {
    return {
      outcome: "retry",
      httpStatus: response.status,
      errorCode: "provider_invalid_response",
      errorSummary: "slack returned an unreadable response.",
      responseMetadata: { provider: "slack" },
    };
  }
  if (!responseBody.ok) {
    const providerCode = typeof responseBody.error === "string"
      ? responseBody.error
      : "unknown_error";
    const shouldRetry = retryableSlackErrors.has(providerCode);
    return {
      outcome: shouldRetry ? "retry" : "dead_letter",
      httpStatus: response.status,
      providerRequestId: response.headers.get("x-slack-req-id") || undefined,
      retryAfterSeconds: providerCode === "ratelimited"
        ? retryAfter(response)
        : undefined,
      errorCode: shouldRetry
        ? "provider_unavailable"
        : providerCode === "invalid_auth" || providerCode === "token_revoked" ||
            providerCode === "missing_scope"
        ? "provider_authorization_failed"
        : "provider_rejected",
      errorSummary: shouldRetry
        ? "slack temporarily rejected the delivery."
        : "slack permanently rejected the delivery.",
      responseMetadata: { provider: "slack", providerCode },
    };
  }

  return {
    outcome: "delivered",
    httpStatus: response.status,
    providerRequestId: response.headers.get("x-slack-req-id") || undefined,
    responseMetadata: { provider: "slack" },
  };
}

async function sendDiscord(
  delivery: ClaimedDelivery,
  credential: ProviderCredential,
  fetcher: Fetcher,
): Promise<DeliveryResult> {
  const body: Record<string, unknown> = {
    content: textPayload(delivery),
    allowed_mentions: { parse: [] },
  };
  if (Array.isArray(delivery.payload.embeds)) {
    body.embeds = delivery.payload.embeds;
  }

  const response = await fetcher(
    `https://discord.com/api/v10/channels/${
      encodeURIComponent(delivery.provider_destination_id)
    }/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${credential.accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "77-Dominion-Integration-Worker/1.0",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) return resultForHttpFailure("discord", response);

  return {
    outcome: "delivered",
    httpStatus: response.status,
    providerRequestId: response.headers.get("x-request-id") || undefined,
    responseMetadata: { provider: "discord" },
  };
}

export async function sendProviderMessage(
  delivery: ClaimedDelivery,
  credential: ProviderCredential,
  fetcher: Fetcher = fetch,
): Promise<DeliveryResult> {
  try {
    return delivery.provider === "slack"
      ? await sendSlack(delivery, credential, fetcher)
      : await sendDiscord(delivery, credential, fetcher);
  } catch (error) {
    if (error instanceof Error && /^Delivery payload/.test(error.message)) {
      return {
        outcome: "dead_letter",
        errorCode: "invalid_delivery_payload",
        errorSummary: "The provider delivery payload is invalid.",
        responseMetadata: { provider: delivery.provider },
      };
    }
    return {
      outcome: "retry",
      errorCode: "provider_network_error",
      errorSummary: `${delivery.provider} could not be reached.`,
      responseMetadata: { provider: delivery.provider },
    };
  }
}

export function safeDeliveryLog(
  event: string,
  delivery: Pick<
    ClaimedDelivery,
    "delivery_id" | "crew_id" | "provider" | "attempt_number"
  >,
  result?: DeliveryResult,
) {
  return {
    event,
    deliveryId: delivery.delivery_id,
    crewId: delivery.crew_id,
    provider: delivery.provider,
    attemptNumber: delivery.attempt_number,
    outcome: result?.outcome,
    httpStatus: result?.httpStatus,
    errorCode: result?.errorCode,
  };
}
