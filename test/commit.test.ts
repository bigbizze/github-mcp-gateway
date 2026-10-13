import { describe, expect, it, vi } from "vitest";
import { GitHubReader, type OctokitLike } from "../src/github/reader";
import { AesGcmTokenCodec } from "../src/security/reference-token";

describe("commit metadata", () => {
  it("returns the commit tree and parent SHAs", async () => {
    const octokit: OctokitLike = {
      request: vi.fn(async (route) => {
        if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 1 }, headers: {} };
        if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
          return {
            data: {
              author: { login: "author" },
              commit: {
                author: { date: "2026-01-01T00:00:00Z", name: "Author" },
                message: "Message",
                tree: { sha: "tree-sha" },
              },
              html_url: "https://github.com/owner/repo/commit/commit-sha",
              parents: [{ sha: "parent-one" }, { sha: "parent-two" }],
              sha: "commit-sha",
              stats: { additions: 1, deletions: 2, total: 3 },
            },
            headers: {},
          };
        }
        throw new Error(`Unexpected route ${route}`);
      }),
    };
    const reader = new GitHubReader(
      { appId: "1", privateKey: "key" },
      new AesGcmTokenCodec("78".repeat(32)),
      {
        artifactBaseUrl: "https://worker.example",
        authFactory: () => async (options) => ({ token: options.type === "app" ? "app" : "installation" }),
        octokitFactory: () => octokit,
      },
    );

    const result = (await reader.execute("fetch_commit", {
      commit_sha: "commit-sha",
      repository_full_name: "owner/repo",
    }, 42)).data;

    expect(result).toMatchObject({
      commit_sha: "commit-sha",
      message: { content: "Message", state: "complete" },
      parents: ["parent-one", "parent-two"],
      tree_sha: "tree-sha",
    });
    expect((result as { message: Record<string, unknown> }).message.reference_token).toBeUndefined();
  });
});
