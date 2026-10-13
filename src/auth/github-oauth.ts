import { Octokit } from "octokit";
import {
  githubAppConfig,
  isAuthorizedLogin,
  referenceTokenKey,
  validateOAuthConfiguration,
} from "../config";
import { GitHubReader } from "../github/reader";
import { AesGcmTokenCodec } from "../security/reference-token";
import {
  clearOAuthStateCookie,
  consumeOAuthState,
  createOAuthState,
} from "../security/oauth-state";
import type { AuthProps, WorkerEnv } from "../types";

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
}

function githubAuthorizeUrl(request: Request, clientId: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.href;
}

async function exchangeCode(request: Request, env: WorkerEnv, code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", request.url).href,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) throw new Error("GitHub rejected the authorization-code exchange");
  const result = await response.json<GitHubTokenResponse>();
  if (!result.access_token || result.error) throw new Error("GitHub did not issue a user token");
  return result.access_token;
}

export const GitHubOAuthHandler: ExportedHandler<WorkerEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    const artifactMatch = /^\/artifacts\/v1\/([^/]+)$/u.exec(url.pathname);
    if (artifactMatch?.[1]) {
      try {
        const reader = new GitHubReader(
          githubAppConfig(env),
          new AesGcmTokenCodec(referenceTokenKey(env)),
          { artifactBaseUrl: url.origin },
        );
        return reader.handleArtifactRequest(request, artifactMatch[1]);
      } catch {
        return new Response("Artifact link is invalid or expired", {
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
          status: 404,
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/authorize") {
      try {
        validateOAuthConfiguration(env);
        const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const { cookie, state } = await createOAuthState(
          oauthRequest,
          env.OAUTH_KV,
          env.COOKIE_ENCRYPTION_KEY,
        );
        return new Response(null, {
          headers: {
            "Cache-Control": "no-store",
            Location: githubAuthorizeUrl(request, env.GITHUB_CLIENT_ID, state),
            "Referrer-Policy": "no-referrer",
            "Set-Cookie": cookie,
          },
          status: 302,
        });
      } catch {
        return new Response("Unable to begin authorization", { status: 400 });
      }
    }

    if (request.method === "GET" && url.pathname === "/callback") {
      try {
        validateOAuthConfiguration(env);
        const oauthRequest = await consumeOAuthState(
          request,
          url.searchParams.get("state") ?? undefined,
          env.OAUTH_KV,
          env.COOKIE_ENCRYPTION_KEY,
        );
        const code = url.searchParams.get("code");
        if (!code) return new Response("GitHub did not provide an authorization code", { status: 400 });

        const userToken = await exchangeCode(request, env, code);
        const userResponse = await new Octokit({ auth: userToken }).rest.users.getAuthenticated({
          headers: { "x-github-api-version": "2026-03-10" },
        });
        const { id, login } = userResponse.data;
        if (!isAuthorizedLogin(env.AUTHORIZED_GITHUB_LOGINS, login)) {
          return new Response("This GitHub account is not authorized for this connector", {
            headers: { "Set-Cookie": clearOAuthStateCookie() },
            status: 403,
          });
        }

        const props: AuthProps = { githubLogin: login, githubUserId: id };
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          metadata: { label: login },
          props,
          request: oauthRequest,
          scope: oauthRequest.scope,
          userId: String(id),
        });

        return new Response(null, {
          headers: {
            "Cache-Control": "no-store",
            Location: redirectTo,
            "Referrer-Policy": "no-referrer",
            "Set-Cookie": clearOAuthStateCookie(),
          },
          status: 302,
        });
      } catch {
        return new Response("Unable to complete authorization", {
          headers: { "Set-Cookie": clearOAuthStateCookie() },
          status: 400,
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
