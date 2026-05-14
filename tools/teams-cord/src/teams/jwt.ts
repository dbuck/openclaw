import jwtPkg from "jsonwebtoken";
import jwksPkg from "jwks-rsa";
import type { TeamsCredentials } from "./types.js";

/**
 * Slimmed port of the JWT validation in extensions/msteams/src/sdk.ts.
 *
 * This validates inbound Bot Framework webhook requests against both the
 * legacy Bot Framework JWKS and the Entra (Azure AD) JWKS. Audience must be
 * the bot's app id (or `api://<appId>`, or the Bot Framework global audience
 * with a matching `appid` claim).
 *
 * Network errors fetching the JWKS endpoints are rethrown so the caller can
 * log them at warn-level — they look identical to a bad token otherwise.
 */

const BOT_FRAMEWORK_AUDIENCE = "https://api.botframework.com";

const ISSUER_ENDPOINTS: ReadonlyArray<{
  issuer: string | ((tenantId: string) => string);
  jwksUri: string;
}> = [
  {
    issuer: "https://api.botframework.com",
    jwksUri: "https://login.botframework.com/v1/.well-known/keys",
  },
  {
    issuer: (tenantId) => `https://login.microsoftonline.com/${tenantId}/v2.0`,
    jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  },
  {
    issuer: (tenantId) => `https://sts.windows.net/${tenantId}/`,
    jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  },
];

type JwtModule = typeof jwtPkg;
const jwt: JwtModule = (jwtPkg as unknown as { default?: JwtModule }).default ?? jwtPkg;
const JwksClient: typeof jwksPkg.JwksClient =
  (jwksPkg as unknown as { JwksClient?: typeof jwksPkg.JwksClient }).JwksClient ?? jwksPkg.JwksClient;

export type JwtValidator = (authorizationHeader: string) => Promise<boolean>;

export function createBotJwtValidator(creds: TeamsCredentials): JwtValidator {
  const allowedAudiences = [creds.appId, `api://${creds.appId}`, BOT_FRAMEWORK_AUDIENCE];
  const allowedIssuers = ISSUER_ENDPOINTS.map((e) =>
    typeof e.issuer === "function" ? e.issuer(creds.tenantId) : e.issuer,
  );
  const clients = new Map<string, InstanceType<typeof JwksClient>>();
  const clientFor = (uri: string): InstanceType<typeof JwksClient> => {
    let c = clients.get(uri);
    if (!c) {
      c = new JwksClient({ jwksUri: uri, cache: true, cacheMaxAge: 600_000, rateLimit: true });
      clients.set(uri, c);
    }
    return c;
  };

  return async (authHeader: string) => {
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token) return false;
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded !== "object") return false;
    const header = decoded.header as { kid?: string };
    const payload = decoded.payload as Record<string, unknown> & { iss?: string; appid?: string; azp?: string };
    if (!header?.kid || typeof payload?.iss !== "string") return false;

    const entry = ISSUER_ENDPOINTS.find((e) => {
      const expected = typeof e.issuer === "function" ? e.issuer(creds.tenantId) : e.issuer;
      return expected === payload.iss;
    });
    if (!entry) return false;

    try {
      const signingKey = await clientFor(entry.jwksUri).getSigningKey(header.kid);
      const publicKey = signingKey.getPublicKey();
      const verified = jwt.verify(token, publicKey, {
        audience: allowedAudiences,
        issuer: allowedIssuers,
        algorithms: ["RS256"],
        clockTolerance: 300,
      });
      if (!verified || typeof verified !== "object") return false;
      const audClaim = (verified as { aud?: unknown }).aud;
      const audiences = Array.isArray(audClaim)
        ? audClaim.filter((a): a is string => typeof a === "string")
        : typeof audClaim === "string"
          ? [audClaim]
          : [];
      if (audiences.includes(BOT_FRAMEWORK_AUDIENCE)) {
        const appid = (verified as { appid?: unknown; azp?: unknown }).appid;
        const azp = (verified as { azp?: unknown }).azp;
        const got = (typeof appid === "string" ? appid : typeof azp === "string" ? azp : "").toLowerCase();
        if (got !== creds.appId.toLowerCase()) return false;
      }
      return true;
    } catch (err) {
      if (isNetworkError(err)) throw err;
      return false;
    }
  };
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET"].includes(code)) {
    return true;
  }
  return /jwks|key fetch|getSigningKey/i.test(err.message) && /network|fetch|connect/i.test(err.message);
}
