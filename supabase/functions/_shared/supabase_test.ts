import { assert, assertEquals } from "./test_helpers.ts";
import {
  createAdminClient,
  createUserClient,
  requireUser,
} from "./supabase.ts";

const env = (name: string) =>
  ({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
  })[name];

Deno.test("Supabase clients read environment only when a client is created", () => {
  const calls: unknown[][] = [];
  const createClient = (...args: unknown[]) => {
    calls.push(args);
    return { args };
  };
  const req = new Request("https://functions.test.local", {
    headers: { Authorization: "Bearer user-token" },
  });

  createUserClient(req, { env, createClient: createClient as any });
  createAdminClient({ env, createClient: createClient as any });

  assertEquals(calls.length, 2);
  assertEquals(calls[0][1], "anon");
  assertEquals(calls[1][1], "service");
});

Deno.test("requireUser rejects missing bearer auth before creating a client", async () => {
  let clientCreated = false;
  try {
    await requireUser(new Request("https://functions.test.local"), {
      env,
      createClient: (() => {
        clientCreated = true;
      }) as any,
    });
    throw new Error("Expected requireUser to reject");
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, "Not authenticated.");
    assertEquals((error as { status?: number }).status, 401);
    assertEquals(clientCreated, false);
  }
});

Deno.test("requireUser returns the authenticated Supabase user", async () => {
  const user = { id: "user-1", email: "member@example.com" };
  const result = await requireUser(
    new Request("https://functions.test.local", {
      headers: { Authorization: "Bearer user-token" },
    }),
    {
      env,
      createClient: (() => ({
        auth: { getUser: async () => ({ data: { user }, error: null }) },
      })) as any,
    },
  );

  assertEquals(result, user);
});
