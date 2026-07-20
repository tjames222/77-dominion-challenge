import type { EnvReader } from "./http.ts";
import type { IntegrationProvider } from "./integration_delivery.ts";

export type ProviderChannel = {
  id: string;
  name: string;
  kind: "public" | "private";
};

export type ProviderAuthorization = {
  accessToken: string;
  workspaceId: string;
  workspaceName: string;
  scopes: string[];
};

export class ProviderConnectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderConnectionError";
  }
}

function requiredEnv(env: EnvReader, name: string) {
  const value = env(name);
  if (!value) throw new Error(`Missing provider configuration: ${name}.`);
  return value;
}

function callbackUrl(provider: IntegrationProvider, env: EnvReader) {
  const base = new URL(requiredEnv(env, "SUPABASE_URL"));
  const functionName = provider === "slack"
    ? "slack-oauth-callback"
    : "discord-oauth-callback";
  return new URL(`/functions/v1/${functionName}`, base).toString();
}

export function providerAuthorizationUrl(
  provider: IntegrationProvider,
  state: string,
  env: EnvReader,
) {
  if (provider === "slack") {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", requiredEnv(env, "SLACK_CLIENT_ID"));
    url.searchParams.set("scope", "chat:write,channels:read,groups:read");
    url.searchParams.set("redirect_uri", callbackUrl(provider, env));
    url.searchParams.set("state", state);
    return url.toString();
  }

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", requiredEnv(env, "DISCORD_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl(provider, env));
  url.searchParams.set("scope", "bot identify");
  url.searchParams.set("permissions", "3072");
  url.searchParams.set("state", state);
  return url.toString();
}

async function responseJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ProviderConnectionError(
      "provider_invalid_response",
      "The provider returned an unreadable response.",
      response.status >= 500,
    );
  }
}

async function exchangeSlackCode(
  code: string,
  env: EnvReader,
  fetcher: typeof fetch,
): Promise<ProviderAuthorization> {
  const form = new URLSearchParams({
    client_id: requiredEnv(env, "SLACK_CLIENT_ID"),
    client_secret: requiredEnv(env, "SLACK_CLIENT_SECRET"),
    code,
    redirect_uri: callbackUrl("slack", env),
  });
  const response = await fetcher("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await responseJson(response);
  if (
    !response.ok || body.ok !== true || typeof body.access_token !== "string"
  ) {
    throw new ProviderConnectionError(
      response.status >= 500
        ? "provider_unavailable"
        : "provider_authorization_failed",
      "Slack authorization could not be completed.",
      response.status >= 500,
    );
  }
  const team = body.team && typeof body.team === "object"
    ? body.team as Record<string, unknown>
    : {};
  if (typeof team.id !== "string") {
    throw new ProviderConnectionError(
      "provider_invalid_response",
      "Slack did not identify the authorized workspace.",
    );
  }
  const rawScopes = typeof body.scope === "string" ? body.scope.split(",") : [];
  return {
    accessToken: body.access_token,
    workspaceId: team.id,
    workspaceName: typeof team.name === "string"
      ? team.name
      : "Slack workspace",
    scopes: rawScopes.map((scope) => scope.trim()).filter(Boolean),
  };
}

async function exchangeDiscordCode(
  code: string,
  guildId: string | undefined,
  env: EnvReader,
  fetcher: typeof fetch,
): Promise<ProviderAuthorization> {
  if (!guildId || !/^\d{5,24}$/.test(guildId)) {
    throw new ProviderConnectionError(
      "provider_authorization_failed",
      "Discord did not identify the selected server.",
    );
  }
  const clientId = requiredEnv(env, "DISCORD_CLIENT_ID");
  const clientSecret = requiredEnv(env, "DISCORD_CLIENT_SECRET");
  const response = await fetcher("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl("discord", env),
    }),
  });
  const body = await responseJson(response);
  if (!response.ok || typeof body.access_token !== "string") {
    throw new ProviderConnectionError(
      response.status >= 500
        ? "provider_unavailable"
        : "provider_authorization_failed",
      "Discord authorization could not be completed.",
      response.status >= 500,
    );
  }

  const identityResponse = await fetcher(
    "https://discord.com/api/v10/users/@me",
    {
      headers: { Authorization: `Bearer ${body.access_token}` },
    },
  );
  if (!identityResponse.ok) {
    throw new ProviderConnectionError(
      "provider_authorization_failed",
      "Discord could not verify the installing user.",
    );
  }

  const botToken = requiredEnv(env, "DISCORD_BOT_TOKEN");
  const guildResponse = await fetcher(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`,
    { headers: { Authorization: `Bot ${botToken}` } },
  );
  const guild = await responseJson(guildResponse);
  if (!guildResponse.ok || typeof guild.id !== "string") {
    throw new ProviderConnectionError(
      guildResponse.status >= 500
        ? "provider_unavailable"
        : "provider_authorization_failed",
      "The Dominion bot is not available in the selected Discord server.",
      guildResponse.status >= 500,
    );
  }

  return {
    accessToken: botToken,
    workspaceId: guild.id,
    workspaceName: typeof guild.name === "string"
      ? guild.name
      : "Discord server",
    scopes: ["bot", "identify", "VIEW_CHANNEL", "SEND_MESSAGES"],
  };
}

export async function exchangeProviderCode(
  provider: IntegrationProvider,
  code: string,
  options: { guildId?: string; env: EnvReader; fetcher?: typeof fetch },
) {
  if (!code || code.length > 2048) {
    throw new ProviderConnectionError(
      "provider_authorization_failed",
      "The provider authorization code is invalid.",
    );
  }
  const fetcher = options.fetcher || fetch;
  return provider === "slack"
    ? await exchangeSlackCode(code, options.env, fetcher)
    : await exchangeDiscordCode(code, options.guildId, options.env, fetcher);
}

async function listSlackChannels(
  accessToken: string,
  fetcher: typeof fetch,
) {
  const channels: ProviderChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await responseJson(response);
    if (!response.ok || body.ok !== true || !Array.isArray(body.channels)) {
      throw new ProviderConnectionError(
        response.status >= 500
          ? "provider_unavailable"
          : "provider_authorization_failed",
        "Slack channels could not be loaded.",
        response.status >= 500,
      );
    }
    for (const raw of body.channels) {
      if (!raw || typeof raw !== "object") continue;
      const channel = raw as Record<string, unknown>;
      if (
        typeof channel.id === "string" && typeof channel.name === "string" &&
        channel.is_member === true && channel.is_archived !== true
      ) {
        channels.push({
          id: channel.id,
          name: channel.name,
          kind: channel.is_private === true ? "private" : "public",
        });
      }
    }
    const metadata =
      body.response_metadata && typeof body.response_metadata === "object"
        ? body.response_metadata as Record<string, unknown>
        : {};
    cursor = typeof metadata.next_cursor === "string"
      ? metadata.next_cursor
      : "";
    if (!cursor) break;
  }
  return channels;
}

async function listDiscordChannels(
  accessToken: string,
  workspaceId: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher(
    `https://discord.com/api/v10/guilds/${
      encodeURIComponent(workspaceId)
    }/channels`,
    { headers: { Authorization: `Bot ${accessToken}` } },
  );
  const body = await responseJson(response);
  if (!response.ok || !Array.isArray(body)) {
    throw new ProviderConnectionError(
      response.status >= 500
        ? "provider_unavailable"
        : "provider_authorization_failed",
      "Discord channels could not be loaded.",
      response.status >= 500,
    );
  }
  return body.flatMap((raw): ProviderChannel[] => {
    if (!raw || typeof raw !== "object") return [];
    const channel = raw as Record<string, unknown>;
    if (
      typeof channel.id !== "string" || typeof channel.name !== "string" ||
      (channel.type !== 0 && channel.type !== 5)
    ) return [];
    return [{ id: channel.id, name: channel.name, kind: "private" }];
  });
}

export async function listProviderChannels(
  provider: IntegrationProvider,
  accessToken: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  return provider === "slack"
    ? await listSlackChannels(accessToken, fetcher)
    : await listDiscordChannels(accessToken, workspaceId, fetcher);
}

export async function requireProviderChannel(
  provider: IntegrationProvider,
  accessToken: string,
  workspaceId: string,
  channelId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!channelId || channelId.length > 200) {
    throw new ProviderConnectionError(
      "provider_destination_missing",
      "Select an available provider channel.",
    );
  }
  const channels = await listProviderChannels(
    provider,
    accessToken,
    workspaceId,
    fetcher,
  );
  const selected = channels.find((channel) => channel.id === channelId);
  if (!selected) {
    throw new ProviderConnectionError(
      "provider_destination_missing",
      "The selected provider channel is unavailable to the Dominion app.",
    );
  }
  return selected;
}

export async function revokeProviderCredential(
  provider: IntegrationProvider,
  accessToken: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  if (provider === "slack") {
    const response = await fetcher("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await responseJson(response);
    return response.ok && body.ok === true;
  }
  const response = await fetcher(
    `https://discord.com/api/v10/users/@me/guilds/${
      encodeURIComponent(workspaceId)
    }`,
    { method: "DELETE", headers: { Authorization: `Bot ${accessToken}` } },
  );
  return response.status === 204;
}
