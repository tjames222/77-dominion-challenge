import { assert, assertEquals } from "./test_helpers.ts";
import {
  deliverTransactionalEmail,
  TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS,
  type TransactionalEmailContent,
  type TransactionalEmailDispatchBinding,
  transactionalEmailFingerprint,
  type TransactionalEmailJob,
  type TransactionalEmailOptions,
} from "./transactional_email.ts";

const deliveryId = "11111111-1111-4111-8111-111111111111";
const emailId = "22222222-2222-4222-8222-222222222222";
const first = "2026-09-21T12:00:00.000Z";
const clock = Date.parse(first);
function content(): TransactionalEmailContent {
  return {
    deliveryId,
    idempotencyKey: `dominion-email/${deliveryId}`,
    message: {
      from: "Dominion <support@example.test>",
      to: "reporter@example.test",
      subject: "Your early-access invitation",
      text: "  Rendered text\nwith original spacing.  ",
      html: "<p>Rendered &amp; escaped message.</p>",
    },
  };
}
async function job(patch: Partial<TransactionalEmailJob> = {}) {
  const value = { ...content(), ...patch };
  return {
    ...value,
    bindingFingerprint: await transactionalEmailFingerprint(value),
    firstDispatchedAt: null,
    ...patch,
  } as TransactionalEmailJob;
}
function receipt(binding: TransactionalEmailDispatchBinding) {
  return { ...binding, firstDispatchedAt: binding.firstDispatchedAt || first };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function options(patch: Partial<TransactionalEmailOptions> = {}) {
  return {
    apiKey: "re_fixture_only",
    now: () => clock,
    markDispatched: async (binding: TransactionalEmailDispatchBinding) =>
      receipt(binding),
    fetcher: (() => Promise.resolve(json({ id: emailId }))) as typeof fetch,
    ...patch,
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
  assertEquals(caught.message, "Invalid transactional email configuration.");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

Deno.test("email dispatch is fenced and bound before its only fixed-endpoint POST", async () => {
  const value = await job();
  const order: string[] = [];
  const result = await deliverTransactionalEmail(
    value,
    options({
      markDispatched: async (binding, signal) => {
        order.push("fence");
        assert(Object.isFrozen(binding));
        assert(!signal.aborted);
        assertEquals(binding, {
          deliveryId,
          idempotencyKey: value.idempotencyKey,
          bindingFingerprint: value.bindingFingerprint,
          firstDispatchedAt: null,
        });
        return receipt(binding);
      },
      fetcher: ((url: RequestInfo | URL, init?: RequestInit) => {
        order.push("post");
        assertEquals(url, "https://api.resend.com/emails");
        assertEquals(init?.method, "POST");
        assertEquals(init?.redirect, "error");
        assertEquals(
          new Headers(init?.headers).get("Authorization"),
          "Bearer re_fixture_only",
        );
        assertEquals(
          new Headers(init?.headers).get("Idempotency-Key"),
          value.idempotencyKey,
        );
        assertEquals(JSON.parse(String(init?.body)), value.message);
        return Promise.resolve(json({ id: emailId }));
      }) as typeof fetch,
    }),
  );
  assertEquals(order, ["fence", "post"]);
  assertEquals(result, { state: "accepted", emailId });
});

Deno.test("fingerprint binds every immutable field and preserves rendered whitespace", async () => {
  const base = content();
  const hash = await transactionalEmailFingerprint(base);
  assert(/^[a-f0-9]{64}$/.test(hash));
  assertEquals(
    await transactionalEmailFingerprint({
      ...base,
      message: { ...base.message },
    }),
    hash,
  );
  for (
    const patch of [
      { deliveryId: emailId },
      { idempotencyKey: "another-key" },
      ...Object.entries({
        from: "other@example.test",
        to: "other@example.test",
        subject: "Other",
        text: "Other",
        html: "<p>Other</p>",
      })
        .map(([key, value]) => ({
          message: { ...base.message, [key]: value },
        })),
    ]
  ) assert(await transactionalEmailFingerprint({ ...base, ...patch }) !== hash);
});

Deno.test("unknown headers, recipients, attachments and injection cannot enter a message", async () => {
  for (
    const patch of [
      { headers: {} },
      { reply_to: "other@example.test" },
      { bcc: "other@example.test" },
      { cc: [] },
      { attachments: [] },
      { tags: [] },
      { from: "Dominion\r\nBcc: hidden@example.test" },
      { from: "<support@example.test>" },
      { to: ["reporter@example.test"] },
      { to: "a@example.test,b@example.test" },
      { to: "Reporter <reporter@example.test>" },
      { to: " a@example.test" },
      { to: "a..b@example.test" },
      { to: "a@example..test" },
      { subject: "hello\nprivate" },
      { subject: "" },
      { subject: "x".repeat(201) },
      { text: " " },
      { html: "\u0000" },
      { html: " " },
      { text: "x".repeat(60001) },
      { html: "x".repeat(100001) },
      { [Symbol("hidden")]: true },
    ]
  ) {
    const value = content();
    await invalid(() =>
      transactionalEmailFingerprint(
        {
          ...value,
          message: { ...value.message, ...patch },
        } as TransactionalEmailContent,
      )
    );
  }
});

Deno.test("UTF-8 request cap applies even when each character bound passes", async () => {
  const value = content();
  await invalid(() =>
    transactionalEmailFingerprint({
      ...value,
      message: { ...value.message, text: "界".repeat(50000) },
    })
  );
});

Deno.test("job and adapter configuration reject malformed IDs, keys, timestamps and deadlines", async () => {
  const value = await job();
  for (
    const patch of [
      { deliveryId: "bad" },
      { deliveryId: "00000000-0000-0000-0000-000000000000" },
      { idempotencyKey: "" },
      { idempotencyKey: "x".repeat(257) },
      { idempotencyKey: "key\r\nother" },
      { bindingFingerprint: "" },
      { firstDispatchedAt: "yesterday" },
      { firstDispatchedAt: "2026-02-30T00:00:00Z" },
      { firstDispatchedAt: "2026-09-21T00:00:00-01:00" },
    ]
  ) {
    await invalid(() =>
      deliverTransactionalEmail({ ...value, ...patch }, options())
    );
  }
  for (
    const patch of [
      { apiKey: "" },
      { apiKey: "re_key\nother" },
      { timeoutMs: 0 },
      { timeoutMs: 30001 },
      { timeoutMs: NaN },
      { markDispatched: null },
      { fetcher: "fetch" },
      { now: 1 },
    ]
  ) {
    await invalid(() =>
      deliverTransactionalEmail(
        value,
        options(patch as Partial<TransactionalEmailOptions>),
      )
    );
  }
});

Deno.test("changed binding stops before fence or provider access", async () => {
  const value = await job();
  let calls = 0;
  const result = await deliverTransactionalEmail(
    { ...value, message: { ...value.message, text: "changed" } },
    options({
      markDispatched: async () => {
        calls++;
        return null;
      },
      fetcher: (() => {
        calls++;
        throw new Error("must not fetch");
      }) as typeof fetch,
    }),
  );
  assertEquals(result, { state: "needs_review", code: "binding_mismatch" });
  assertEquals(calls, 0);
});

Deno.test("mutable caller objects cannot change the already-captured request across a fence", async () => {
  const value = await job();
  const original = JSON.stringify(value.message);
  let sent = "";
  const result = await deliverTransactionalEmail(
    value,
    options({
      markDispatched: async (binding) => {
        Object.assign(value.message, {
          to: "changed@example.test",
          text: "changed",
        });
        Object.assign(value, { idempotencyKey: "changed" });
        return receipt(binding);
      },
      fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => {
        sent = String(init?.body);
        return Promise.resolve(json({ id: emailId }));
      }) as typeof fetch,
    }),
  );
  assertEquals(result.state, "accepted");
  assertEquals(sent, original);
});

Deno.test("lost delivery response retries byte-identical content with original key and timestamp", async () => {
  const value = await job();
  const sends: { body: string; key: string }[] = [];
  const opts = options({
    fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => {
      sends.push({
        body: String(init?.body),
        key: new Headers(init?.headers).get("Idempotency-Key")!,
      });
      if (sends.length === 1) throw new Error("secret-provider-error");
      return Promise.resolve(json({ id: emailId }));
    }) as typeof fetch,
  });
  assertEquals(await deliverTransactionalEmail(value, opts), {
    state: "uncertain",
    code: "request_unconfirmed",
  });
  assertEquals(
    await deliverTransactionalEmail(
      { ...value, firstDispatchedAt: first },
      opts,
    ),
    { state: "accepted", emailId },
  );
  assertEquals(sends.length, 2);
  assertEquals(sends[0], sends[1]);
});

Deno.test("23-hour boundary and complete request deadline stop retries before the fence", async () => {
  const value = await job({ firstDispatchedAt: first });
  let calls = 0;
  for (
    const age of [
      TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS,
      24 * 3600000,
      TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS - 10000,
    ]
  ) {
    assertEquals(
      await deliverTransactionalEmail(
        value,
        options({
          now: () => clock + age,
          markDispatched: async () => {
            calls++;
            return null;
          },
        }),
      ),
      { state: "needs_review", code: "retry_window_expired" },
    );
  }
  assertEquals(calls, 0);
  assertEquals(
    (await deliverTransactionalEmail(
      value,
      options({
        now: () => clock + TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS - 10001,
      }),
    )).state,
    "accepted",
  );
});

Deno.test("first timestamp loaded by the durable fence prevents stale-first-attempt resends", async () => {
  let sent = 0;
  const result = await deliverTransactionalEmail(
    await job(),
    options({
      now: () => clock + 24 * 3600000,
      fetcher: (() => {
        sent++;
        return Promise.resolve(json({ id: emailId }));
      }) as typeof fetch,
    }),
  );
  assertEquals(result, { state: "needs_review", code: "retry_window_expired" });
  assertEquals(sent, 0);
});

Deno.test("window is rechecked after a slow fence and immediately before network", async () => {
  for (const changeAt of [2, 3]) {
    let reads = 0;
    let sent = 0;
    const result = await deliverTransactionalEmail(
      await job({ firstDispatchedAt: first }),
      options({
        now: () =>
          ++reads >= changeAt
            ? clock + TRANSACTIONAL_EMAIL_RETRY_WINDOW_MS
            : clock,
        fetcher: (() => {
          sent++;
          return Promise.resolve(json({ id: emailId }));
        }) as typeof fetch,
      }),
    );
    assertEquals(result, {
      state: "needs_review",
      code: "retry_window_expired",
    });
    assertEquals(sent, 0);
  }
});

Deno.test("clock errors and future timestamps fail closed", async () => {
  for (
    const now of [() => NaN, () => 0, () => {
      throw new Error("clock-private");
    }]
  ) {
    assertEquals(
      await deliverTransactionalEmail(await job(), options({ now })),
      { state: "needs_review", code: "clock_invalid" },
    );
  }
  assertEquals(
    await deliverTransactionalEmail(
      await job({ firstDispatchedAt: first }),
      options({ now: () => clock - 1 }),
    ),
    { state: "needs_review", code: "clock_invalid" },
  );
});

Deno.test("fence denial, exception, timeout and abort cannot dispatch", async () => {
  const value = await job();
  let sends = 0;
  let lateSignal: AbortSignal | undefined;
  const fetcher = (() => {
    sends++;
    return Promise.resolve(json({ id: emailId }));
  }) as typeof fetch;
  assertEquals(
    await deliverTransactionalEmail(
      value,
      options({
        fetcher,
        markDispatched: async () => null,
      }),
    ),
    { state: "retryable", code: "dispatch_not_owned" },
  );
  assertEquals(
    await deliverTransactionalEmail(
      value,
      options({
        fetcher,
        markDispatched: () => {
          throw new Error("private");
        },
      }),
    ),
    { state: "uncertain", code: "dispatch_unconfirmed" },
  );
  const held = deferred<ReturnType<typeof receipt>>();
  let captured!: TransactionalEmailDispatchBinding;
  assertEquals(
    await deliverTransactionalEmail(
      value,
      options({
        fetcher,
        timeoutMs: 5,
        markDispatched: (binding, signal) => {
          captured = binding;
          lateSignal = signal;
          return held.promise;
        },
      }),
    ),
    { state: "uncertain", code: "dispatch_unconfirmed" },
  );
  assert(lateSignal?.aborted);
  held.resolve(receipt(captured));
  await Promise.resolve();
  const controller = new AbortController();
  controller.abort();
  assertEquals(
    await deliverTransactionalEmail(
      value,
      options({ fetcher, signal: controller.signal }),
    ),
    { state: "uncertain", code: "dispatch_unconfirmed" },
  );
  assertEquals(sends, 0);
});

Deno.test("fence receipt must bind exact job, key, hash and original timestamp", async () => {
  const value = await job({ firstDispatchedAt: first });
  let sends = 0;
  for (
    const patch of [
      { deliveryId: emailId },
      { idempotencyKey: "other" },
      { bindingFingerprint: "a".repeat(64) },
      { firstDispatchedAt: new Date(clock + 1000).toISOString() },
      { firstDispatchedAt: "invalid" },
      { extra: true },
    ]
  ) {
    assertEquals(
      await deliverTransactionalEmail(
        value,
        options({
          markDispatched: async (binding) => ({
            ...receipt(binding),
            ...patch,
          }),
          fetcher: (() => {
            sends++;
            return Promise.resolve(json({ id: emailId }));
          }) as typeof fetch,
        }),
      ),
      { state: "needs_review", code: "dispatch_receipt_mismatch" },
    );
  }
  assertEquals(sends, 0);
  assertEquals(
    (await deliverTransactionalEmail(
      value,
      options({
        markDispatched: async (binding) => ({
          ...receipt(binding),
          firstDispatchedAt: "2026-09-21T12:00:00.000000+00:00",
        }),
      }),
    )).state,
    "accepted",
  );
});

for (
  const [status, name, state, code] of [
    [409, "invalid_idempotent_request", "needs_review", "idempotency_conflict"],
    [409, "concurrent_idempotent_requests", "retryable", "concurrent_request"],
    [429, "rate_limit_exceeded", "retryable", "rate_limited"],
    [429, "daily_quota_exceeded", "needs_review", "daily_quota_exceeded"],
    [429, "monthly_quota_exceeded", "needs_review", "monthly_quota_exceeded"],
    [401, "missing_api_key", "needs_review", "provider_rejected"],
    [403, "validation_error", "needs_review", "provider_rejected"],
    [422, "validation_error", "needs_review", "provider_rejected"],
    [500, "application_error", "uncertain", "request_unconfirmed"],
    [409, "unknown", "uncertain", "request_unconfirmed"],
    [429, "unknown", "uncertain", "request_unconfirmed"],
    [302, "redirect", "uncertain", "request_unconfirmed"],
  ] as const
) {
  Deno.test(`email provider ${status}/${name} is classified without raw errors`, async () => {
    const result = await deliverTransactionalEmail(
      await job(),
      options({
        fetcher: (() =>
          Promise.resolve(
            json({ name, message: "SECRET-provider-message" }, status),
          )) as typeof fetch,
      }),
    );
    assertEquals(result, { state, code });
    assert(!JSON.stringify(result).includes("SECRET"));
  });
}

Deno.test("only a strict UUID receipt confirms provider acceptance, never delivery", async () => {
  for (
    const payload of [{}, null, [], { id: "" }, { id: "not-a-uuid" }, {
      id: "00000000-0000-0000-0000-000000000000",
    }, { id: emailId, extra: true }]
  ) {
    assertEquals(
      await deliverTransactionalEmail(
        await job(),
        options({
          fetcher: (() => Promise.resolve(json(payload))) as typeof fetch,
        }),
      ),
      { state: "needs_review", code: "receipt_invalid" },
    );
  }
});

Deno.test("oversized and invalid response bodies cannot confirm acceptance", async () => {
  for (
    const response of [
      new Response("not json"),
      new Response(JSON.stringify({ id: emailId }), {
        headers: { "Content-Length": "16385" },
      }),
      new Response("x".repeat(16385)),
      new Response(new Uint8Array([0xff, 0xfe])),
      new Response(null),
    ]
  ) {
    assertEquals(
      await deliverTransactionalEmail(
        await job(),
        options({ fetcher: (() => Promise.resolve(response)) as typeof fetch }),
      ),
      { state: "needs_review", code: "receipt_invalid" },
    );
  }
});

Deno.test("request and streamed-response deadlines fence ignored-abort late receipts", async () => {
  const held = deferred<Response>();
  let signal: AbortSignal | undefined;
  assertEquals(
    await deliverTransactionalEmail(
      await job(),
      options({
        timeoutMs: 5,
        fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal as AbortSignal;
          return held.promise;
        }) as typeof fetch,
      }),
    ),
    { state: "uncertain", code: "request_unconfirmed" },
  );
  assert(signal?.aborted);
  held.resolve(json({ id: emailId }));
  await Promise.resolve();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"'));
    },
    cancel() {
      cancelled = true;
    },
  });
  assertEquals(
    await deliverTransactionalEmail(
      await job(),
      options({
        timeoutMs: 5,
        fetcher: (() => Promise.resolve(new Response(stream))) as typeof fetch,
      }),
    ),
    { state: "uncertain", code: "request_unconfirmed" },
  );
  assert(cancelled);
});

Deno.test("abort after durable fence causes no POST", async () => {
  const controller = new AbortController();
  let sends = 0;
  const result = await deliverTransactionalEmail(
    await job(),
    options({
      signal: controller.signal,
      markDispatched: async (binding) => {
        controller.abort();
        return receipt(binding);
      },
      fetcher: (() => {
        sends++;
        return Promise.resolve(json({ id: emailId }));
      }) as typeof fetch,
    }),
  );
  assertEquals(result.state, "uncertain");
  assertEquals(sends, 0);
});
