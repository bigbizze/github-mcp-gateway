import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { consumeOAuthState, createOAuthState } from "../src/security/oauth-state";

class FakeKvNamespace {
  readonly expirationTtls: number[] = [];
  private readonly values = new Map<string, string>();

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async get<T>(key: string, type: "json"): Promise<T | null> {
    if (type !== "json") throw new Error("Fake KV only supports JSON reads");
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.expirationTtls.push(options.expirationTtl);
  }
}

const authRequest: AuthRequest = {
  clientId: "test-client",
  redirectUri: "https://client.example/callback",
  responseType: "code",
  scope: ["github:read"],
  state: "client-state",
};

function callbackRequest(cookie: string): Request {
  return new Request("https://worker.example/callback", {
    headers: { Cookie: cookie.split(";", 1)[0] ?? "" },
  });
}

describe("OAuth state", () => {
  it("stores a short-lived state and consumes it once", async () => {
    const fakeKv = new FakeKvNamespace();
    const namespace = fakeKv as unknown as KVNamespace;
    const created = await createOAuthState(authRequest, namespace, "test-cookie-secret");

    expect(created.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.cookie).toContain("__Host-github_mcp_oauth_state=");
    expect(created.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(fakeKv.expirationTtls).toEqual([600]);

    await expect(
      consumeOAuthState(callbackRequest(created.cookie), created.state, namespace, "test-cookie-secret"),
    ).resolves.toEqual(authRequest);
    await expect(
      consumeOAuthState(callbackRequest(created.cookie), created.state, namespace, "test-cookie-secret"),
    ).rejects.toThrow("expired or already used");
  });

  it("rejects state and cookie tampering without consuming the valid state", async () => {
    const fakeKv = new FakeKvNamespace();
    const namespace = fakeKv as unknown as KVNamespace;
    const created = await createOAuthState(authRequest, namespace, "test-cookie-secret");
    const cookiePair = created.cookie.split(";", 1)[0] ?? "";
    const tamperedCookie = `${cookiePair.slice(0, -1)}${cookiePair.endsWith("A") ? "B" : "A"}`;

    await expect(
      consumeOAuthState(callbackRequest(tamperedCookie), created.state, namespace, "test-cookie-secret"),
    ).rejects.toThrow("Invalid OAuth session binding");
    await expect(
      consumeOAuthState(callbackRequest(created.cookie), `${created.state}x`, namespace, "test-cookie-secret"),
    ).rejects.toThrow("Invalid OAuth session binding");
    await expect(
      consumeOAuthState(callbackRequest(created.cookie), created.state, namespace, "test-cookie-secret"),
    ).resolves.toEqual(authRequest);
  });
});
