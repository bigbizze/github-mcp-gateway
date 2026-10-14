import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOAuthRoute } from "../src/auth/github-oauth";
import type { WorkerEnv } from "../src/config";

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

const AUTHORIZE_URL = "https://worker.example/authorize?client_id=test-client&state=client-state";

const authRequest: AuthRequest = {
  clientId: "test-client",
  issuer: "https://worker.example",
  redirectUri: "https://client.example/callback",
  responseType: "code",
  scope: ["github:read"],
  state: "client-state",
};

const client = {
  clientId: "test-client",
  clientName: "Test <Client>",
  redirectUris: ["https://client.example/callback"],
} as ClientInfo;

function environment() {
  const parseAuthRequest = vi.fn(async () => authRequest);
  const lookupClient = vi.fn(async (): Promise<ClientInfo | null> => client);
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: "https://client.example/callback?code=connector-code",
  }));
  const env: WorkerEnv = {
    AUTHORIZED_GITHUB_LOGINS: "example-user",
    COOKIE_ENCRYPTION_KEY: "a-secure-random-value-at-least-32-characters",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key-placeholder",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    OAUTH_KV: new FakeKvNamespace() as unknown as KVNamespace,
    OAUTH_PROVIDER: { completeAuthorization, lookupClient, parseAuthRequest } as unknown as OAuthHelpers,
    REFERENCE_TOKEN_KEY: "11".repeat(32),
  };
  return { completeAuthorization, env, lookupClient, parseAuthRequest };
}

async function handle(request: Request, env: WorkerEnv): Promise<Response> {
  const response = await handleOAuthRoute(request, env);
  if (!response) throw new Error(`No OAuth route for ${request.method} ${request.url}`);
  return response;
}

/** The `name=value` pairs of every Set-Cookie header, as a browser would send them back. */
function cookies(response: Response): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    pairs.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return pairs;
}

function cookieHeader(...responses: Response[]): string {
  const merged = new Map<string, string>();
  for (const response of responses) for (const [name, value] of cookies(response)) merged.set(name, value);
  return [...merged].filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join("; ");
}

function csrfToken(html: string): string {
  const token = /name="csrf_token" value="([^"]+)"/u.exec(html)?.[1];
  if (!token) throw new Error("The consent page has no CSRF token");
  return token;
}

function decide(decision: string, csrf: string, cookie: string): Request {
  return new Request(AUTHORIZE_URL, {
    body: new URLSearchParams({ csrf_token: csrf, decision }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    method: "POST",
  });
}

async function approve(env: WorkerEnv): Promise<Response> {
  const page = await handle(new Request(AUTHORIZE_URL), env);
  return handle(decide("approve", csrfToken(await page.text()), cookieHeader(page)), env);
}

beforeEach(() => {
  octokitMocks.getAuthenticated.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("consent page", () => {
  it("asks the user to approve a client before any GitHub redirect", async () => {
    const { env } = environment();
    const response = await handle(new Request(AUTHORIZE_URL), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://github.com https://client.example",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(html).toContain("Test &lt;Client&gt;");
    expect(html).not.toContain("Test <Client>");
    expect(html).toContain("https://client.example/callback");
    expect(cookies(response).has("__Host-github_mcp_consent_csrf")).toBe(true);
  });

  it("rejects an approval whose CSRF token does not match the cookie", async () => {
    const { env } = environment();
    const page = await handle(new Request(AUTHORIZE_URL), env);
    const response = await handle(decide("approve", "forged-token", cookieHeader(page)), env);

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("returns access_denied to the client when the user denies", async () => {
    const { completeAuthorization, env } = environment();
    const page = await handle(new Request(AUTHORIZE_URL), env);
    const response = await handle(decide("deny", csrfToken(await page.text()), cookieHeader(page)), env);
    const location = new URL(response.headers.get("Location") ?? "");

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://client.example/callback");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe("https://worker.example");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("sends an approved request to GitHub and remembers the approval", async () => {
    const { env } = environment();
    const approved = await approve(env);
    const location = new URL(approved.headers.get("Location") ?? "");

    expect(approved.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("github-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe("https://worker.example/callback");
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(approved.headers.get("Cache-Control")).toBe("no-store");
    expect(cookies(approved).get("__Host-github_mcp_approved_clients")).toBeTruthy();

    const again = await handle(new Request(AUTHORIZE_URL, { headers: { Cookie: cookieHeader(approved) } }), env);
    expect(again.status).toBe(302);
    expect(again.headers.get("Location")).toContain("https://github.com/login/oauth/authorize");
  });

  it("asks again when the remembered client uses a different redirect URI", async () => {
    const { env, parseAuthRequest } = environment();
    const approved = await approve(env);
    parseAuthRequest.mockResolvedValueOnce({ ...authRequest, redirectUri: "https://other.example/callback" });

    const response = await handle(new Request(AUTHORIZE_URL, { headers: { Cookie: cookieHeader(approved) } }), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("https://other.example/callback");
  });

  it("accepts an approval from either of two open approval pages", async () => {
    const { env } = environment();
    const first = await handle(new Request(AUTHORIZE_URL), env);
    const second = await handle(new Request(AUTHORIZE_URL, { headers: { Cookie: cookieHeader(first) } }), env);

    const response = await handle(decide("approve", csrfToken(await first.text()), cookieHeader(first, second)), env);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("https://github.com/login/oauth/authorize");
  });

  it("rejects a form token that was issued for a different client request", async () => {
    const { env, parseAuthRequest } = environment();
    parseAuthRequest.mockResolvedValueOnce({ ...authRequest, clientId: "other-client" });
    const otherPage = await handle(new Request(AUTHORIZE_URL), env);

    const response = await handle(decide("approve", csrfToken(await otherPage.text()), cookieHeader(otherPage)), env);
    expect(response.status).toBe(400);
  });

  it("fails before parsing the request when required configuration is absent", async () => {
    const { env, parseAuthRequest } = environment();
    env.AUTHORIZED_GITHUB_LOGINS = "";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handle(new Request(AUTHORIZE_URL), env);

    expect(response.status).toBe(400);
    expect(parseAuthRequest).not.toHaveBeenCalled();
  });
});

describe("GitHub callback", () => {
  it("verifies the GitHub identity and completes MCP authorization", async () => {
    const { completeAuthorization, env } = environment();
    const approved = await approve(env);
    const githubLocation = new URL(approved.headers.get("Location") ?? "");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "temporary-user-token" })));
    octokitMocks.getAuthenticated.mockResolvedValueOnce({ data: { id: 42, login: "Example-User" } });

    const callback = new URL("https://worker.example/callback");
    callback.searchParams.set("code", "github-code");
    callback.searchParams.set("state", githubLocation.searchParams.get("state") ?? "");
    const response = await handle(new Request(callback, { headers: { Cookie: cookieHeader(approved) } }), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://client.example/callback?code=connector-code");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(completeAuthorization).toHaveBeenCalledWith({
      metadata: { label: "Example-User" },
      props: { githubLogin: "Example-User", githubUserId: 42 },
      request: authRequest,
      scope: ["github:read"],
      userId: "42",
    });
  });

  it("refuses a GitHub account that is not on the allowlist", async () => {
    const { completeAuthorization, env } = environment();
    const approved = await approve(env);
    const githubLocation = new URL(approved.headers.get("Location") ?? "");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "temporary-user-token" })));
    octokitMocks.getAuthenticated.mockResolvedValueOnce({ data: { id: 7, login: "someone-else" } });

    const callback = new URL("https://worker.example/callback");
    callback.searchParams.set("code", "github-code");
    callback.searchParams.set("state", githubLocation.searchParams.get("state") ?? "");
    const response = await handle(new Request(callback, { headers: { Cookie: cookieHeader(approved) } }), env);

    expect(response.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
