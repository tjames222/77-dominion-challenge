import { assert, assertEquals } from "./test_helpers.ts";
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";
import {
  createEarlyAccessInvitation,
  EARLY_ACCESS_INVITATION_LIFETIME_MS,
  type EarlyAccessInvitationBinding,
  type EarlyAccessInvitationEnvelope,
  type EarlyAccessInvitationFingerprint,
  type EarlyAccessInvitationKey,
  hashEarlyAccessInvitationToken,
  openEarlyAccessInvitation,
  type SealedEarlyAccessInvitation,
} from "./early_access_invitation.ts";
import { transactionalEmailFingerprint } from "./transactional_email.ts";

const linkPrefix = "https://77dominion.com/early-access-invite.html#token=";
const failure = "Invalid early-access invitation configuration.";
const binding = (): EarlyAccessInvitationBinding => ({
  requestId: "11111111-1111-4111-8111-111111111111",
  generationId: "22222222-2222-4222-8222-222222222222",
  deliveryId: "33333333-3333-4333-8333-333333333333",
  recipient: "invitee@example.test",
  issuedAt: "2026-09-27T12:00:00.000Z",
  expiresAt: "2026-10-04T12:00:00.000Z",
  from: "Dominion <noreply@mail.77dominion.com>",
});
const key = (): EarlyAccessInvitationKey => ({
  keyVersion: 1,
  // Public, nonproduction test vector; never written to runtime configuration.
  key: Uint8Array.from({ length: 32 }, (_, index) => index),
});
function fingerprint(value: SealedEarlyAccessInvitation) {
  return {
    tokenDigest: value.tokenDigest,
    contentFingerprint: value.contentFingerprint,
    idempotencyKey: value.idempotencyKey,
  };
}
async function invalid(operation: () => unknown | Promise<unknown>) {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof TypeError);
  assertEquals(caught.message, failure);
  assertEquals(Object.keys(caught), []);
  assert(!Object.hasOwn(caught, "cause"));
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}
function bytes(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
}
function tamper(value: string) {
  const decoded = bytes(value);
  decoded[0] ^= 1;
  return base64url(decoded);
}
function aad(
  value: EarlyAccessInvitationBinding,
  expected: EarlyAccessInvitationFingerprint,
  purpose = "app_invitation",
) {
  return new TextEncoder().encode(JSON.stringify([
    "dominion-early-access-envelope",
    purpose,
    1,
    1,
    value.requestId,
    value.generationId,
    value.deliveryId,
    value.recipient,
    value.issuedAt,
    value.expiresAt,
    value.from,
    expected.tokenDigest,
    expected.contentFingerprint,
    expected.idempotencyKey,
  ]));
}
async function decryptFixture(value: SealedEarlyAccessInvitation) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key().key).buffer,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(value.envelope.nonce),
      tagLength: 128,
      additionalData: aad(binding(), fingerprint(value)),
    },
    cryptoKey,
    bytes(value.envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function sealFixture(
  plaintext: string | Uint8Array,
  expected: EarlyAccessInvitationFingerprint,
  purpose = "app_invitation",
) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key().key).buffer,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      tagLength: 128,
      additionalData: aad(binding(), expected, purpose),
    },
    cryptoKey,
    typeof plaintext === "string"
      ? new TextEncoder().encode(plaintext)
      : Uint8Array.from(plaintext).buffer,
  );
  return {
    version: 1 as const,
    keyVersion: 1,
    nonce: base64url(nonce),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
}

Deno.test("invitation creation returns only immutable encrypted payload and bindings", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  assertEquals(Object.keys(value), [
    "tokenDigest",
    "contentFingerprint",
    "idempotencyKey",
    "envelope",
  ]);
  assertEquals(Object.keys(value.envelope), [
    "version",
    "keyVersion",
    "nonce",
    "ciphertext",
  ]);
  assert(Object.isFrozen(value));
  assert(Object.isFrozen(value.envelope));
  assert(/^[0-9a-f]{64}$/.test(value.tokenDigest));
  assert(/^[0-9a-f]{64}$/.test(value.contentFingerprint));
  assertEquals(
    value.idempotencyKey,
    `dominion-early-access/${binding().deliveryId}`,
  );
  assertEquals(value.envelope.nonce.length, 16);
  assert(value.envelope.ciphertext.length <= 10944);
  const serialized = JSON.stringify(value);
  for (
    const plaintext of [binding().recipient, linkPrefix, "noreply", "Welcome"]
  ) {
    assert(!serialized.includes(plaintext));
  }
});

Deno.test("invitation envelope round trips exact frozen transactional message", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  const content = await openEarlyAccessInvitation(
    value.envelope,
    binding(),
    key(),
    fingerprint(value),
  );
  assert(Object.isFrozen(content));
  assert(Object.isFrozen(content.message));
  assertEquals(content.deliveryId, binding().deliveryId);
  assertEquals(content.idempotencyKey, value.idempotencyKey);
  assertEquals(content.message.from, binding().from);
  assertEquals(content.message.to, binding().recipient);
  assertEquals(
    await transactionalEmailFingerprint(content),
    value.contentFingerprint,
  );
  const token = content.message.text.split(linkPrefix)[1].split("&")[0];
  assertEquals(token.length, 43);
  assertEquals(bytes(token).byteLength, 32);
  assertEquals(await hashEarlyAccessInvitationToken(token), value.tokenDigest);
  assert(
    content.message.html.includes(
      `href="${linkPrefix}${token}&amp;generation=${binding().generationId}"`,
    ),
  );
  assert(
    content.message.text.includes(
      `${linkPrefix}${token}&generation=${binding().generationId}`,
    ),
  );
  assert(content.message.text.includes(binding().expiresAt));
  assert(content.message.text.includes(SUPPORT_EMAIL));
  assert(content.message.html.includes(`mailto:${SUPPORT_EMAIL}`));
  assert(content.message.text.includes("$3.50 USD monthly beta price"));
  assert(
    content.message.text.includes("including if you cancel and return later"),
  );
  assert(content.message.text.includes("No charge or subscription starts"));
  assert(content.message.text.includes("This link does not sign you in."));
  for (
    const nativeCredential of [
      "token_hash=",
      "access_token=",
      "/auth/v1/",
      "type=invite",
    ]
  ) {
    assert(!JSON.stringify(content).includes(nativeCredential));
  }
  assertEquals(
    await openEarlyAccessInvitation(
      value.envelope,
      binding(),
      key(),
      fingerprint(value),
    ),
    content,
  );
});

Deno.test("invitation random token and random nonce are fresh on every creation", async () => {
  const values = await Promise.all(
    Array.from(
      { length: 32 },
      () => createEarlyAccessInvitation(binding(), key()),
    ),
  );
  assertEquals(new Set(values.map((value) => value.tokenDigest)).size, 32);
  assertEquals(new Set(values.map((value) => value.envelope.nonce)).size, 32);
  assertEquals(
    new Set(values.map((value) => value.envelope.ciphertext)).size,
    32,
  );
});

Deno.test("invitation token digest hashes decoded bytes, not encoded text", async () => {
  assertEquals(
    await hashEarlyAccessInvitationToken("A".repeat(43)),
    "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
  );
});

for (
  const [label, token] of Object.entries({
    empty: "",
    short: "A".repeat(42),
    long: "A".repeat(44),
    padded: "A".repeat(43) + "=",
    whitespace: " " + "A".repeat(43),
    newline: "A".repeat(43) + "\n",
    standardAlphabet: "+" + "A".repeat(42),
    padBitAlias: "A".repeat(42) + "B",
    unicode: "é".repeat(43),
    huge: "A".repeat(100000),
    wrongType: null,
  })
) {
  Deno.test(`invitation token rejects ${label}`, async () => {
    await invalid(() => hashEarlyAccessInvitationToken(token as string));
  });
}

Deno.test("invitation HTML escapes allowed mailbox special characters", async () => {
  const recipient = "o'brien&company@example.test";
  const input = { ...binding(), recipient };
  const value = await createEarlyAccessInvitation(input, key());
  const content = await openEarlyAccessInvitation(
    value.envelope,
    input,
    key(),
    fingerprint(value),
  );
  assert(content.message.text.includes(recipient));
  assert(content.message.html.includes("o&#39;brien&amp;company@example.test"));
  assert(!content.message.html.includes(recipient));
});

for (
  const [label, patch] of Object.entries({
    headerInjection: {
      recipient: "invitee@example.test\r\nBcc: other@example.test",
    },
    displayRecipient: { recipient: "Person <invitee@example.test>" },
    mixedCaseRecipient: { recipient: "Invitee@example.test" },
    whitespaceRecipient: { recipient: " invitee@example.test" },
    xssRecipient: { recipient: '"><script>alert(1)</script>@example.test' },
    oversizedRecipient: { recipient: "a".repeat(245) + "@example.test" },
    wrongDomain: { from: "Dominion <noreply@77dominion.com>" },
    suffixDomain: { from: "noreply@mail.77dominion.com.evil.test" },
    senderHeaderInjection: {
      from: "noreply@mail.77dominion.com\r\nBcc:other@example.test",
    },
    senderScript: { from: "<script> <noreply@mail.77dominion.com>" },
    senderWrongType: { from: null },
    senderHuge: { from: "a".repeat(5000) + "@mail.77dominion.com" },
    wrongUuid: { generationId: "22222222-2222-2222-2222-222222222222" },
    uppercaseUuid: { requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    missingMillis: { issuedAt: "2026-09-27T12:00:00Z" },
    offsetTimestamp: { issuedAt: "2026-09-27T12:00:00.000+00:00" },
    invalidDate: { issuedAt: "2026-02-30T12:00:00.000Z" },
    rolledDate: { issuedAt: "2026-09-27T24:00:00.000Z" },
    extraMillisecond: { expiresAt: "2026-10-04T12:00:00.001Z" },
    tooShort: { expiresAt: "2026-10-03T12:00:00.000Z" },
    backwards: { expiresAt: "2026-09-26T12:00:00.000Z" },
    extraProperty: { purpose: "native_auth_invitation" },
  })
) {
  Deno.test(`invitation binding rejects ${label}`, async () => {
    await invalid(() =>
      createEarlyAccessInvitation(
        { ...binding(), ...patch } as EarlyAccessInvitationBinding,
        key(),
      )
    );
  });
}

Deno.test("invitation seven-day lifetime is fixed across a calendar boundary", async () => {
  assertEquals(EARLY_ACCESS_INVITATION_LIFETIME_MS, 604800000);
  const input = {
    ...binding(),
    issuedAt: "2028-02-27T12:00:00.001Z",
    expiresAt: "2028-03-05T12:00:00.001Z",
  };
  const value = await createEarlyAccessInvitation(input, key());
  assert(
    await openEarlyAccessInvitation(
      value.envelope,
      input,
      key(),
      fingerprint(value),
    ),
  );
});

for (
  const [label, patch] of Object.entries({
    missing: { key: undefined },
    short: { key: new Uint8Array(31) },
    long: { key: new Uint8Array(33) },
    text: { key: "secret-token" },
    noVersion: { keyVersion: undefined },
    zeroVersion: { keyVersion: 0 },
    negativeVersion: { keyVersion: -1 },
    fractionVersion: { keyVersion: 1.5 },
    hugeVersion: { keyVersion: 2147483648 },
    textVersion: { keyVersion: "1" },
    extraProperty: { purpose: "integration" },
  })
) {
  Deno.test(`invitation key rejects ${label} without leaking input`, async () => {
    await invalid(() =>
      createEarlyAccessInvitation(
        binding(),
        { ...key(), ...patch } as EarlyAccessInvitationKey,
      )
    );
  });
}

Deno.test("invitation getters are rejected without executing them", async () => {
  let read = false;
  const input = { ...binding() };
  Object.defineProperty(input, "recipient", {
    get() {
      read = true;
      throw new Error("secret");
    },
  });
  await invalid(() => createEarlyAccessInvitation(input, key()));
  assertEquals(read, false);
});

Deno.test("invitation snapshots all input before its first asynchronous operation", async () => {
  const input = { ...binding() };
  const secret = key();
  const pending = createEarlyAccessInvitation(input, secret);
  input.recipient = "other@example.test";
  secret.key.fill(77);
  const value = await pending;
  const expected = fingerprint(value);
  const envelope = { ...value.envelope };
  const original = { ...binding() };
  const openSecret = key();
  const opened = openEarlyAccessInvitation(
    envelope,
    original,
    openSecret,
    expected,
  );
  original.recipient = "another@example.test";
  openSecret.key.fill(88);
  envelope.ciphertext = "broken";
  expected.tokenDigest = "a".repeat(64);
  assertEquals((await opened).message.to, binding().recipient);
});

Deno.test("invitation authenticated envelope rejects ciphertext, nonce and key tampering", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  for (
    const patch of [
      { ciphertext: tamper(value.envelope.ciphertext) },
      { nonce: tamper(value.envelope.nonce) },
      { version: 2 },
      { keyVersion: 2 },
    ]
  ) {
    await invalid(() =>
      openEarlyAccessInvitation(
        { ...value.envelope, ...patch } as EarlyAccessInvitationEnvelope,
        binding(),
        key(),
        fingerprint(value),
      )
    );
  }
  await invalid(() =>
    openEarlyAccessInvitation(
      value.envelope,
      binding(),
      { keyVersion: 1, key: new Uint8Array(32) },
      fingerprint(value),
    )
  );
});

Deno.test("invitation every immutable binding field is authenticated", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  const changedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (
    const patch of [
      { requestId: changedId },
      { generationId: changedId },
      { deliveryId: changedId },
      { recipient: "other@example.test" },
      { from: "Other <noreply@mail.77dominion.com>" },
      {
        issuedAt: "2026-09-27T12:00:00.001Z",
        expiresAt: "2026-10-04T12:00:00.001Z",
      },
    ]
  ) {
    const input = { ...binding(), ...patch };
    await invalid(() =>
      openEarlyAccessInvitation(value.envelope, input, key(), {
        ...fingerprint(value),
        idempotencyKey: `dominion-early-access/${input.deliveryId}`,
      })
    );
  }
});

Deno.test("invitation stored digest, fingerprint and idempotency cannot be replaced", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  for (
    const patch of [
      { tokenDigest: "a".repeat(64) },
      { contentFingerprint: "b".repeat(64) },
      { idempotencyKey: "arbitrary" },
      { tokenDigest: "bad" },
      { contentFingerprint: "A".repeat(64) },
      { extra: "secret" },
    ]
  ) {
    await invalid(() =>
      openEarlyAccessInvitation(
        value.envelope,
        binding(),
        key(),
        { ...fingerprint(value), ...patch },
      )
    );
  }
});

Deno.test("invitation malformed or oversized envelopes are rejected before opening", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  for (
    const patch of [
      { nonce: "A".repeat(15) },
      { nonce: "A".repeat(17) },
      { nonce: value.envelope.nonce + "=" },
      { nonce: [] },
      { ciphertext: "A".repeat(10945) },
      { ciphertext: "A".repeat(22) },
      { ciphertext: "" },
      { ciphertext: "+abc" },
      { ciphertext: value.envelope.ciphertext + "\n" },
      { extra: "secret" },
    ]
  ) {
    await invalid(() =>
      openEarlyAccessInvitation(
        { ...value.envelope, ...patch } as EarlyAccessInvitationEnvelope,
        binding(),
        key(),
        fingerprint(value),
      )
    );
  }
});

Deno.test("invitation dedicated AAD refuses ciphertext from another purpose", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  const payload = await decryptFixture(value);
  const envelope = await sealFixture(
    JSON.stringify(payload),
    fingerprint(value),
    "integration_credential",
  );
  await invalid(() =>
    openEarlyAccessInvitation(envelope, binding(), key(), fingerprint(value))
  );
});

Deno.test("invitation decrypted schema, token and message are revalidated", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  const payload = await decryptFixture(value);
  const message = payload.content.message;
  for (
    const changed of [
      { ...payload, version: 2 },
      { ...payload, purpose: "native_auth" },
      { ...payload, token: "A".repeat(43) },
      { ...payload, token: payload.token + "=" },
      { ...payload, token: null },
      { ...payload, extra: true },
      {
        ...payload,
        content: { ...payload.content, deliveryId: binding().requestId },
      },
      { ...payload, content: { ...payload.content, idempotencyKey: "other" } },
      ...Object.entries({
        from: "evil@mail.77dominion.com",
        to: "other@example.test",
        subject: "Changed",
        text: message.text + " ",
        html: message.html + " ",
        reply_to: "other@example.test",
      }).map(([field, item]) => ({
        ...payload,
        content: { ...payload.content, message: { ...message, [field]: item } },
      })),
    ]
  ) {
    const envelope = await sealFixture(
      JSON.stringify(changed),
      fingerprint(value),
    );
    await invalid(() =>
      openEarlyAccessInvitation(envelope, binding(), key(), fingerprint(value))
    );
  }
});

Deno.test("invitation validates fixed token URL even when a modified message has its own fingerprint", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  const payload = await decryptFixture(value);
  for (
    const replacement of [
      "https://evil.test/#token=",
      "http://77dominion.com/early-access-invite.html#token=",
      "https://77dominion.com/early-access-invite.html?token=",
    ]
  ) {
    const content = {
      ...payload.content,
      message: {
        ...payload.content.message,
        text: payload.content.message.text.replace(linkPrefix, replacement),
        html: payload.content.message.html.replace(linkPrefix, replacement),
      },
    };
    const expected = {
      ...fingerprint(value),
      contentFingerprint: await transactionalEmailFingerprint(content),
    };
    const envelope = await sealFixture(
      JSON.stringify({ ...payload, content }),
      expected,
    );
    await invalid(() =>
      openEarlyAccessInvitation(envelope, binding(), key(), expected)
    );
  }
});

Deno.test("invitation rejects invalid UTF8, malformed JSON and oversized authenticated plaintext", async () => {
  const value = await createEarlyAccessInvitation(binding(), key());
  for (
    const plaintext of [
      new Uint8Array([0xc3, 0x28]),
      "{",
      "null",
      "x".repeat(8193),
    ]
  ) {
    const envelope = await sealFixture(plaintext, fingerprint(value));
    await invalid(() =>
      openEarlyAccessInvitation(envelope, binding(), key(), fingerprint(value))
    );
  }
});

Deno.test("invitation key rotation opens only the envelope's exact key version", async () => {
  const secret = { keyVersion: 2147483647, key: key().key };
  const value = await createEarlyAccessInvitation(binding(), secret);
  assertEquals(value.envelope.keyVersion, secret.keyVersion);
  assert(
    await openEarlyAccessInvitation(
      value.envelope,
      binding(),
      secret,
      fingerprint(value),
    ),
  );
  await invalid(() =>
    openEarlyAccessInvitation(
      value.envelope,
      binding(),
      key(),
      fingerprint(value),
    )
  );
});
