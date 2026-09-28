import { assert, assertEquals } from "./test_helpers.ts";
import {
  type AccountSetupWorkerDependencies,
  processEarlyAccessBootstrap,
  processEarlyAccessSetupMail,
} from "./early_access_account_setup_worker.ts";
import {
  EARLY_ACCESS_AUTH_ORIGIN,
  EARLY_ACCESS_AUTH_REDIRECT,
} from "./early_access_recovery_mail.ts";

type Value = Record<string, unknown>;
const worker = "10000000-0000-4000-8000-000000000001";
const reservedUserId = "10000000-0000-4000-8000-000000000002";
const generationId = "10000000-0000-4000-8000-000000000003";
const requestId = "10000000-0000-4000-8000-000000000004";
const deliveryId = "10000000-0000-4000-8000-000000000005";
const receiptId = "10000000-0000-4000-8000-000000000006";
const recipient = "new@example.com";
const token = "a".repeat(64);
const link =
  `${EARLY_ACCESS_AUTH_ORIGIN}/auth/v1/verify?token=${token}&type=recovery&redirect_to=${
    encodeURIComponent(EARLY_ACCESS_AUTH_REDIRECT)
  }`;
const settings = {
  apiKey: "re_fixture",
  sender: "Dominion <noreply@mail.77dominion.com>",
  invitationKey: { keyVersion: 1, key: new Uint8Array(32).fill(3) },
};
const signal = () => new AbortController().signal;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fixture() {
  const state = {
    now: Date.parse("2026-09-27T12:00:00.000Z"),
    order: [] as string[],
    native: [] as { name: string; args: unknown }[],
    rpcCalls: [] as { name: string; args: Value }[],
    sends: [] as { url: string; body: string; key: string | null }[],
    mail: null as Value | null,
    bootstrap: [{
      requestId,
      generationId,
      reservedUserId,
      deliveryId,
      recipient,
      invitationExpiresAt: "2026-10-04T12:00:00.000Z",
    }] as unknown,
    start: true as unknown,
    persist: true as unknown,
    fence: true,
    started: false,
    rpcHook: null as
      | null
      | ((name: string, args: Value) => unknown | Promise<unknown>),
    authHook: null as
      | null
      | ((
        name: string,
        args: unknown,
        signal: AbortSignal,
      ) => unknown | Promise<unknown>),
    fetchHook: null as null | (() => Response | Promise<Response>),
  };
  const user = {
    id: reservedUserId,
    email: recipient,
    is_anonymous: false,
    role: "authenticated",
    aud: "authenticated",
    email_confirmed_at: null,
    confirmed_at: null,
    identities: [{
      user_id: reservedUserId,
      provider: "email",
      identity_data: { email: recipient },
    }],
  };
  const normalRpc = (name: string, args: Value): unknown => {
    if (name === "claim_early_access_account_bootstraps") {
      return state.started ? [] : copy(state.bootstrap);
    }
    if (name === "start_early_access_account_bootstrap") {
      state.started = true;
      return state.start;
    }
    if (name === "persist_early_access_account_setup") {
      if (state.persist === true) {
        state.mail = {
          deliveryId,
          binding: copy(args.target_binding),
          envelope: copy(args.target_envelope),
          contentFingerprint: args.target_content_fingerprint,
          idempotencyKey: args.target_idempotency_key,
          firstDispatchedAt: null,
        };
      }
      return state.persist;
    }
    if (
      name === "settle_early_access_account_bootstrap" ||
      name === "settle_early_access_account_setup_delivery"
    ) return true;
    if (name === "claim_early_access_account_setup_deliveries") {
      return state.mail ? [copy(state.mail)] : [];
    }
    if (name === "mark_early_access_account_setup_dispatched") {
      if (!state.fence) return null;
      assert(state.mail);
      state.mail.firstDispatchedAt ||= new Date(state.now).toISOString();
      return {
        deliveryId,
        idempotencyKey: state.mail.idempotencyKey,
        bindingFingerprint: state.mail.contentFingerprint,
        firstDispatchedAt: state.mail.firstDispatchedAt,
      };
    }
    throw new Error("Unexpected RPC");
  };
  const native = async (
    name: string,
    args: unknown,
    abortSignal: AbortSignal,
  ) => {
    assert(!abortSignal.aborted);
    state.order.push(name);
    state.native.push({ name, args: copy(args) });
    if (state.authHook) return await state.authHook(name, args, abortSignal);
    return name === "generateLink"
      ? {
        data: {
          user,
          properties: {
            action_link: link,
            hashed_token: token,
            verification_type: "recovery",
            redirect_to: EARLY_ACCESS_AUTH_REDIRECT,
          },
        },
        error: null,
      }
      : { data: { user }, error: null };
  };
  const deps: AccountSetupWorkerDependencies = {
    now: () => state.now,
    authTimeoutMs: 5,
    emailTimeoutMs: 5,
    rpc: async (name, args, abortSignal) => {
      assert(!abortSignal.aborted);
      assertEquals(args.target_worker_token, worker);
      state.order.push(name);
      state.rpcCalls.push({ name, args: copy(args) });
      return state.rpcHook
        ? await state.rpcHook(name, args)
        : normalRpc(name, args);
    },
    auth: (abortSignal) => ({
      createUser: (args) => native("createUser", args, abortSignal),
      getUserById: (args) => native("getUserById", args, abortSignal),
      generateLink: (args) => native("generateLink", args, abortSignal),
    }),
    fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
      assert(state.mail?.firstDispatchedAt);
      state.order.push("emailPOST");
      state.sends.push({
        url: String(url),
        body: String(init?.body),
        key: new Headers(init?.headers).get("Idempotency-Key"),
      });
      return state.fetchHook
        ? await state.fetchHook()
        : new Response(JSON.stringify({ id: receiptId }));
    }) as typeof fetch,
  };
  const bootstrap = () =>
    processEarlyAccessBootstrap(worker, settings, deps, signal());
  const mail = () =>
    processEarlyAccessSetupMail(worker, settings, deps, signal());
  return { state, deps, bootstrap, mail, normalRpc, user };
}
Deno.test("bootstrap durably starts once, creates only reserved UUID, seals before mail dispatch", async () => {
  const f = fixture();
  assertEquals(await f.bootstrap(), "prepared");
  assertEquals(f.state.order, [
    "claim_early_access_account_bootstraps",
    "start_early_access_account_bootstrap",
    "createUser",
    "generateLink",
    "persist_early_access_account_setup",
  ]);
  assertEquals(f.state.native[0].args, {
    id: reservedUserId,
    email: recipient,
    email_confirm: false,
  });
  assert(!JSON.stringify(f.state.rpcCalls).includes(token));
  assertEquals(
    (f.state.mail?.binding as Value).expiresAt,
    "2026-09-27T12:59:30.000Z",
  );
  assertEquals(await f.bootstrap(), "empty");
  assertEquals(f.state.native.length, 2);
  assertEquals(await f.mail(), "accepted");
  assertEquals(f.state.sends.length, 1);
  assertEquals(f.state.sends[0].url, "https://api.resend.com/emails");
  assertEquals(
    f.state.sends[0].key,
    `dominion-early-access-setup/${deliveryId}`,
  );
  assert(
    f.state.order.indexOf("mark_early_access_account_setup_dispatched") <
      f.state.order.indexOf("emailPOST"),
  );
  assertEquals(f.state.rpcCalls.at(-1)?.args.target_receipt_id, receiptId);
});
Deno.test("empty bootstrap and setup queues make no native call or email", async () => {
  const f = fixture();
  f.state.bootstrap = [];
  assertEquals(await f.bootstrap(), "empty");
  assertEquals(await f.mail(), "empty");
  assertEquals(f.state.native, []);
  assertEquals(f.state.sends, []);
});
for (const started of [false, null, "true"]) {
  Deno.test(`bootstrap start ${started} cannot create account`, async () => {
    const f = fixture();
    f.state.start = started;
    assertEquals(
      await f.bootstrap(),
      started === false ? "lease_lost" : "needs_review",
    );
    assertEquals(f.state.native, []);
    assertEquals(f.state.mail, null);
  });
}
Deno.test("duplicate mailbox cannot be adopted and uncertain native call is never reentered", async () => {
  const f = fixture();
  f.state.authHook = () => ({ data: { user: null }, error: { message: link } });
  assertEquals(await f.bootstrap(), "needs_review");
  assertEquals(f.state.native.map((c) => c.name), [
    "createUser",
    "getUserById",
  ]);
  assertEquals(f.state.native[1].args, reservedUserId);
  assertEquals(await f.bootstrap(), "empty");
  assertEquals(
    f.state.rpcCalls.at(-2)?.args.target_code,
    "bootstrap_unavailable",
  );
  assertEquals(f.state.mail, null);
});
Deno.test("lost generateLink result is terminal with no plaintext persistence or send", async () => {
  const f = fixture();
  f.state.authHook = (name) =>
    name === "createUser"
      ? { data: { user: f.user }, error: null }
      : Promise.reject(new Error(link));
  assertEquals(await f.bootstrap(), "needs_review");
  assertEquals(f.state.native.map((c) => c.name), [
    "createUser",
    "generateLink",
  ]);
  assertEquals(f.state.mail, null);
  assertEquals(f.state.sends, []);
  assertEquals(await f.bootstrap(), "empty");
});
Deno.test("stalled native request is aborted, bounded and cannot generate after completion", async () => {
  const f = fixture();
  const signals: AbortSignal[] = [];
  f.state.authHook = (_name, _args, abortSignal) => {
    signals.push(abortSignal);
    return new Promise(() => {});
  };
  assertEquals(await f.bootstrap(), "needs_review");
  assertEquals(signals.length, 2);
  assert(signals.every((s) => s.aborted));
  assertEquals(f.state.mail, null);
});

Deno.test("late successful create after timeout cannot generate a native link", async () => {
  const f = fixture();
  let finishCreate: (value: unknown) => void = () => {};
  f.state.authHook = (name) =>
    name === "createUser"
      ? new Promise((resolve) => {
        finishCreate = resolve;
      })
      : { data: { user: null }, error: null };
  assertEquals(await f.bootstrap(), "needs_review");
  finishCreate({ data: { user: f.user }, error: null });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(f.state.native.map((call) => call.name), [
    "createUser",
    "getUserById",
  ]);
  assertEquals(f.state.mail, null);
  assertEquals(f.state.sends, []);
});
for (const persisted of [false, null]) {
  Deno.test(`persistence ${persisted} never exposes or sends native material`, async () => {
    const f = fixture();
    f.state.persist = persisted;
    assertEquals(
      await f.bootstrap(),
      persisted === false ? "lease_lost" : "needs_review",
    );
    assertEquals(await f.mail(), "empty");
    assertEquals(f.state.sends, []);
  });
}
Deno.test("setup expiration is conservative from before native call and capped at invitation expiry", async () => {
  const f = fixture();
  (f.state.bootstrap as Value[])[0].invitationExpiresAt =
    "2026-09-27T12:10:00.000Z";
  assertEquals(await f.bootstrap(), "prepared");
  assertEquals(
    (f.state.mail?.binding as Value).expiresAt,
    "2026-09-27T12:10:00.000Z",
  );
  f.state.now += 10 * 60 * 1000;
  assertEquals(await f.mail(), "needs_review");
  assertEquals(f.state.sends, []);
});
Deno.test("setup delivery expiry, altered ciphertext and sender drift never reach dispatch", async () => {
  for (const kind of ["expiry", "ciphertext", "sender"]) {
    const f = fixture();
    await f.bootstrap();
    assert(f.state.mail);
    if (kind === "expiry") f.state.now += 3600000;
    if (kind === "ciphertext") {
      (f.state.mail.envelope as Value).ciphertext = "tampered";
    }
    if (kind === "sender") {
      (f.state.mail.binding as Value).from =
        "Other <other@mail.77dominion.com>";
    }
    assertEquals(await f.mail(), "needs_review");
    assert(
      !f.state.order.includes("mark_early_access_account_setup_dispatched"),
    );
    assertEquals(f.state.sends, []);
  }
});
Deno.test("revoked/expired/lease/quota dispatch denial never posts setup email", async () => {
  const f = fixture();
  await f.bootstrap();
  f.state.fence = false;
  assertEquals(await f.mail(), "retryable");
  assertEquals(f.state.sends, []);
});
Deno.test("unknown setup email retries frozen bytes/key only, without regenerating Auth credentials", async () => {
  const f = fixture();
  await f.bootstrap();
  f.state.fetchHook = () => Promise.reject(new Error(link));
  assertEquals(await f.mail(), "uncertain");
  const timestamp = f.state.mail?.firstDispatchedAt;
  f.state.fetchHook = null;
  f.state.now += 60000;
  assertEquals(await f.mail(), "accepted");
  assertEquals(f.state.sends[0], f.state.sends[1]);
  assertEquals(f.state.mail?.firstDispatchedAt, timestamp);
  assertEquals(f.state.native.map((c) => c.name), [
    "createUser",
    "generateLink",
  ]);
});
Deno.test("unknown dispatch fence prevents POST and records uncertainty", async () => {
  const f = fixture();
  await f.bootstrap();
  f.state.rpcHook = (name, args) =>
    name === "mark_early_access_account_setup_dispatched"
      ? Promise.reject(new Error(link))
      : f.normalRpc(name, args);
  assertEquals(await f.mail(), "uncertain");
  assertEquals(f.state.sends, []);
});
Deno.test("lost setup settlement cannot report provider completion", async () => {
  const f = fixture();
  await f.bootstrap();
  f.state.rpcHook = (name, args) =>
    name === "settle_early_access_account_setup_delivery"
      ? Promise.reject(new Error("fixed"))
      : f.normalRpc(name, args);
  let rejected = false;
  try {
    await f.mail();
  } catch {
    rejected = true;
  }
  assert(rejected);
  assertEquals(f.state.sends.length, 1);
});
