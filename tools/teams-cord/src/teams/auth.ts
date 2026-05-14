import { buildUserAgent } from "./user-agent.js";
import type { TeamsCredentials } from "./types.js";

/**
 * Adapted from extensions/msteams/src/token.ts with the OpenClaw plugin
 * coupling removed.
 *
 * Bot Framework uses the global AAD endpoint and the `botframework.com` scope;
 * Graph uses the tenant-scoped AAD endpoint and the Graph default scope.
 */

const BOT_FRAMEWORK_TOKEN_ENDPOINT = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";

type TokenEntry = { token: string; expiresAt: number };
const cache = new Map<string, TokenEntry>();

async function fetchToken(params: {
  endpoint: string;
  scope: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenEntry> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: params.scope,
  });
  const res = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": buildUserAgent(),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token fetch ${params.endpoint} failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("Token response missing access_token");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  // Refresh 60s before expiry to avoid edge races.
  return { token: json.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
}

async function getCached(cacheKey: string, params: {
  endpoint: string;
  scope: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const existing = cache.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.token;
  }
  const fresh = await fetchToken(params);
  cache.set(cacheKey, fresh);
  return fresh.token;
}

export async function getBotFrameworkToken(creds: TeamsCredentials): Promise<string> {
  return getCached(`bf:${creds.appId}`, {
    endpoint: BOT_FRAMEWORK_TOKEN_ENDPOINT,
    scope: BOT_FRAMEWORK_SCOPE,
    clientId: creds.appId,
    clientSecret: creds.appPassword,
  });
}

export async function getGraphToken(creds: TeamsCredentials): Promise<string> {
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`;
  const scope = process.env.TEAMS_GRAPH_SCOPE ?? "https://graph.microsoft.com/.default";
  return getCached(`graph:${creds.tenantId}:${creds.appId}:${scope}`, {
    endpoint,
    scope,
    clientId: creds.appId,
    clientSecret: creds.appPassword,
  });
}

export function clearTokenCache(): void {
  cache.clear();
}
