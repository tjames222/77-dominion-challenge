import { assertEquals, responseJson } from "../_shared/test_helpers.ts";
import { HttpError } from "../_shared/http.ts";
import { createHandler } from "./index.ts";

const origin = "https://77dominion.com";
const env = (name: string) => ({ PUBLIC_SITE_URL: origin }[name]);
const payload = {
  name: "  Sam Example  ",
  email: " SAM@EXAMPLE.COM ",
  website: "",
};
function request(
  body: unknown = payload,
  headers: Record<string, string> = {},
) {
  return new Request("https://functions.test.local/request-early-access", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function fixture(
  {
    user = {
      id: "user-1",
      email: "sam@example.com",
      email_confirmed_at: "2026-01-01",
    },
    data = { received: true } as unknown,
    error = null as unknown,
    authError = false,
    bodyTimeoutMs = 5000,
  } = {},
) {
  const calls: unknown[] = [];
  const handle = createHandler({
    env,
    bodyTimeoutMs,
    requireUser: async () => {
      calls.push("requireUser");
      if (authError) throw new HttpError("Not authenticated.", 401);
      return user;
    },
    createAdminClient: () => ({
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data, error };
      },
    }),
  } as any);
  return { handle, calls };
}

Deno.test("anonymous early-access request stores only normalized input and returns no identifying metadata", async () => {
  const { handle, calls } = fixture();
  const result = await handle(request());
  assertEquals(result.status, 200);
  assertEquals(await responseJson(result), { received: true });
  assertEquals(result.headers.get("cache-control"), "private, no-store");
  assertEquals(result.headers.get("access-control-allow-origin"), origin);
  assertEquals(calls, [{
    name: "submit_early_access_request_service",
    args: {
      p_name: "Sam Example",
      p_email: "sam@example.com",
      p_user_id: null,
    },
  }]);
});

Deno.test("signed-in intake verifies the token and binds only the verified matching account", async () => {
  const { handle, calls } = fixture();
  const result = await handle(
    request(payload, { Authorization: "Bearer test-token" }),
  );
  assertEquals(result.status, 200);
  assertEquals(calls, ["requireUser", {
    name: "submit_early_access_request_service",
    args: {
      p_name: "Sam Example",
      p_email: "sam@example.com",
      p_user_id: "user-1",
    },
  }]);
});

Deno.test("invalid or unverified signed-in identity never falls back to anonymous intake", async () => {
  for (
    const options of [
      { authError: true },
      {
        user: {
          id: "user-1",
          email: "other@example.com",
          email_confirmed_at: "2026-01-01",
        },
      },
      {
        user: {
          id: "user-1",
          email: "sam@example.com",
          email_confirmed_at: "",
        },
      },
      {
        user: {
          id: "user-1",
          email: "sam@example.com",
          email_confirmed_at: "2026-01-01",
          is_anonymous: true,
        },
      },
    ]
  ) {
    const { handle, calls } = fixture(options);
    const result = await handle(request(payload, { Authorization: "invalid" }));
    assertEquals(result.status, options.authError ? 401 : 403);
    assertEquals(calls, ["requireUser"]);
  }
});

Deno.test("empty, malformed, overlong, or privilege-bearing input cannot reach auth or SQL", async () => {
  for (
    const body of [
      null,
      [],
      "string",
      {},
      { ...payload, name: "" },
      { ...payload, email: "invalid" },
      { ...payload, name: "x".repeat(121) },
      { ...payload, name: "Sam\nOther" },
      { ...payload, email: `x${"y".repeat(250)}@example.com` },
      { ...payload, status: "approved" },
      { ...payload, userId: "attacker-chosen" },
      { ...payload, answers: {} },
      { ...payload, website: {} },
    ]
  ) {
    const { handle, calls } = fixture();
    const result = await handle(request(body));
    assertEquals(result.status, 400);
    assertEquals(calls, []);
  }
});

Deno.test("request size is bounded for declared and chunked bodies; malformed UTF-8 fails safely", async () => {
  const cases = [
    { req: request(payload, { "Content-Length": "2049" }), status: 413 },
    { req: request({ ...payload, website: "x".repeat(2049) }), status: 413 },
    {
      req: new Request("https://functions.test.local", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: new Uint8Array([0xff]),
      }),
      status: 400,
    },
    { req: request(payload, { "Content-Type": "text/plain" }), status: 415 },
  ];
  for (const { req, status } of cases) {
    const { handle, calls } = fixture();
    assertEquals((await handle(req)).status, status);
    assertEquals(calls, []);
  }
});

Deno.test("a stalled body has a bounded deadline and cancels its reader", async () => {
  let cancelled = false;
  const { handle, calls } = fixture({ bodyTimeoutMs: 5 });
  const result = await handle(
    new Request("https://functions.test.local", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  assertEquals(result.status, 408);
  assertEquals(cancelled, true);
  assertEquals(calls, []);
});

Deno.test("preflight is origin-bound and unsupported methods are non-mutating", async () => {
  for (
    const [method, requestOrigin, status] of [
      ["OPTIONS", origin, 200],
      ["OPTIONS", "https://evil.example", 403],
      ["POST", "https://evil.example", 403],
      ["GET", origin, 405],
      ["POST", "", 403],
    ] as const
  ) {
    const { handle, calls } = fixture();
    const result = await handle(
      new Request("https://functions.test.local", {
        method,
        headers: { Origin: requestOrigin },
      }),
    );
    assertEquals(result.status, status);
    assertEquals(result.headers.get("cache-control"), "private, no-store");
    assertEquals(calls, []);
  }
});

Deno.test("honeypot returns the same receipt without persistence or an invitation", async () => {
  const { handle, calls } = fixture();
  const result = await handle(request({ ...payload, website: "bot-filled" }));
  assertEquals(result.status, 200);
  assertEquals(await responseJson(result), { received: true });
  assertEquals(calls, []);
});

Deno.test("new and duplicate receipts are identical; database detail never reaches callers", async () => {
  for (
    const error of [
      { code: "P0001", message: "EARLY_ACCESS_RATE_LIMIT" },
      { code: "55P03", message: "internal lock detail" },
      { code: "42501", message: "private account detail" },
      { code: "23505", message: "private email exists in table" },
    ]
  ) {
    const { handle } = fixture({ error });
    const result = await handle(request());
    const expectedStatus = ["P0001", "55P03"].includes(error.code)
      ? 429
      : error.code === "42501"
      ? 403
      : 500;
    assertEquals(result.status, expectedStatus);
    assertEquals(
      result.headers.get("retry-after"),
      expectedStatus === 429 ? "3600" : null,
    );
    const text = await result.text();
    assertEquals(text.includes(error.message), false);
    assertEquals(text.includes("sam@example.com"), false);
  }
  for (const data of [null, {}, { received: false }]) {
    const { handle } = fixture({ data });
    assertEquals((await handle(request())).status, 500);
  }
});
