import { describe, expect, it, vi } from "vitest";
import { GitHubReader, type OctokitLike } from "../src/github/reader";
import { AesGcmTokenCodec } from "../src/security/reference-token";

describe("lazy repository installation scan", () => {
  it("continues beyond 100 installations without exceeding one-call subrequest limits", async () => {
    const appClient: OctokitLike = {
      request: vi.fn(async (route, parameters) => {
        if (route !== "GET /app/installations") throw new Error(`Unexpected app route ${route}`);
        const page = parameters?.page;
        if (page === 1) {
          return {
            data: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
            headers: { link: '<https://api.github.com/app/installations?page=2>; rel="next"' },
          };
        }
        return { data: [{ id: 101 }], headers: {} };
      }),
    };
    const emptyInstallation: OctokitLike = {
      request: vi.fn(async () => ({ data: { repositories: [] }, headers: {} })),
    };
    const finalInstallation: OctokitLike = {
      request: vi.fn(async () => ({
        data: {
          repositories: [{
            default_branch: "main",
            full_name: "owner/target-repository",
            html_url: "https://github.com/owner/target-repository",
            private: true,
          }],
        },
        headers: {},
      })),
    };
    const reader = new GitHubReader(
      { appId: "1", privateKey: "key" },
      new AesGcmTokenCodec("12".repeat(32)),
      {
        artifactBaseUrl: "https://worker.example",
        authFactory: () => async (options) => ({
          token: options.type === "app" ? "app" : `installation-${String(options.installationId)}`,
        }),
        octokitFactory: (token) => {
          if (token === "app") return appClient;
          if (token === "installation-101") return finalInstallation;
          return emptyInstallation;
        },
      },
    );

    let argumentsValue: Record<string, unknown> = { page_size: 1, query: "target" };
    let found: Array<Record<string, unknown>> = [];
    for (let request = 0; request < 20 && found.length === 0; request += 1) {
      const result = (await reader.execute("search_repositories", argumentsValue, 42)).data as {
        next_request?: { arguments: Record<string, unknown> };
        repositories: Array<Record<string, unknown>>;
      };
      found = result.repositories;
      if (found.length === 0) {
        expect(result.next_request).toBeDefined();
        argumentsValue = result.next_request?.arguments ?? {};
      }
    }

    expect(found).toEqual([expect.objectContaining({ full_name: "owner/target-repository" })]);
    expect(appClient.request).toHaveBeenCalledWith(
      "GET /app/installations",
      expect.objectContaining({ headers: { "x-github-api-version": "2026-03-10" } }),
    );
  });
});
