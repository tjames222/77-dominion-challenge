import { assert, assertEquals } from "./test_helpers.ts";
import {
  exchangeProviderCode,
  listProviderChannels,
  providerAuthorizationUrl,
  ProviderConnectionError,
  requireProviderChannel,
  revokeProviderCredential,
} from "./integration_providers.ts";

function env(name: string) {
  return {
    SUPABASE_URL: "https://project.supabase.co",
    SLACK_CLIENT_ID: "slack-client",
    SLACK_CLIENT_SECRET: "slack-secret",
    DISCORD_CLIENT_ID: "discord-client",
    DISCORD_CLIENT_SECRET: "discord-secret",
    DISCORD_BOT_TOKEN: "discord-bot-token",
  }[name];
}

async function rejectsProvider(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof ProviderConnectionError);
    return error;
  }
  throw new Error("Expected ProviderConnectionError.");
}

Deno.test("provider authorization URLs use exact callbacks and minimum permissions", () => {
  const slack = new URL(providerAuthorizationUrl("slack", "signed-state", env));
  assertEquals(slack.origin, "https://slack.com");
  assertEquals(
    slack.searchParams.get("scope"),
    "chat:write,channels:read,groups:read",
  );
  assertEquals(
    slack.searchParams.get("redirect_uri"),
    "https://project.supabase.co/functions/v1/slack-oauth-callback",
  );
  assertEquals(slack.searchParams.get("state"), "signed-state");

  const discord = new URL(
    providerAuthorizationUrl("discord", "signed-state", env),
  );
  assertEquals(discord.origin, "https://discord.com");
  assertEquals(discord.searchParams.get("scope"), "bot identify");
  assertEquals(discord.searchParams.get("permissions"), "3072");
  assertEquals(
    discord.searchParams.get("redirect_uri"),
    "https://project.supabase.co/functions/v1/discord-oauth-callback",
  );
});

Deno.test("Slack code exchange returns only normalized authorization data", async () => {
  let form: URLSearchParams | undefined;
  const result = await exchangeProviderCode("slack", "temporary-code", {
    env,
    fetcher: (async (_input: string | URL | Request, init?: RequestInit) => {
      form = init?.body as URLSearchParams;
      return new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-secret-token",
          scope: "chat:write,channels:read,groups:read",
          team: { id: "T1", name: "Test Workspace" },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assertEquals(form?.get("client_secret"), "slack-secret");
  assertEquals(result, {
    accessToken: "xoxb-secret-token",
    workspaceId: "T1",
    workspaceName: "Test Workspace",
    scopes: ["chat:write", "channels:read", "groups:read"],
  });
});

Deno.test("Discord code exchange verifies the installer and installed bot", async () => {
  const calls: string[] = [];
  const result = await exchangeProviderCode("discord", "temporary-code", {
    guildId: "123456789012345678",
    env,
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/oauth2/token")) {
        assert(
          new Headers(init?.headers).get("authorization")?.startsWith("Basic "),
        );
        return new Response(
          JSON.stringify({ access_token: "installer-token" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/users/@me")) {
        assertEquals(
          new Headers(init?.headers).get("authorization"),
          "Bearer installer-token",
        );
        return new Response(JSON.stringify({ id: "installer" }), {
          status: 200,
        });
      }
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Bot discord-bot-token",
      );
      return new Response(
        JSON.stringify({ id: "123456789012345678", name: "Test Server" }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assertEquals(calls.length, 3);
  assertEquals(result.workspaceName, "Test Server");
  assertEquals(result.accessToken, "discord-bot-token");
  assertEquals(result.scopes, [
    "bot",
    "identify",
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
  ]);
});

Deno.test("Discord exchange rejects a missing selected server", async () => {
  const error = await rejectsProvider(() =>
    exchangeProviderCode("discord", "temporary-code", { env })
  );
  assertEquals(error.code, "provider_authorization_failed");
});

Deno.test("Slack channel discovery paginates and returns joined channels only", async () => {
  let calls = 0;
  const channels = await listProviderChannels(
    "slack",
    "token",
    "T1",
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Bearer token",
      );
      const cursor = new URL(String(input)).searchParams.get("cursor");
      return new Response(
        JSON.stringify(
          cursor
            ? {
              ok: true,
              channels: [{
                id: "C2",
                name: "private",
                is_member: true,
                is_private: true,
              }],
              response_metadata: { next_cursor: "" },
            }
            : {
              ok: true,
              channels: [
                {
                  id: "C1",
                  name: "public",
                  is_member: true,
                  is_private: false,
                },
                { id: "C0", name: "not-joined", is_member: false },
              ],
              response_metadata: { next_cursor: "next" },
            },
        ),
        { status: 200 },
      );
    }) as typeof fetch,
  );
  assertEquals(calls, 2);
  assertEquals(channels, [
    { id: "C1", name: "public", kind: "public" },
    { id: "C2", name: "private", kind: "private" },
  ]);
});

Deno.test("Discord channel discovery filters to supported text channels", async () => {
  const channels = await listProviderChannels(
    "discord",
    "bot-token",
    "123456789012345678",
    (async (_input: string | URL | Request, init?: RequestInit) => {
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Bot bot-token",
      );
      return new Response(
        JSON.stringify([
          { id: "1", name: "general", type: 0 },
          { id: "2", name: "announcements", type: 5 },
          { id: "3", name: "voice", type: 2 },
        ]),
        { status: 200 },
      );
    }) as typeof fetch,
  );
  assertEquals(channels.map((item) => item.name), ["general", "announcements"]);
});

Deno.test("channel confirmation rejects an inaccessible destination", async () => {
  const error = await rejectsProvider(() =>
    requireProviderChannel(
      "slack",
      "token",
      "T1",
      "C-missing",
      (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channels: [],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200 },
        )) as typeof fetch,
    )
  );
  assertEquals(error.code, "provider_destination_missing");
});

Deno.test("provider revocation uses supported Slack and Discord operations", async () => {
  const slack = await revokeProviderCredential(
    "slack",
    "token",
    "T1",
    (async (_input: string | URL | Request, init?: RequestInit) => {
      assertEquals(init?.method, "POST");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  );
  assertEquals(slack, true);

  const discord = await revokeProviderCredential(
    "discord",
    "bot-token",
    "123456789012345678",
    (async (input: string | URL | Request, init?: RequestInit) => {
      assert(String(input).endsWith("/users/@me/guilds/123456789012345678"));
      assertEquals(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  );
  assertEquals(discord, true);
});

Deno.test("provider revocation treats already-revoked credentials as idempotent success", async () => {
  const slack = await revokeProviderCredential(
    "slack",
    "revoked-token",
    "T1",
    (async () =>
      new Response(JSON.stringify({ ok: false, error: "token_revoked" }), {
        status: 200,
      })) as typeof fetch,
  );
  const discord = await revokeProviderCredential(
    "discord",
    "removed-bot-token",
    "123456789012345678",
    (async () => new Response(null, { status: 404 })) as typeof fetch,
  );
  assertEquals(slack, true);
  assertEquals(discord, true);
});

Deno.test("provider errors expose normalized messages instead of raw bodies", async () => {
  const error = await rejectsProvider(() =>
    exchangeProviderCode("slack", "bad-code", {
      env,
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "raw-provider-secret-detail",
          }),
          { status: 400 },
        )) as typeof fetch,
    })
  );
  assertEquals(error.code, "provider_authorization_failed");
  assert(!error.message.includes("raw-provider-secret-detail"));
});
