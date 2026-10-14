import { describe, expect, it } from "vitest";
import { runData, testReader } from "./support/reader";

describe("commit metadata", () => {
  it("returns the commit tree and parent SHAs", async () => {
    const { reader } = testReader({
      request: async (route) => {
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
      },
    });

    const result = await runData(reader, "fetch_commit", {
      commit_sha: "commit-sha",
      repository_full_name: "owner/repo",
    });

    expect(result).toMatchObject({
      commit_sha: "commit-sha",
      message: { content: "Message", state: "complete" },
      parents: ["parent-one", "parent-two"],
      tree_sha: "tree-sha",
    });
    expect((result.message as Record<string, unknown>).reference_token).toBeUndefined();
  });
});
