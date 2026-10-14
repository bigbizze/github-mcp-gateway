import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import {
  base64Url,
  constantTimeEqual,
  hostCookie,
  randomToken,
  readCookie,
  sign,
  signedValue,
  verifySignedValue,
} from "../security/cookies";

const APPROVALS_COOKIE = "__Host-github_mcp_approved_clients";
const APPROVALS_PURPOSE = "approved-clients";
const APPROVALS_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_REMEMBERED_CLIENTS = 20;
const APPROVAL_SEPARATOR = "~";
const CSRF_COOKIE = "__Host-github_mcp_consent_csrf";
const CSRF_COOKIE_PURPOSE = "consent-csrf-cookie";
const CSRF_FORM_PURPOSE = "consent-csrf-form";
const CSRF_TTL_SECONDS = 10 * 60;
const encoder = new TextEncoder();

/**
 * Browsers apply `form-action` to the redirect that follows the form POST, so the policy must
 * allow GitHub (approve) and the client's redirect URI (deny) as well as this Worker.
 */
function contentSecurityPolicy(redirectUri: URL): string {
  const clientSource = redirectUri.origin === "null" ? redirectUri.protocol : redirectUri.origin;
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action 'self' https://github.com ${clientSource}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The approval key binds a client ID to one redirect URI, so a new redirect URI needs approval
 * again. It is a 128-bit SHA-256 prefix, so the cookie has a fixed size for any client ID.
 */
async function approvalKey(oauthRequest: AuthRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify([oauthRequest.clientId, oauthRequest.redirectUri])),
  );
  return base64Url(new Uint8Array(digest).slice(0, 16));
}

async function approvedKeys(request: Request, secret: string): Promise<string[]> {
  const value = await verifySignedValue(APPROVALS_PURPOSE, readCookie(request, APPROVALS_COOKIE), secret);
  return value ? value.split(APPROVAL_SEPARATOR).filter(Boolean) : [];
}

/** True when this browser approved the client and redirect URI before. */
export async function isApproved(request: Request, oauthRequest: AuthRequest, secret: string): Promise<boolean> {
  return (await approvedKeys(request, secret)).includes(await approvalKey(oauthRequest));
}

/** A cookie that remembers this approval, together with up to 19 earlier approvals. */
export async function approvalCookie(request: Request, oauthRequest: AuthRequest, secret: string): Promise<string> {
  const key = await approvalKey(oauthRequest);
  const keys = [key, ...(await approvedKeys(request, secret)).filter((existing) => existing !== key)].slice(0, MAX_REMEMBERED_CLIENTS);
  const value = keys.join(APPROVAL_SEPARATOR);
  return hostCookie(APPROVALS_COOKIE, await signedValue(APPROVALS_PURPOSE, value, secret), APPROVALS_TTL_SECONDS);
}

/**
 * The form token is an HMAC of the browser's CSRF nonce and the request being approved. One
 * nonce serves every approval page that is open in the browser, so two tabs do not conflict,
 * and a token for one client cannot approve another.
 */
async function formToken(nonce: string, oauthRequest: AuthRequest, secret: string): Promise<string> {
  return sign(CSRF_FORM_PURPOSE, `${nonce}\0${await approvalKey(oauthRequest)}`, secret);
}

async function csrfNonce(request: Request, secret: string): Promise<string | undefined> {
  return verifySignedValue(CSRF_COOKIE_PURPOSE, readCookie(request, CSRF_COOKIE), secret);
}

/** Checks the CSRF token of the approval form against the browser's nonce cookie and the request. */
export async function verifyCsrf(
  request: Request,
  oauthRequest: AuthRequest,
  token: string | null,
  secret: string,
): Promise<boolean> {
  const nonce = await csrfNonce(request, secret);
  if (!nonce || !token) return false;
  return constantTimeEqual(token, await formToken(nonce, oauthRequest, secret));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The page that asks the user to approve an MCP client. Without it, any registered client
 * could start a sign-in and receive a token for a user who approved this GitHub App before.
 */
export async function consentPage(
  request: Request,
  oauthRequest: AuthRequest,
  client: ClientInfo,
  secret: string,
): Promise<Response> {
  const nonce = (await csrfNonce(request, secret)) ?? randomToken();
  const csrf = await formToken(nonce, oauthRequest, secret);
  const name = client.clientName?.trim() || "An unnamed MCP client";
  const redirectUri = new URL(oauthRequest.redirectUri);
  const redirectHost = redirectUri.host || oauthRequest.redirectUri;
  const action = new URL(request.url);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve MCP client</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f2328}
code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer}
button[value=approve]{background:#1f883d;border-color:#1f883d;color:#fff}
</style>
</head>
<body>
<h1>Approve MCP client</h1>
<p><strong>${escapeHtml(name)}</strong> wants read access to the GitHub repositories that this server can read.</p>
<p>After you approve, you sign in with GitHub. The client then receives an access token at:</p>
<p><code>${escapeHtml(oauthRequest.redirectUri)}</code></p>
<p>Approve only if you started this connection and you trust <code>${escapeHtml(redirectHost)}</code>.</p>
<form method="post" action="${escapeHtml(action.pathname + action.search)}">
<input type="hidden" name="csrf_token" value="${csrf}">
<div class="actions">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy(redirectUri),
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": hostCookie(CSRF_COOKIE, await signedValue(CSRF_COOKIE_PURPOSE, nonce, secret), CSRF_TTL_SECONDS),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
