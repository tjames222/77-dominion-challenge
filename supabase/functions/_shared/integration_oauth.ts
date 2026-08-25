import type { EnvReader } from "./http.ts";
import type { IntegrationProvider } from "./integration_delivery.ts";

type OAuthStatePayload = {
  version: 1;
  provider: IntegrationProvider;
  nonce: string;
  expiresAt: number;
};

function bytesToBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function text(value: string) {
  return new TextEncoder().encode(value);
}

function hex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value: string, secret: string) {
  if (secret.length < 32) {
    throw new Error("Integration OAuth state secret is invalid.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    text(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, text(value)));
}

export async function sha256Hex(value: string) {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", text(value))),
  );
}

export function createOpaqueToken(bytes = 32) {
  if (bytes < 24 || bytes > 64) throw new Error("Invalid opaque token size.");
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createIntegrationOAuthState(
  provider: IntegrationProvider,
  secret: string,
  now = new Date(),
  nonce = createOpaqueToken(),
) {
  const payload: OAuthStatePayload = {
    version: 1,
    provider,
    nonce,
    expiresAt: Math.floor((now.getTime() + 10 * 60_000) / 1000),
  };
  const encoded = bytesToBase64Url(text(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmac(encoded, secret));
  return {
    state: `${encoded}.${signature}`,
    nonceHash: await sha256Hex(nonce),
    expiresAt: new Date(payload.expiresAt * 1000),
  };
}

function fixedTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function verifyIntegrationOAuthState(
  serialized: string,
  expectedProvider: IntegrationProvider,
  secret: string,
  now = new Date(),
) {
  const [encoded, rawSignature, ...rest] = serialized.split(".");
  if (!encoded || !rawSignature || rest.length) {
    throw new Error("Integration authorization state is invalid.");
  }
  const expectedSignature = await hmac(encoded, secret);
  let receivedSignature: Uint8Array;
  try {
    receivedSignature = base64UrlToBytes(rawSignature);
  } catch {
    throw new Error("Integration authorization state is invalid.");
  }
  if (!fixedTimeEqual(expectedSignature, receivedSignature)) {
    throw new Error("Integration authorization state is invalid.");
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    throw new Error("Integration authorization state is invalid.");
  }
  if (
    payload.version !== 1 || payload.provider !== expectedProvider ||
    typeof payload.nonce !== "string" || payload.nonce.length < 24 ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt * 1000 <= now.getTime()
  ) {
    throw new Error("Integration authorization state is invalid or expired.");
  }
  return { payload, nonceHash: await sha256Hex(payload.nonce) };
}

export function integrationStateSecret(env: EnvReader) {
  const value = env("INTEGRATION_OAUTH_STATE_SECRET");
  if (!value || value.length < 32) {
    throw new Error("INTEGRATION_OAUTH_STATE_SECRET is unavailable.");
  }
  return value;
}

export function currentCredentialKeyVersion(keys: Map<number, Uint8Array>) {
  const versions = [...keys.keys()];
  if (!versions.length) {
    throw new Error("Integration credential keys are unavailable.");
  }
  return Math.max(...versions);
}

export function base64ToPostgresBytea(value: string) {
  const binary = atob(value);
  return `\\x${
    [...binary]
      .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
  }`;
}

export function publicSiteUrl(env: EnvReader) {
  const raw = env("PUBLIC_SITE_URL");
  if (!raw) throw new Error("PUBLIC_SITE_URL is unavailable.");
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("PUBLIC_SITE_URL must use HTTPS.");
  }
  return url.origin;
}
