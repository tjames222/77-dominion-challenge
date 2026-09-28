import { assert, assertEquals } from "./test_helpers.ts";
import {
  createEarlyAccessInvitation,
  type EarlyAccessInvitationEnvelope,
} from "./early_access_invitation.ts";
import {
  createEarlyAccessRecoveryMail,
  EARLY_ACCESS_AUTH_ORIGIN,
  EARLY_ACCESS_AUTH_REDIRECT,
  type EarlyAccessRecoveryBinding,
  openEarlyAccessRecoveryMail,
} from "./early_access_recovery_mail.ts";

const binding: EarlyAccessRecoveryBinding = Object.freeze({
  requestId: "10000000-0000-4000-8000-000000000001",
  generationId: "10000000-0000-4000-8000-000000000002",
  deliveryId: "10000000-0000-4000-8000-000000000003",
  reservedUserId: "10000000-0000-4000-8000-000000000004",
  recipient: "new@example.com",
  issuedAt: "2026-09-27T12:00:00.000Z",
  expiresAt: "2026-09-27T12:59:30.000Z",
  from: "Dominion <noreply@mail.77dominion.com>",
});
const key = { keyVersion: 1, key: new Uint8Array(32).fill(12) };
const link = `${EARLY_ACCESS_AUTH_ORIGIN}/auth/v1/verify?token=${
  "a".repeat(64)
}&type=recovery&redirect_to=${encodeURIComponent(EARLY_ACCESS_AUTH_REDIRECT)}`;
const expected = (
  sealed: { contentFingerprint: string; idempotencyKey: string },
) => ({
  contentFingerprint: sealed.contentFingerprint,
  idempotencyKey: sealed.idempotencyKey,
});
async function safeFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof TypeError);
    assertEquals(error.message, "Invalid early-access account setup mail.");
    return;
  }
  throw new Error("Expected safe setup-mail rejection.");
}

Deno.test("native recovery renders once, seals credential, and opens identical immutable mail", async () => {
  const sealed = await createEarlyAccessRecoveryMail(binding, link, key);
  assertEquals(Object.keys(sealed).sort(), [
    "contentFingerprint",
    "envelope",
    "idempotencyKey",
  ]);
  assert(!JSON.stringify(sealed).includes("a".repeat(64)));
  assert(!JSON.stringify(sealed).includes(binding.recipient));
  const first = await openEarlyAccessRecoveryMail(
    sealed.envelope,
    binding,
    key,
    expected(sealed),
  );
  const second = await openEarlyAccessRecoveryMail(
    sealed.envelope,
    binding,
    key,
    expected(sealed),
  );
  assertEquals(first, second);
  assertEquals(first.message.to, binding.recipient);
  assertEquals(
    first.idempotencyKey,
    `dominion-early-access-setup/${binding.deliveryId}`,
  );
  assert(first.message.text.includes(link));
  assert(first.message.html.includes("&amp;type=recovery"));
  assert(
    Object.isFrozen(first) && Object.isFrozen(first.message) &&
      Object.isFrozen(sealed),
  );
});
Deno.test("random nonces produce distinct ciphertext while content identity remains stable", async () => {
  const a = await createEarlyAccessRecoveryMail(binding, link, key);
  const b = await createEarlyAccessRecoveryMail(binding, link, key);
  assert(
    a.envelope.nonce !== b.envelope.nonce &&
      a.envelope.ciphertext !== b.envelope.ciphertext,
  );
  assertEquals(a.contentFingerprint, b.contentFingerprint);
});
for (
  const [field, value] of Object.entries({
    requestId: "20000000-0000-4000-8000-000000000001",
    generationId: "20000000-0000-4000-8000-000000000002",
    deliveryId: "20000000-0000-4000-8000-000000000003",
    reservedUserId: "20000000-0000-4000-8000-000000000004",
    recipient: "other@example.com",
    issuedAt: "2026-09-27T12:00:01.000Z",
    expiresAt: "2026-09-27T12:59:00.000Z",
    from: "Other <noreply@mail.77dominion.com>",
  })
) {
  Deno.test(`recovery AAD rejects changed ${field}`, async () => {
    const sealed = await createEarlyAccessRecoveryMail(binding, link, key);
    await safeFailure(() =>
      openEarlyAccessRecoveryMail(
        sealed.envelope,
        { ...binding, [field]: value },
        key,
        expected(sealed),
      )
    );
  });
}
for (
  const invalid of [
    link.replace(EARLY_ACCESS_AUTH_ORIGIN, "https://other.supabase.co"),
    link.replace("https:", "http:"),
    link.replace("type=recovery", "type=invite"),
    link.replace(
      encodeURIComponent(EARLY_ACCESS_AUTH_REDIRECT),
      encodeURIComponent("https://attacker.example/reset-password.html"),
    ),
    link + "&other=x",
    link + "&type=recovery",
    link + "#fragment",
    link + "\n",
    link.replace("/auth/v1/verify", "/verify"),
    link.replace("https://", "https://user@"),
    link.replace("a".repeat(64), "short"),
    link.replace("redirect_to=", "redirect="),
  ]
) {
  Deno.test(`recovery rejects native link variant ${invalid.indexOf("other") >= 0 ? "foreign" : invalid.length}`, async () => {
    await safeFailure(() =>
      createEarlyAccessRecoveryMail(binding, invalid, key)
    );
  });
}
for (
  const change of [
    { expiresAt: binding.issuedAt },
    { expiresAt: "2026-09-27T13:00:00.001Z" },
    { issuedAt: "2026-02-30T12:00:00.000Z" },
    { reservedUserId: "not-a-uuid" },
    { recipient: "New@example.com" },
    { from: "noreply@77dominion.com" },
    { extra: true },
  ]
) {
  Deno.test(`recovery rejects invalid binding ${JSON.stringify(change)}`, async () => {
    await safeFailure(() =>
      createEarlyAccessRecoveryMail({ ...binding, ...change }, link, key)
    );
  });
}
Deno.test("recovery rejects malformed keys, encodings, fingerprints and purpose substitution", async () => {
  const sealed = await createEarlyAccessRecoveryMail(binding, link, key);
  for (
    const invalidKey of [{ ...key, keyVersion: 2 }, {
      ...key,
      key: new Uint8Array(32).fill(13),
    }, { ...key, key: new Uint8Array(31) }]
  ) {
    await safeFailure(() =>
      openEarlyAccessRecoveryMail(
        sealed.envelope,
        binding,
        invalidKey,
        expected(sealed),
      )
    );
  }
  for (
    const patch of [
      { nonce: sealed.envelope.nonce + "=" },
      { ciphertext: "a" },
      { version: 2 },
      { keyVersion: 2 },
      { extra: 1 },
    ]
  ) {
    await safeFailure(() =>
      openEarlyAccessRecoveryMail(
        { ...sealed.envelope, ...patch } as EarlyAccessInvitationEnvelope,
        binding,
        key,
        expected(sealed),
      )
    );
  }
  await safeFailure(() =>
    openEarlyAccessRecoveryMail(sealed.envelope, binding, key, {
      ...expected(sealed),
      contentFingerprint: "f".repeat(64),
    })
  );
  await safeFailure(() =>
    openEarlyAccessRecoveryMail(sealed.envelope, binding, key, {
      ...expected(sealed),
      idempotencyKey: `dominion-early-access/${binding.deliveryId}`,
    })
  );
  const { reservedUserId: _unused, ...appBinding } = binding;
  const app = await createEarlyAccessInvitation({
    ...appBinding,
    expiresAt: "2026-10-04T12:00:00.000Z",
  }, key);
  await safeFailure(() =>
    openEarlyAccessRecoveryMail(app.envelope, binding, key, expected(sealed))
  );
});
Deno.test("recovery snapshots input and rejects getters without evaluating them", async () => {
  const mutable = { ...binding };
  const pending = createEarlyAccessRecoveryMail(mutable, link, key);
  mutable.recipient = "other@example.com";
  const sealed = await pending;
  assertEquals(
    (await openEarlyAccessRecoveryMail(
      sealed.envelope,
      binding,
      key,
      expected(sealed),
    )).message.to,
    binding.recipient,
  );
  let reads = 0;
  const malicious = { ...binding };
  Object.defineProperty(malicious, "recipient", {
    enumerable: true,
    get() {
      reads++;
      throw new Error(link);
    },
  });
  await safeFailure(() => createEarlyAccessRecoveryMail(malicious, link, key));
  assertEquals(reads, 0);
});
