import { assert, assertEquals } from "./test_helpers.ts";
import {
  bootstrapNewEarlyAccessAccount,
  EarlyAccessAuthBootstrapError,
  type EarlyAccessAuthBootstrapErrorCode,
  type EarlyAccessAuthBootstrapInput,
} from "./early_access_auth_bootstrap.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const email = "new.member@example.com";
const authOrigin = "https://project.supabase.co";
const redirectTo = "https://77dominion.com/reset-password.html";
const token = "a".repeat(56);
const secret = "provider-private-token-and-message";
const nowMs = Date.parse("2026-09-27T12:00:00.000Z");

function input(
  overrides: Partial<EarlyAccessAuthBootstrapInput> = {},
): EarlyAccessAuthBootstrapInput {
  return {
    reservedUserId: owner,
    canonicalEmail: email,
    redirectTo,
    allowedRedirects: [redirectTo],
    authOrigin,
    nowMs,
    ...overrides,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: owner,
    email,
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: false,
    is_sso_user: false,
    created_at: "2026-09-27T11:59:00.000Z",
    email_confirmed_at: null,
    confirmed_at: null,
    phone: "",
    identities: [{
      user_id: owner,
      provider: "email",
      identity_data: { email, sub: owner, email_verified: false },
    }],
    ...overrides,
  };
}

function actionLink(params: Record<string, string> = {}) {
  const url = new URL(`${authOrigin}/auth/v1/verify`);
  url.search = new URLSearchParams({
    token,
    type: "recovery",
    redirect_to: redirectTo,
    ...params,
  }).toString();
  return url.href;
}

function generated(
  properties: Record<string, unknown> = {},
  generatedUser: unknown = user(),
) {
  return {
    data: {
      user: generatedUser,
      properties: {
        action_link: actionLink(),
        hashed_token: token,
        email_otp: "123456",
        verification_type: "recovery",
        redirect_to: redirectTo,
        ...properties,
      },
    },
    error: null,
  };
}

type Answers = {
  create?: unknown;
  find?: unknown;
  generate?: unknown;
  throwCreate?: boolean;
  throwFind?: boolean;
  throwGenerate?: boolean;
};

function harness(answers: Answers = {}) {
  const calls: { method: string; argument: unknown }[] = [];
  return {
    calls,
    dependencies: {
      createUser: async (attributes: unknown) => {
        calls.push({ method: "createUser", argument: attributes });
        if (answers.throwCreate) throw new Error(secret);
        return Object.hasOwn(answers, "create")
          ? answers.create
          : { data: { user: user() }, error: null };
      },
      getUserById: async (userId: string) => {
        calls.push({ method: "getUserById", argument: userId });
        if (answers.throwFind) throw new Error(secret);
        return Object.hasOwn(answers, "find")
          ? answers.find
          : { data: { user: user() }, error: null };
      },
      generateLink: async (parameters: unknown) => {
        calls.push({ method: "generateLink", argument: parameters });
        if (answers.throwGenerate) throw new Error(secret);
        return Object.hasOwn(answers, "generate")
          ? answers.generate
          : generated();
      },
    },
  };
}

async function rejects(
  value: EarlyAccessAuthBootstrapInput,
  fixture: ReturnType<typeof harness>,
  expected: EarlyAccessAuthBootstrapErrorCode,
) {
  let caught: unknown;
  try {
    await bootstrapNewEarlyAccessAccount(value, fixture.dependencies);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof EarlyAccessAuthBootstrapError);
  assertEquals(caught.code, expected);
  assertEquals(caught.message, "Early-access account setup is unavailable.");
  assertEquals(caught.cause, undefined);
  for (const privateValue of [owner, email, token, secret, authOrigin]) {
    assert(!JSON.stringify(caught).includes(privateValue));
    assert(!caught.message.includes(privateValue));
  }
}

Deno.test("new bootstrap creates exact reserved owner without password or confirmation", async () => {
  const fixture = harness();
  const result = await bootstrapNewEarlyAccessAccount(
    input(),
    fixture.dependencies,
  );
  assertEquals(fixture.calls, [{
    method: "createUser",
    argument: { id: owner, email, email_confirm: false },
  }, {
    method: "generateLink",
    argument: { type: "recovery", email, options: { redirectTo } },
  }]);
  assertEquals(result, {
    userId: owner,
    recipient: email,
    recoveryActionLink: actionLink(),
  });
  assert(Object.isFrozen(result));
  assertEquals(Object.keys(result), [
    "userId",
    "recipient",
    "recoveryActionLink",
  ]);
});

for (
  const [name, answers] of Object.entries({
    "transport uncertainty": { throwCreate: true },
    "duplicate create": {
      create: { data: { user: null }, error: { code: "email_exists", secret } },
    },
    "malformed create envelope": { create: null },
  })
) {
  Deno.test(`bootstrap reconciles ${name} only by durable reserved UUID`, async () => {
    const fixture = harness(answers);
    const result = await bootstrapNewEarlyAccessAccount(
      input(),
      fixture.dependencies,
    );
    assertEquals(result.userId, owner);
    assertEquals(fixture.calls.map((call) => call.method), [
      "createUser",
      "getUserById",
      "generateLink",
    ]);
    assertEquals(fixture.calls[1].argument, owner);
  });
}

Deno.test("foreign preexisting unconfirmed mailbox is never adopted after duplicate create", async () => {
  const fixture = harness({
    create: { data: { user: null }, error: { code: "email_exists", secret } },
    find: { data: { user: null }, error: null },
  });
  await rejects(input(), fixture, "account_conflict");
  assertEquals(fixture.calls.map((call) => call.method), [
    "createUser",
    "getUserById",
  ]);
});

for (
  const [name, replacement, code] of [
    ["owner", { id: otherOwner }, "account_changed"],
    ["mailbox", { email: "other@example.com" }, "account_changed"],
    [
      "confirmed",
      { email_confirmed_at: "2026-09-27T11:00:00Z" },
      "account_conflict",
    ],
    [
      "confirmed alias",
      { confirmed_at: "2026-09-27T11:00:00Z" },
      "account_conflict",
    ],
    ["anonymous", { is_anonymous: true }, "account_conflict"],
    ["unknown anonymity", { is_anonymous: undefined }, "account_conflict"],
    ["deleted", { deleted_at: "2026-09-27T11:00:00Z" }, "account_conflict"],
    ["banned", { banned_until: "2026-09-28T11:00:00Z" }, "account_conflict"],
    ["malformed ban", { banned_until: "not-a-date" }, "account_conflict"],
    [
      "prior session",
      { last_sign_in_at: "2026-09-27T11:00:00Z" },
      "account_conflict",
    ],
    ["pending mailbox", { new_email: "other@example.com" }, "account_conflict"],
    ["MFA", { factors: [{ status: "verified" }] }, "account_conflict"],
    ["missing identity", { identities: [] }, "account_conflict"],
    ["foreign identity", {
      identities: [{
        provider: "email",
        user_id: otherOwner,
        identity_data: { email },
      }],
    }, "account_conflict"],
    ["foreign identity mailbox", {
      identities: [{
        provider: "email",
        user_id: owner,
        identity_data: { email: "other@example.com" },
      }],
    }, "account_conflict"],
  ] as const
) {
  Deno.test(`bootstrap rejects ${name} at create, reconcile and generation boundaries`, async () => {
    const changed = user(replacement);
    const create = harness({
      create: { data: { user: changed }, error: null },
    });
    await rejects(input(), create, code);
    assertEquals(create.calls.length, 1);
    const reconcile = harness({
      throwCreate: true,
      find: { data: { user: changed }, error: null },
    });
    await rejects(input(), reconcile, code);
    assertEquals(reconcile.calls.length, 2);
    const generate = harness({ generate: generated({}, changed) });
    await rejects(input(), generate, code);
    assertEquals(generate.calls.map((call) => call.method), [
      "createUser",
      "generateLink",
    ]);
  });
}

for (
  const [name, answers, code] of [
    [
      "by-ID transport error",
      { throwCreate: true, throwFind: true },
      "account_unavailable",
    ],
    ["by-ID provider error", {
      throwCreate: true,
      find: { data: null, error: { secret } },
    }, "account_unavailable"],
    [
      "generation transport error",
      { throwGenerate: true },
      "recovery_link_unavailable",
    ],
    ["generation provider error", {
      generate: { data: null, error: { secret } },
    }, "recovery_link_unavailable"],
  ] as const
) {
  Deno.test(`bootstrap sanitizes ${name} without retrying or leaking provider material`, async () => {
    const fixture = harness(answers);
    await rejects(input(), fixture, code);
    assertEquals(fixture.calls.length, 2);
  });
}

for (
  const [name, overrides] of [
    ["bad UUID", { reservedUserId: "caller-selected" }],
    ["coerced UUID", {
      reservedUserId: { toString: () => owner } as unknown as string,
    }],
    ["uncanonical mailbox", { canonicalEmail: "New.Member@example.com" }],
    ["mailbox whitespace", { canonicalEmail: ` ${email}` }],
    ["caller redirect", {
      redirectTo: "https://attacker.example/reset-password.html",
    }],
    ["wildcard redirect", { allowedRedirects: ["https://77dominion.com/**"] }],
    ["token redirect", {
      allowedRedirects: [`${redirectTo}?token=secret`],
      redirectTo: `${redirectTo}?token=secret`,
    }],
    ["fragment redirect", {
      allowedRedirects: [`${redirectTo}#token=secret`],
      redirectTo: `${redirectTo}#token=secret`,
    }],
    ["insecure redirect", {
      allowedRedirects: [redirectTo.replace("https:", "http:")],
      redirectTo: redirectTo.replace("https:", "http:"),
    }],
    ["no redirect allowlist", { allowedRedirects: [] }],
    ["Auth path", { authOrigin: `${authOrigin}/auth/v1` }],
    ["Auth credentials", {
      authOrigin: "https://password@project.supabase.co",
    }],
    ["Auth trailing slash", { authOrigin: `${authOrigin}/` }],
    ["invalid clock", { nowMs: NaN }],
  ] as const
) {
  Deno.test(`bootstrap rejects ${name} before any provider call`, async () => {
    const fixture = harness();
    await rejects(input(overrides), fixture, "configuration_invalid");
    assertEquals(fixture.calls, []);
  });
}

for (
  const [name, properties] of [
    ["foreign origin", {
      action_link: actionLink().replace(authOrigin, "https://attacker.example"),
    }],
    ["foreign path", {
      action_link: actionLink().replace(
        "/auth/v1/verify",
        "/auth/v1/authorize",
      ),
    }],
    ["userinfo", {
      action_link: actionLink().replace("https://", "https://secret@"),
    }],
    ["empty userinfo", {
      action_link: actionLink().replace("https://", "https://@"),
    }],
    ["fragment", { action_link: `${actionLink()}#access_token=secret` }],
    ["empty fragment", { action_link: `${actionLink()}#` }],
    ["unexpected query", { action_link: `${actionLink()}&code=secret` }],
    ["duplicate query", { action_link: `${actionLink()}&type=recovery` }],
    ["type", { action_link: actionLink({ type: "invite" }) }],
    ["redirect", {
      action_link: actionLink({
        redirect_to: "https://attacker.example/reset-password.html",
      }),
    }],
    ["token mismatch", { action_link: actionLink({ token: "b".repeat(56) }) }],
    ["missing token", { hashed_token: "" }],
    ["properties type", { verification_type: "invite" }],
    ["properties redirect", {
      redirect_to: "https://attacker.example/reset-password.html",
    }],
    ["control characters", { action_link: `${actionLink()}\n` }],
  ] as const
) {
  Deno.test(`bootstrap rejects native link ${name}`, async () => {
    await rejects(
      input(),
      harness({ generate: generated(properties) }),
      "recovery_link_invalid",
    );
  });
}

Deno.test("bootstrap snapshots its binding before asynchronous provider work", async () => {
  const binding = { ...input() };
  const fixture = harness();
  const original = fixture.dependencies.createUser;
  fixture.dependencies.createUser = async (attributes) => {
    binding.canonicalEmail = "changed@example.com";
    binding.redirectTo = "https://attacker.example/reset-password.html";
    binding.reservedUserId = otherOwner;
    return await original(attributes);
  };
  const result = await bootstrapNewEarlyAccessAccount(
    binding,
    fixture.dependencies,
  );
  assertEquals(result.recipient, email);
  assertEquals(result.userId, owner);
  assertEquals(fixture.calls[1].argument, {
    type: "recovery",
    email,
    options: { redirectTo },
  });
});

Deno.test("bootstrap accepts provider casing and an expired ban only for the same new owner", async () => {
  const sameOwner = user({
    email: "New.Member@Example.com",
    banned_until: "2026-09-26T12:00:00.000Z",
    factors: [],
  });
  const result = await bootstrapNewEarlyAccessAccount(
    input(),
    harness({
      create: { data: { user: sameOwner }, error: null },
      generate: generated({}, sameOwner),
    }).dependencies,
  );
  assertEquals(result.recipient, email);
});
