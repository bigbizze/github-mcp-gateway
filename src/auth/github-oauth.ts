import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Octokit } from "octokit";
import { type Config, ConfigurationError, isAuthorizedLogin, loadConfig, type WorkerEnv } from "../config";
import { GITHUB_API_VERSION } from "../github/session";
import { clearOAuthStateCookie, consumeOAuthState, createOAuthState } from "../security/oauth-state";
import { approvalCookie, consentPage, isApproved, verifyCsrf } from "./consent";

/** Props that the OAuth provider stores with each grant and passes to the MCP handler. */
export interface AuthProps extends Record<string, unknown> {
  githubLogin: string;
  githubUserId: number;
}

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function textResponse(message: string, status: number, cookies: string[] = []): Response {
  const headers = new Headers(noStore);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(message, { headers, status });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...noStore, Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { headers, status: 302 });
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).href;
}

/** Sends the browser to GitHub's sign-in page for the GitHub App. */
async function redirectToGitHub(request: Request, env: WorkerEnv, config: Config, oauthRequest: AuthRequest, cookies: string[] = []) {
  const { cookie, state } = await createOAuthState(oauthRequest, env.OAUTH_KV, config.cookieSecret);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.oauthClient.id);
  url.searchParams.set("redirect_uri", callbackUrl(request));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return redirect(url.href, [...cookies, cookie]);
}

/** A client redirect that reports `access_denied`, as RFC 6749 section 4.1.2.1 describes. */
function deniedRedirect(oauthRequest: AuthRequest): string {
  const url = new URL(oauthRequest.redirectUri);
  url.searchParams.set("error", "access_denied");
  if (oauthRequest.state) url.searchParams.set("state", oauthRequest.state);
  if (oauthRequest.issuer) url.searchParams.set("iss", oauthRequest.issuer);
  return url.href;
}

async function authorize(request: Request, env: WorkerEnv, config: Config): Promise<Response> {
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return textResponse("Unknown MCP client", 400);

  if (request.method === "GET") {
    if (await isApproved(request, oauthRequest, config.cookieSecret)) {
      return redirectToGitHub(request, env, config, oauthRequest);
    }
    return consentPage(request, oauthRequest, client, config.cookieSecret);
  }

  const form = await request.formData();
  const csrfToken = form.get("csrf_token");
  if (!(await verifyCsrf(request, oauthRequest, typeof csrfToken === "string" ? csrfToken : null, config.cookieSecret))) {
    return textResponse("The approval form expired. Start the connection again", 400);
  }
  if (form.get("decision") !== "approve") return redirect(deniedRedirect(oauthRequest));
  return redirectToGitHub(request, env, config, oauthRequest, [
    await approvalCookie(request, oauthRequest, config.cookieSecret),
  ]);
}

async function exchangeCode(request: Request, config: Config, code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: new URLSearchParams({
      client_id: config.oauthClient.id,
      client_secret: config.oauthClient.secret,
      code,
      redirect_uri: callbackUrl(request),
    }),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) throw new Error("GitHub rejected the authorization-code exchange");
  const result = await response.json<{ access_token?: string; error?: string }>();
  if (!result.access_token || result.error) throw new Error("GitHub did not issue a user token");
  return result.access_token;
}

/**
 * Finishes the GitHub sign-in. The GitHub user token is used once to read the username and is
 * then discarded. Only an allowed username gets an MCP grant.
 */
async function callback(request: Request, env: WorkerEnv, config: Config): Promise<Response> {
  const url = new URL(request.url);
  const clearState = clearOAuthStateCookie();
  const oauthRequest = await consumeOAuthState(request, url.searchParams.get("state") ?? undefined, env.OAUTH_KV, config.cookieSecret);
  const code = url.searchParams.get("code");
  if (!code) return textResponse("GitHub did not provide an authorization code", 400, [clearState]);

  const userToken = await exchangeCode(request, config, code);
  const { data: user } = await new Octokit({ auth: userToken }).rest.users.getAuthenticated({
    headers: { "x-github-api-version": GITHUB_API_VERSION },
  });
  if (!isAuthorizedLogin(config, user.login)) {
    return textResponse("This GitHub account is not authorized for this connector", 403, [clearState]);
  }

  const props: AuthProps = { githubLogin: user.login, githubUserId: user.id };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: user.login },
    props,
    request: oauthRequest,
    scope: oauthRequest.scope,
    userId: String(user.id),
  });
  return redirect(redirectTo, [clearState]);
}

/** Handles the browser side of sign-in: `/authorize` (consent) and `/callback` (GitHub return). */
export async function handleOAuthRoute(request: Request, env: WorkerEnv): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  const isAuthorize = pathname === "/authorize" && (request.method === "GET" || request.method === "POST");
  const isCallback = pathname === "/callback" && request.method === "GET";
  if (!isAuthorize && !isCallback) return undefined;
  try {
    const config = loadConfig(env);
    return isAuthorize ? await authorize(request, env, config) : await callback(request, env, config);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(JSON.stringify({ error: error.message, route: pathname }));
    }
    return isAuthorize
      ? textResponse("Unable to begin authorization", 400)
      : textResponse("Unable to complete authorization", 400, [clearOAuthStateCookie()]);
  }
}
