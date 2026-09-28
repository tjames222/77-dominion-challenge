// Server-only native Auth setup material. This purpose is deliberately separate
// from the seven-day application invitation. Never return decrypted mail to UI.
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";
import {
  type EarlyAccessInvitationEnvelope,
  type EarlyAccessInvitationKey,
} from "./early_access_invitation.ts";
import {
  type TransactionalEmailContent,
  transactionalEmailFingerprint,
} from "./transactional_email.ts";

export const EARLY_ACCESS_AUTH_ORIGIN =
  "https://mimolwojppbtsbvtqwpo.supabase.co";
export const EARLY_ACCESS_AUTH_REDIRECT =
  "https://77dominion.com/reset-password.html";
export const EARLY_ACCESS_AUTH_TTL_SECONDS = 3600;
const PURPOSE = "native_recovery";
const SUBJECT = "Set up your Dominion account";
const FAILURE = "Invalid early-access account setup mail.";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 16384;
export type EarlyAccessRecoveryBinding = Readonly<{
  requestId: string;
  generationId: string;
  deliveryId: string;
  reservedUserId: string;
  recipient: string;
  issuedAt: string;
  expiresAt: string;
  from: string;
}>;
export type EarlyAccessRecoveryFingerprint = Readonly<{
  contentFingerprint: string;
  idempotencyKey: string;
}>;
function fail(): never {
  throw new TypeError(FAILURE);
}
function record(value: unknown, keys: readonly string[]) {
  if (
    value === null || typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  ) fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isSafeInteger(Date.parse(value)) && Date.parse(value) > 0 &&
    new Date(Date.parse(value)).toISOString() === value;
}
function bindingSnapshot(value: EarlyAccessRecoveryBinding) {
  const b = record(value, [
    "requestId",
    "generationId",
    "deliveryId",
    "reservedUserId",
    "recipient",
    "issuedAt",
    "expiresAt",
    "from",
  ]);
  if (
    [b.requestId, b.generationId, b.deliveryId, b.reservedUserId].some((id) =>
      typeof id !== "string" || !UUID.test(id)
    ) ||
    typeof b.recipient !== "string" || b.recipient.length > 254 ||
    !EMAIL.test(b.recipient) ||
    typeof b.from !== "string" || b.from.length > 322 ||
    !timestamp(b.issuedAt) || !timestamp(b.expiresAt) ||
    Date.parse(b.expiresAt) <= Date.parse(b.issuedAt) ||
    Date.parse(b.expiresAt) - Date.parse(b.issuedAt) >
      EARLY_ACCESS_AUTH_TTL_SECONDS * 1000
  ) fail();
  const named = /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}) <([^<>]+)>$/.exec(b.from);
  const sender = named ? named[2] : b.from;
  if (
    sender.length > 254 || !EMAIL.test(sender) ||
    !sender.endsWith("@mail.77dominion.com")
  ) fail();
  return b as EarlyAccessRecoveryBinding;
}
function version(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1 && value <= 2147483647;
}
function keySnapshot(value: EarlyAccessInvitationKey) {
  const k = record(value, ["keyVersion", "key"]);
  if (
    !version(k.keyVersion) || !(k.key instanceof Uint8Array) ||
    k.key.byteLength !== 32
  ) fail();
  return { keyVersion: k.keyVersion, key: Uint8Array.from(k.key) };
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}
function decode(value: unknown, limit: number) {
  if (
    typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil(limit * 4 / 3) || value.length % 4 === 1
  ) fail();
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  if (bytes.byteLength > limit || base64url(bytes) !== value) fail();
  return bytes;
}
function nativeLink(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value) || value.includes("#")
  ) fail();
  const url = new URL(value);
  if (
    url.origin !== EARLY_ACCESS_AUTH_ORIGIN ||
    url.pathname !== "/auth/v1/verify" || url.username || url.password ||
    [...url.searchParams.keys()].length !== 3 ||
    url.searchParams.getAll("token").length !== 1 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(url.searchParams.get("token") || "") ||
    url.searchParams.getAll("type").length !== 1 ||
    url.searchParams.get("type") !== "recovery" ||
    url.searchParams.getAll("redirect_to").length !== 1 ||
    url.searchParams.get("redirect_to") !== EARLY_ACCESS_AUTH_REDIRECT ||
    url.href !== value
  ) fail();
  return value;
}
function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function render(
  b: EarlyAccessRecoveryBinding,
  link: string,
): TransactionalEmailContent {
  return Object.freeze({
    deliveryId: b.deliveryId,
    idempotencyKey: `dominion-early-access-setup/${b.deliveryId}`,
    message: Object.freeze({
      from: b.from,
      to: b.recipient,
      subject: SUBJECT,
      text: [
        "Your Dominion Early Access request was approved.",
        "First, set a password for your new account:",
        link,
        `This private, one-use setup link expires on ${b.expiresAt} (UTC). Do not share it.`,
        "After setting your password, sign in with this email address. Your separate Early Access invitation will arrive after account confirmation. Accepting that invitation is a separate step; setting your password does not start a subscription or charge.",
        `If you did not request access or need a new setup link, contact ${SUPPORT_EMAIL}.`,
      ].join("\n\n"),
      html: [
        '<!doctype html><html lang="en"><body><h1>Set up your Dominion account</h1>',
        "<p>Your Early Access request was approved. First, set a password for your new account.</p>",
        `<p><a href="${escape(link)}">Set your password</a></p>`,
        `<p>This private, one-use setup link expires on ${
          escape(b.expiresAt)
        } (UTC). Do not share it.</p>`,
        "<p>After setting your password, sign in with this email address. Your separate Early Access invitation will arrive after account confirmation. Accepting that invitation is a separate step; setting your password does not start a subscription or charge.</p>",
        `<p>If you did not request access or need a new setup link, contact <a href="mailto:${
          escape(SUPPORT_EMAIL)
        }">${escape(SUPPORT_EMAIL)}</a>.</p></body></html>`,
      ].join(""),
    }),
  });
}
function fingerprintSnapshot(
  value: EarlyAccessRecoveryFingerprint,
  b: EarlyAccessRecoveryBinding,
) {
  const f = record(value, ["contentFingerprint", "idempotencyKey"]);
  if (
    typeof f.contentFingerprint !== "string" ||
    !HASH.test(f.contentFingerprint) ||
    f.idempotencyKey !== `dominion-early-access-setup/${b.deliveryId}`
  ) fail();
  return f as EarlyAccessRecoveryFingerprint;
}
function aad(
  b: EarlyAccessRecoveryBinding,
  keyVersion: number,
  f: EarlyAccessRecoveryFingerprint,
) {
  return encoder.encode(
    JSON.stringify([
      "dominion-early-access-envelope",
      PURPOSE,
      1,
      keyVersion,
      b.requestId,
      b.generationId,
      b.deliveryId,
      b.reservedUserId,
      b.recipient,
      b.issuedAt,
      b.expiresAt,
      b.from,
      f.contentFingerprint,
      f.idempotencyKey,
    ]),
  );
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
export async function createEarlyAccessRecoveryMail(
  bindingValue: EarlyAccessRecoveryBinding,
  recoveryActionLink: string,
  keyValue: EarlyAccessInvitationKey,
) {
  try {
    const binding = bindingSnapshot(bindingValue);
    const link = nativeLink(recoveryActionLink);
    const secret = keySnapshot(keyValue);
    const content = render(binding, link);
    const expected = Object.freeze({
      contentFingerprint: await transactionalEmailFingerprint(content),
      idempotencyKey: content.idempotencyKey,
    });
    const plaintext = encoder.encode(
      JSON.stringify({ version: 1, purpose: PURPOSE, link, content }),
    );
    if (plaintext.byteLength > MAX_BYTES) fail();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        tagLength: 128,
        additionalData: aad(binding, secret.keyVersion, expected),
      },
      await importKey(secret.key, "encrypt"),
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
export async function openEarlyAccessRecoveryMail(
  envelopeValue: EarlyAccessInvitationEnvelope,
  bindingValue: EarlyAccessRecoveryBinding,
  keyValue: EarlyAccessInvitationKey,
  expectedValue: EarlyAccessRecoveryFingerprint,
): Promise<TransactionalEmailContent> {
  try {
    const binding = bindingSnapshot(bindingValue);
    const secret = keySnapshot(keyValue);
    const expected = fingerprintSnapshot(expectedValue, binding);
    const envelope = record(envelopeValue, [
      "version",
      "keyVersion",
      "nonce",
      "ciphertext",
    ]);
    if (envelope.version !== 1 || envelope.keyVersion !== secret.keyVersion) {
      fail();
    }
    const nonce = decode(envelope.nonce, 12);
    const ciphertext = decode(envelope.ciphertext, MAX_BYTES + 16);
    if (nonce.length !== 12 || ciphertext.length <= 16) fail();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        tagLength: 128,
        additionalData: aad(binding, secret.keyVersion, expected),
      },
      await importKey(secret.key, "decrypt"),
      ciphertext,
    );
    if (plaintext.byteLength > MAX_BYTES) fail();
    const payload = record(JSON.parse(decoder.decode(plaintext)), [
      "version",
      "purpose",
      "link",
      "content",
    ]);
    if (payload.version !== 1 || payload.purpose !== PURPOSE) fail();
    const link = nativeLink(payload.link);
    const c = record(payload.content, [
      "deliveryId",
      "idempotencyKey",
      "message",
    ]);
    const m = record(c.message, ["from", "to", "subject", "text", "html"]);
    if (
      c.deliveryId !== binding.deliveryId ||
      c.idempotencyKey !== expected.idempotencyKey || m.from !== binding.from ||
      m.to !== binding.recipient || m.subject !== SUBJECT ||
      typeof m.text !== "string" || typeof m.html !== "string" ||
      m.text.split(link).length !== 2 ||
      m.html.split(escape(link)).length !== 2 ||
      !m.html.includes(`href="${escape(link)}"`)
    ) fail();
    // Validate saved bytes, never rerender retries with the current template.
    const content = Object.freeze({
      deliveryId: c.deliveryId as string,
      idempotencyKey: c.idempotencyKey as string,
      message: Object.freeze({
        from: m.from as string,
        to: m.to as string,
        subject: m.subject as string,
        text: m.text,
        html: m.html,
      }),
    });
    if (
      await transactionalEmailFingerprint(content) !==
        expected.contentFingerprint
    ) fail();
    return content;
  } catch {
    fail();
  }
}
