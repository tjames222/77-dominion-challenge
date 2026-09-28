// Server-only pure helper. A sealed application invitation is NOT a Supabase
// Auth credential. Database/session authority must enforce expiry and one use.
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";
import {
  type TransactionalEmailContent,
  transactionalEmailFingerprint,
} from "./transactional_email.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HASH = /^[0-9a-f]{64}$/;
const PURPOSE = "app_invitation";
const SUBJECT = "Your Dominion Early Access invitation";
const INVITE_URL = "https://77dominion.com/early-access-invite.html#token=";
const MAX_PLAINTEXT_BYTES = 8192;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 16;
const FAILURE = "Invalid early-access invitation configuration.";
export const EARLY_ACCESS_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type EarlyAccessInvitationBinding = Readonly<{
  requestId: string;
  generationId: string;
  deliveryId: string;
  recipient: string;
  issuedAt: string;
  expiresAt: string;
  from: string;
}>;

/** Supply only a dedicated invitation key, never an integration/Auth key. */
export type EarlyAccessInvitationKey = Readonly<{
  keyVersion: number;
  key: Uint8Array;
}>;

export type EarlyAccessInvitationEnvelope = Readonly<{
  version: 1;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
}>;

export type EarlyAccessInvitationFingerprint = Readonly<{
  tokenDigest: string;
  contentFingerprint: string;
  idempotencyKey: string;
}>;

export type SealedEarlyAccessInvitation =
  & EarlyAccessInvitationFingerprint
  & Readonly<{ envelope: EarlyAccessInvitationEnvelope }>;

function fail(): never {
  throw new TypeError(FAILURE);
}

// Reject getters and non-plain objects before reading their fields. Public
// entrypoints also replace any unexpected exception with the same safe error.
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    });
}

function mailbox(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

function sender(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 322) return false;
  const named = /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}) <([^<>]+)>$/.exec(value);
  const email = named ? named[2] : value;
  return mailbox(email) && email.endsWith("@mail.77dominion.com");
}

function timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return false;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 &&
    new Date(milliseconds).toISOString() === value;
}

function snapshotBinding(value: EarlyAccessInvitationBinding) {
  if (
    !exact(value, [
      "requestId",
      "generationId",
      "deliveryId",
      "recipient",
      "issuedAt",
      "expiresAt",
      "from",
    ]) ||
    [value.requestId, value.generationId, value.deliveryId].some((id) =>
      typeof id !== "string" || !UUID.test(id)
    ) ||
    !mailbox(value.recipient) ||
    value.recipient !== value.recipient.toLowerCase() ||
    !sender(value.from) || !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !==
      EARLY_ACCESS_INVITATION_LIFETIME_MS
  ) fail();
  return Object.freeze({
    requestId: value.requestId as string,
    generationId: value.generationId as string,
    deliveryId: value.deliveryId as string,
    recipient: value.recipient,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    from: value.from,
  });
}

function keyVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1 && value <= 2147483647;
}

function snapshotKey(value: EarlyAccessInvitationKey) {
  if (
    !exact(value, ["keyVersion", "key"]) || !keyVersion(value.keyVersion) ||
    !(value.key instanceof Uint8Array) || value.key.byteLength !== 32
  ) fail();
  return { keyVersion: value.keyVersion, key: Uint8Array.from(value.key) };
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function decodeBase64url(value: unknown, maxBytes: number) {
  if (
    typeof value !== "string" || !value.length ||
    value.length > Math.ceil(maxBytes * 4 / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1
  ) fail();
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > maxBytes || base64url(bytes) !== value) fail();
  return bytes;
}

async function digestToken(token: unknown) {
  const bytes = decodeBase64url(token, 32);
  if (bytes.byteLength !== 32) fail();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** Hash decoded 32 bytes, not UTF-8 token text. Reject all encoding aliases. */
export async function hashEarlyAccessInvitationToken(token: string) {
  try {
    return await digestToken(token);
  } catch {
    fail();
  }
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function render(binding: EarlyAccessInvitationBinding, token: string) {
  const url = INVITE_URL + token + `&generation=${binding.generationId}`;
  const text = [
    "Welcome to Dominion Early Access.",
    `Your request for ${binding.recipient} has been approved.`,
    "Accept your invitation:",
    url,
    `This one-use invitation expires on ${binding.expiresAt} (UTC).`,
    "Sign in with this email address, or follow the account setup instructions. This link does not sign you in.",
    "Early Access is free until we explicitly begin beta. Accepting your invitation qualifies you for the $3.50 USD monthly beta price, including if you cancel and return later. No charge or subscription starts when you accept.",
    "If you did not request this invitation, you can ignore it. Do not share this link.",
    `Questions? Contact ${SUPPORT_EMAIL}.`,
  ].join("\n\n");
  const html = [
    '<!doctype html><html lang="en"><body>',
    "<h1>Welcome to Dominion Early Access</h1>",
    `<p>Your request for <strong>${
      escapeHtml(binding.recipient)
    }</strong> has been approved.</p>`,
    `<p><a href="${escapeHtml(url)}">Accept your invitation</a></p>`,
    `<p>This one-use invitation expires on ${
      escapeHtml(binding.expiresAt)
    } (UTC).</p>`,
    "<p>Sign in with this email address, or follow the account setup instructions. This link does not sign you in.</p>",
    "<p>Early Access is free until we explicitly begin beta. Accepting your invitation qualifies you for the $3.50 USD monthly beta price, including if you cancel and return later. No charge or subscription starts when you accept.</p>",
    "<p>If you did not request this invitation, you can ignore it. Do not share this link.</p>",
    `<p>Questions? Contact <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}">${
      escapeHtml(SUPPORT_EMAIL)
    }</a>.</p>`,
    "</body></html>",
  ].join("");
  return Object.freeze({
    deliveryId: binding.deliveryId,
    idempotencyKey: `dominion-early-access/${binding.deliveryId}`,
    message: Object.freeze({
      from: binding.from,
      to: binding.recipient,
      subject: SUBJECT,
      text,
      html,
    }),
  });
}

function snapshotFingerprint(
  value: EarlyAccessInvitationFingerprint,
  binding: EarlyAccessInvitationBinding,
) {
  if (
    !exact(value, ["tokenDigest", "contentFingerprint", "idempotencyKey"]) ||
    typeof value.tokenDigest !== "string" || !HASH.test(value.tokenDigest) ||
    typeof value.contentFingerprint !== "string" ||
    !HASH.test(value.contentFingerprint) ||
    value.idempotencyKey !== `dominion-early-access/${binding.deliveryId}`
  ) fail();
  return Object.freeze({
    tokenDigest: value.tokenDigest,
    contentFingerprint: value.contentFingerprint,
    idempotencyKey: value.idempotencyKey as string,
  });
}

function aad(
  binding: EarlyAccessInvitationBinding,
  version: number,
  expected: EarlyAccessInvitationFingerprint,
) {
  return encoder.encode(JSON.stringify([
    "dominion-early-access-envelope",
    PURPOSE,
    1,
    version,
    binding.requestId,
    binding.generationId,
    binding.deliveryId,
    binding.recipient,
    binding.issuedAt,
    binding.expiresAt,
    binding.from,
    expected.tokenDigest,
    expected.contentFingerprint,
    expected.idempotencyKey,
  ]));
}

async function importKey(raw: Uint8Array, usage: KeyUsage) {
  return await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw).buffer,
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

/** Render and encrypt ONCE before the atomic invitation/outbox insert. */
export async function createEarlyAccessInvitation(
  value: EarlyAccessInvitationBinding,
  keyValue: EarlyAccessInvitationKey,
): Promise<SealedEarlyAccessInvitation> {
  try {
    const binding = snapshotBinding(value);
    const secret = snapshotKey(keyValue);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const content = render(binding, token);
    const expected = Object.freeze({
      tokenDigest: await digestToken(token),
      contentFingerprint: await transactionalEmailFingerprint(content),
      idempotencyKey: content.idempotencyKey,
    });
    const plaintext = encoder.encode(JSON.stringify({
      version: 1,
      purpose: PURPOSE,
      token,
      content,
    }));
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) fail();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await importKey(secret.key, "encrypt");
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        tagLength: 128,
        additionalData: aad(binding, secret.keyVersion, expected),
      },
      key,
      plaintext,
    );
    return Object.freeze({
      ...expected,
      envelope: Object.freeze({
        version: 1 as const,
        keyVersion: secret.keyVersion,
        nonce: base64url(nonce),
        ciphertext: base64url(new Uint8Array(ciphertext)),
      }),
    });
  } catch {
    fail();
  }
}

function snapshotEnvelope(value: EarlyAccessInvitationEnvelope) {
  if (
    !exact(value, ["version", "keyVersion", "nonce", "ciphertext"]) ||
    value.version !== 1 || !keyVersion(value.keyVersion)
  ) fail();
  const nonce = decodeBase64url(value.nonce, 12);
  const ciphertext = decodeBase64url(value.ciphertext, MAX_CIPHERTEXT_BYTES);
  if (nonce.byteLength !== 12 || ciphertext.byteLength <= 16) fail();
  return { keyVersion: value.keyVersion, nonce, ciphertext };
}

function snapshotContent(
  value: unknown,
  binding: EarlyAccessInvitationBinding,
) {
  if (!exact(value, ["deliveryId", "idempotencyKey", "message"])) fail();
  const message = value.message;
  if (
    value.deliveryId !== binding.deliveryId ||
    value.idempotencyKey !== `dominion-early-access/${binding.deliveryId}` ||
    !exact(message, ["from", "to", "subject", "text", "html"]) ||
    message.from !== binding.from || message.to !== binding.recipient ||
    message.subject !== SUBJECT || typeof message.text !== "string" ||
    typeof message.html !== "string"
  ) fail();
  return Object.freeze({
    deliveryId: value.deliveryId as string,
    idempotencyKey: value.idempotencyKey as string,
    message: Object.freeze({
      from: message.from as string,
      to: message.to as string,
      subject: message.subject as string,
      text: message.text,
      html: message.html,
    }),
  });
}

/** Open only a currently leased, database-authorized job; never rerender it. */
export async function openEarlyAccessInvitation(
  envelopeValue: EarlyAccessInvitationEnvelope,
  bindingValue: EarlyAccessInvitationBinding,
  keyValue: EarlyAccessInvitationKey,
  expectedValue: EarlyAccessInvitationFingerprint,
): Promise<TransactionalEmailContent> {
  try {
    // Snapshot every caller-owned value before the first await.
    const binding = snapshotBinding(bindingValue);
    const secret = snapshotKey(keyValue);
    const expected = snapshotFingerprint(expectedValue, binding);
    const envelope = snapshotEnvelope(envelopeValue);
    if (secret.keyVersion !== envelope.keyVersion) fail();
    const key = await importKey(secret.key, "decrypt");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: envelope.nonce,
        tagLength: 128,
        additionalData: aad(binding, envelope.keyVersion, expected),
      },
      key,
      envelope.ciphertext,
    );
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) fail();
    const payload: unknown = JSON.parse(decoder.decode(plaintext));
    if (
      !exact(payload, ["version", "purpose", "token", "content"]) ||
      payload.version !== 1 || payload.purpose !== PURPOSE ||
      typeof payload.token !== "string" ||
      await digestToken(payload.token) !== expected.tokenDigest
    ) fail();
    const content = snapshotContent(payload.content, binding);
    const link = INVITE_URL + payload.token +
      `&generation=${binding.generationId}`;
    if (
      content.message.text.split(link).length !== 2 ||
      content.message.html.split(escapeHtml(link)).length !== 2 ||
      !content.message.html.includes(`href="${escapeHtml(link)}"`) ||
      await transactionalEmailFingerprint(content) !==
        expected.contentFingerprint
    ) fail();
    return content;
  } catch {
    fail();
  }
}
