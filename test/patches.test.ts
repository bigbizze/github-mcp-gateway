import { describe, expect, it, vi } from "vitest";
import { GitHubReader, type OctokitLike } from "../src/github/reader";
import { AesGcmTokenCodec } from "../src/security/reference-token";

function patchReader(request: OctokitLike["request"]): GitHubReader {
  const octokit: OctokitLike = { request };
  return new GitHubReader(
    { appId: "1", privateKey: "key" },
    new AesGcmTokenCodec("34".repeat(32)),
    {
      artifactBaseUrl: "https://worker.example",
      authFactory: () => async (options) => ({ token: options.type === "app" ? "app" : "installation" }),
      octokitFactory: () => octokit,
    },
  );
}

describe("pinned GitHub-provided file patches", () => {
  it("represents a root commit base and classifies a symbolic link", async () => {
    const reader = patchReader(vi.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 1 }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return {
          data: {
            files: [{ filename: "link", patch: "@@ -0,0 +1 @@\n+target\n", sha: "blob", status: "added" }],
            parents: [],
            sha: "root-sha",
          },
          headers: {},
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        return { data: { type: "symlink" }, headers: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    }));

    const result = (await reader.execute("fetch_commit_file_patch", {
      commit_sha: "root-sha",
      path: "link",
      repository_full_name: "owner/repo",
    }, 42)).data;

    expect(result).toMatchObject({
      base: { type: "empty" },
      commit_sha: "root-sha",
      completeness: "unverified",
      file_type: "symlink",
      repository_full_name: "owner/repo",
      source: "github",
      target: { commit_sha: "root-sha", repository_full_name: "owner/repo", type: "commit" },
    });
  });

  it("does not invent an omitted submodule patch", async () => {
    const reader = patchReader(vi.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 1 }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return {
          data: {
            files: [{ filename: "vendor/module", sha: "gitlink", status: "modified" }],
            parents: [{ sha: "base-sha" }],
            sha: "target-sha",
          },
          headers: {},
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        return { data: { submodule_git_url: "https://github.com/other/module", type: "file" }, headers: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    }));

    const result = (await reader.execute("fetch_commit_file_patch", {
      commit_sha: "target-sha",
      path: "vendor/module",
      repository_full_name: "owner/repo",
    }, 42)).data;
    expect(result).toMatchObject({
      base: { commit_sha: "base-sha", type: "commit" },
      file_type: "submodule",
      patch: null,
      patch_availability: "omitted_by_github",
    });
  });

  it("keeps fork repository descriptors and rename paths for pull requests", async () => {
    const reader = patchReader(vi.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 1 }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            base: { repo: { full_name: "upstream/repo" }, sha: "base-sha" },
            head: { repo: { full_name: "fork/repo" }, sha: "head-sha" },
          },
          headers: {},
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return {
          data: [{
            filename: "new-name.ts",
            patch: "@@ -1 +1 @@\n-old\n+new\n",
            previous_filename: "old-name.ts",
            sha: "blob",
            status: "renamed",
          }],
          headers: {},
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") return { data: { type: "file" }, headers: {} };
      throw new Error(`Unexpected route ${route}`);
    }));

    const result = (await reader.execute("fetch_pr_file_patch", {
      path: "new-name.ts",
      pr_number: 9,
      repository_full_name: "upstream/repo",
    }, 42)).data;
    expect(result).toMatchObject({
      base: { commit_sha: "base-sha", repository_full_name: "upstream/repo" },
      path: "new-name.ts",
      previous_path: "old-name.ts",
      pr_number: 9,
      status: "renamed",
      target: { commit_sha: "head-sha", repository_full_name: "fork/repo" },
    });
  });
});
