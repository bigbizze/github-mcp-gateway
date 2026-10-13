import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const COOKIE_NAME = "__Host-github_mcp_oauth_state";
const STATE_PREFIX = "github-oauth-state:";
const STATE_TTL_SECONDS = 10 * 60;

interface StoredOAuthState {
  oauthRequest: AuthRequest;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function signature(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(result));
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function readCookie(request: Request): string | undefined {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return undefined;
}

export async function createOAuthState(
  oauthRequest: AuthRequest,
  namespace: KVNamespace,
  secret: string,
): Promise<{ cookie: string; state: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const state = base64Url(random);
  const signed = `${state}.${await signature(state, secret)}`;
  const stored: StoredOAuthState = { oauthRequest };

  await namespace.put(`${STATE_PREFIX}${state}`, JSON.stringify(stored), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  return {
    cookie: `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`,
    state,
  };
}

export async function consumeOAuthState(
  request: Request,
  state: string | undefined,
  namespace: KVNamespace,
  secret: string,
): Promise<AuthRequest> {
  if (!state) throw new Error("Missing OAuth state");

  const cookie = readCookie(request);
  const separator = cookie?.lastIndexOf(".") ?? -1;
  if (!cookie || separator <= 0) throw new Error("Missing OAuth session binding");

  const cookieState = cookie.slice(0, separator);
  const cookieSignature = cookie.slice(separator + 1);
  const expectedSignature = await signature(cookieState, secret);
  if (
    !constantTimeEqual(cookieState, state) ||
    !constantTimeEqual(cookieSignature, expectedSignature)
  ) {
    throw new Error("Invalid OAuth session binding");
  }

  const key = `${STATE_PREFIX}${state}`;
  const stored = await namespace.get<StoredOAuthState>(key, "json");
  await namespace.delete(key);
  if (!stored?.oauthRequest) throw new Error("OAuth state expired or already used");

  return stored.oauthRequest;
}

export function clearOAuthStateCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
