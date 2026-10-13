import { describe, expect, it } from "vitest";
import { mapGitHubUrl } from "../src/github/url-router";

describe("strict generic GitHub URL routing", () => {
  it.each([
    ["https://github.com/owner/repo", "get_repository"],
    ["https://github.com/owner/repo/issues", "search_issues"],
    ["https://github.com/owner/repo/issues/12", "fetch_issue"],
    ["https://github.com/owner/repo/pull/13", "get_pr_info"],
    ["https://github.com/owner/repo/commit/abc", "fetch_commit"],
    ["https://github.com/owner/repo/tree/main", "get_branch"],
    ["https://github.com/owner/repo/blob/main/src/file.ts", "fetch_file"],
    ["https://github.com/owner/repo/actions/runs/15", "fetch_workflow_run"],
    ["https://api.github.com/repos/owner/repo/contents/src/file.ts?ref=main", "fetch_file"],
    ["https://raw.githubusercontent.com/owner/repo/main/file.ts", "fetch_file"],
  ])("maps %s to %s", (url, operation) => {
    expect(mapGitHubUrl(url).operation).toBe(operation);
  });

  it.each([
    "http://github.com/owner/repo",
    "https://example.com/owner/repo",
    "https://user@github.com/owner/repo",
    "https://github.com:444/owner/repo",
    "https://github.com/owner/repo#fragment",
    "https://github.com/owner/repo?token=secret",
    "https://github.com/owner/repo/%2e%2e/secret",
    "https://github.com/owner/repo/blob/feature%2Fbranch/file.ts",
    "https://api.github.com/users/someone",
    "https://github.com/owner/repo/tree/feature/branch/src",
  ])("rejects unsafe or unsupported URL %s", (url) => {
    expect(() => mapGitHubUrl(url)).toThrow();
  });
});
