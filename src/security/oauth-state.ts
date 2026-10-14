import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hostCookie, randomToken, readCookie, signedValue, verifySignedValue } from "./cookies";

const COOKIE_NAME = "__Host-github_mcp_oauth_state";
const SIGNATURE_PURPOSE = "oauth-state";
const STATE_PREFIX = "github-oauth-state:";
const STATE_TTL_SECONDS = 10 * 60;

/**
 * Stores the MCP authorization request while the user signs in on GitHub. The `state` sent to
 * GitHub is also signed into a cookie, so only the browser that started the sign-in can finish it.
 */
export async function createOAuthState(
  oauthRequest: AuthRequest,
  namespace: KVNamespace,
  secret: string,
): Promise<{ cookie: string; state: string }> {
  const state = randomToken();
  await namespace.put(`${STATE_PREFIX}${state}`, JSON.stringify(oauthRequest), { expirationTtl: STATE_TTL_SECONDS });
  return {
    cookie: hostCookie(COOKIE_NAME, await signedValue(SIGNATURE_PURPOSE, state, secret), STATE_TTL_SECONDS),
    state,
  };
}

/** Returns the stored request once. A second call with the same state fails. */
export async function consumeOAuthState(
  request: Request,
  state: string | undefined,
  namespace: KVNamespace,
  secret: string,
): Promise<AuthRequest> {
  if (!state) throw new Error("Missing OAuth state");
  const cookieState = await verifySignedValue(SIGNATURE_PURPOSE, readCookie(request, COOKIE_NAME), secret);
  if (cookieState !== state) throw new Error("Invalid OAuth session binding");

  const key = `${STATE_PREFIX}${state}`;
  const stored = await namespace.get<AuthRequest>(key, "json");
  await namespace.delete(key);
  if (!stored) throw new Error("OAuth state expired or already used");
  return stored;
}

export function clearOAuthStateCookie(): string {
  return hostCookie(COOKIE_NAME, "", 0);
}
