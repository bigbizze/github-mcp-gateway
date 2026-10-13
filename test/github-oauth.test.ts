import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubOAuthHandler } from "../src/auth/github-oauth";
import type { WorkerEnv } from "../src/types";

const octokitMocks = vi.hoisted(() => ({ getAuthenticated: vi.fn() }));

vi.mock("octokit", () => ({
  Octokit: class {
    readonly rest = { users: { getAuthenticated: octokitMocks.getAuthenticated } };
  },
}));

class FakeKvNamespace {
  private readonly values = new Map<string, string>();

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async get<T>(key: string, type: "json"): Promise<T | null> {
    if (type !== "json") throw new Error("Fake KV only supports JSON reads");
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const authRequest: AuthRequest = {
  clientId: "test-client",
  redirectUri: "https://client.example/callback",
  responseType: "code",
  scope: ["github:read"],
  state: "client-state",
};

function environment() {
  const parseAuthRequest = vi.fn(async () => authRequest);
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: "https://client.example/callback?code=connector-code",
  }));
  const oauthProvider = {
    completeAuthorization,
    parseAuthRequest,
  } as unknown as OAuthHelpers;
  const env: WorkerEnv = {
    AUTHORIZED_GITHUB_LOGINS: "example-user",
    COOKIE_ENCRYPTION_KEY: "a-secure-random-value-at-least-32-characters",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key-placeholder",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    OAUTH_KV: new FakeKvNamespace() as unknown as KVNamespace,
    OAUTH_PROVIDER: oauthProvider,
    REFERENCE_TOKEN_KEY: "11".repeat(32),
  };
  return { completeAuthorization, env, parseAuthRequest };
}

async function handle(request: Request, env: WorkerEnv): Promise<Response> {
  const fetchHandler = GitHubOAuthHandler.fetch;
  if (!fetchHandler) throw new Error("Expected the OAuth fetch handler to exist");
  return fetchHandler(
    request as unknown as Parameters<typeof fetchHandler>[0],
    env,
    {} as ExecutionContext,
  );
}

function requestCookie(response: Response): string {
  return response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
}

beforeEach(() => {
  octokitMocks.getAuthenticated.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub OAuth handler", () => {
  it("redirects a valid MCP authorization request to GitHub", async () => {
    const { env, parseAuthRequest } = environment();
    const response = await handle(new Request("https://worker.example/authorize"), env);
    const location = new URL(response.headers.get("Location") ?? "");

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("github-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe("https://worker.example/callback");
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(requestCookie(response)).toContain("__Host-github_mcp_oauth_state=");
    expect(parseAuthRequest).toHaveBeenCalledOnce();
  });

  it("fails before redirecting when required configuration is absent", async () => {
    const { env, parseAuthRequest } = environment();
    env.AUTHORIZED_GITHUB_LOGINS = "";
    const response = await handle(new Request("https://worker.example/authorize"), env);

    expect(response.status).toBe(400);
    expect(parseAuthRequest).not.toHaveBeenCalled();
  });

  it("verifies the GitHub identity and completes MCP authorization", async () => {
    const { completeAuthorization, env } = environment();
    const authorization = await handle(new Request("https://worker.example/authorize"), env);
    const githubLocation = new URL(authorization.headers.get("Location") ?? "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "temporary-user-token" })),
    );
    octokitMocks.getAuthenticated.mockResolvedValueOnce({
      data: { id: 42, login: "Example-User" },
    });

    const callback = new URL("https://worker.example/callback");
    callback.searchParams.set("code", "github-code");
    callback.searchParams.set("state", githubLocation.searchParams.get("state") ?? "");
    const response = await handle(
      new Request(callback, { headers: { Cookie: requestCookie(authorization) } }),
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://client.example/callback?code=connector-code",
    );
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(completeAuthorization).toHaveBeenCalledWith({
      metadata: { label: "Example-User" },
      props: { githubLogin: "Example-User", githubUserId: 42 },
      request: authRequest,
      scope: ["github:read"],
      userId: "42",
    });
  });
});
