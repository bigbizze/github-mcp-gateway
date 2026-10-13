import { describe, expect, it } from "vitest";
import { describeOperation, operationNames, searchCatalog } from "../src/github/catalog";
import { byteLength, successEnvelope } from "../src/github/result";

describe("operation catalog", () => {
  it("registers every approved operation and omits gated workflow job logs", () => {
    expect(operationNames).toEqual([
      "list_repositories", "search_repositories", "get_repository", "get_branch", "search_code", "list_directory", "fetch_file", "fetch",
      "search_commits", "fetch_commit", "list_commit_changed_filenames", "fetch_commit_file_patch", "get_commit_combined_status",
      "search_prs", "get_pr_info", "list_pr_changed_filenames", "fetch_pr_file_patch", "list_pull_request_reviews", "list_pull_request_comments",
      "search_issues", "fetch_issue", "list_issue_comments",
      "fetch_commit_workflow_runs", "fetch_workflow_run", "fetch_workflow_run_jobs", "fetch_workflow_job_steps", "fetch_workflow_run_artifacts", "download_workflow_artifact",
      "list_organization_members", "search_organization_members", "get_organization_membership", "read_text",
    ]);
    expect(operationNames).not.toContain("fetch_workflow_job_logs");
  });

  it("uses snake_case operation names", () => {
    expect(operationNames.every((name) => /^[a-z0-9_]+$/u.test(name))).toBe(true);
  });

  it("ranks partial matches for descriptive discovery queries", () => {
    const result = searchCatalog("pull request details comments branch commit", 8, 0);
    const matches = result.matches.map((match) => match.operation);

    expect(matches[0]).toBe("list_pull_request_comments");
    expect(matches).toContain("get_pr_info");
    expect(matches).toContain("get_branch");
    expect(result.total).toBeGreaterThan(matches.length);
  });

  it("maps common audit vocabulary to the existing operations", () => {
    expect(searchCatalog("fetch content", 8, 0).matches[0]?.operation).toBe("fetch_file");
    expect(searchCatalog("commit object tree parent topology", 8, 0).matches[0]?.operation).toBe("fetch_commit");
    expect(searchCatalog("workflow status by head sha", 8, 0).matches[0]?.operation).toBe("fetch_commit_workflow_runs");
    expect(searchCatalog("archive ref exists", 8, 0).matches[0]?.operation).toBe("get_branch");
  });

  it("gives concise recovery guidance when no term matches", () => {
    expect(searchCatalog("xyzzy", 8, 0)).toMatchObject({
      hint: expect.stringContaining("fewer terms"),
      matches: [],
      total: 0,
    });
  });

  it("describes a non-empty operation-specific result schema for every operation", () => {
    for (const operation of operationNames) {
      const schema = describeOperation(operation).result_schema as {
        anyOf?: unknown[];
        properties?: Record<string, unknown>;
      };
      expect(
        (schema.properties && Object.keys(schema.properties).length > 0) ||
          (schema.anyOf && schema.anyOf.length > 0),
        operation,
      ).toBe(true);
    }
  });

  it("fits every complete description in one result envelope", () => {
    for (const operation of operationNames) {
      expect(byteLength(successEnvelope("describe", describeOperation(operation))), operation).toBeLessThanOrEqual(20_000);
    }
  });
});
