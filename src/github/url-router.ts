import { GatewayError } from "../errors";
import type { OperationName } from "./catalog";

const ALLOWED_HOSTS = new Set(["api.github.com", "github.com", "raw.githubusercontent.com"]);
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/u;

export interface MappedGitHubRequest {
  arguments: Record<string, unknown>;
  operation: OperationName;
}

function invalid(message: string): never {
  throw new GatewayError("invalid_arguments", message);
}

function assertRepository(owner: string | undefined, repo: string | undefined): string {
  const normalizedRepo = repo?.replace(/\.git$/u, "");
  if (!owner || !normalizedRepo || !REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(normalizedRepo)) {
    return invalid("The GitHub URL must contain a valid owner and repository name");
  }
  return `${owner}/${normalizedRepo}`;
}

function assertQuery(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key)) invalid(`The GitHub URL query parameter '${key}' is not supported`);
  }
}

function positiveParameter(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid(`The '${name}' query parameter must be a positive integer`);
  return parsed;
}

function commonIssueArguments(url: URL, repository_full_name: string) {
  return {
    repository_full_name,
    ...(url.searchParams.get("q") ? { query: url.searchParams.get("q") } : {}),
    ...(url.searchParams.get("state") ? { state: url.searchParams.get("state") } : {}),
    ...(url.searchParams.get("assignee") ? { assignee: url.searchParams.get("assignee") } : {}),
    ...(url.searchParams.get("labels") ? { labels: url.searchParams.get("labels") } : {}),
    ...(url.searchParams.get("since") ? { since: url.searchParams.get("since") } : {}),
    ...(positiveParameter(url, "page") ? { page: positiveParameter(url, "page") } : {}),
    ...(positiveParameter(url, "per_page") ? { per_page: positiveParameter(url, "per_page") } : {}),
  };
}

function mapWebUrl(url: URL, segments: string[]): MappedGitHubRequest {
  const repository_full_name = assertRepository(segments[0], segments[1]);
  if (segments.length === 2) {
    assertQuery(url, []);
    return { arguments: { repository_full_name }, operation: "get_repository" };
  }
  const kind = segments[2];
  const value = segments[3];
  if (kind === "issues") {
    if (value !== undefined) {
      assertQuery(url, []);
      const issue_number = Number(value);
      if (!Number.isSafeInteger(issue_number) || issue_number < 1 || segments.length !== 4) {
        invalid("The GitHub issue URL is invalid");
      }
      return { arguments: { issue_number, repository_full_name }, operation: "fetch_issue" };
    }
    assertQuery(url, ["assignee", "labels", "page", "per_page", "q", "since", "state"]);
    return { arguments: commonIssueArguments(url, repository_full_name), operation: "search_issues" };
  }
  if (kind === "pull" && value !== undefined && segments.length === 4) {
    assertQuery(url, []);
    const pr_number = Number(value);
    if (!Number.isSafeInteger(pr_number) || pr_number < 1) invalid("The GitHub pull request URL is invalid");
    return { arguments: { pr_number, repository_full_name }, operation: "get_pr_info" };
  }
  if (kind === "commit" && value !== undefined && segments.length === 4) {
    assertQuery(url, []);
    return { arguments: { commit_sha: value, repository_full_name }, operation: "fetch_commit" };
  }
  if (kind === "tree" && value !== undefined) {
    assertQuery(url, []);
    if (segments.length !== 4) {
      invalid("This URL can contain a slash in its ref. Call list_directory with separate ref and path arguments");
    }
    return { arguments: { branch: value, repository_full_name }, operation: "get_branch" };
  }
  if (kind === "blob" && value !== undefined && segments.length >= 5) {
    assertQuery(url, []);
    return {
      arguments: { path: segments.slice(4).join("/"), ref: value, repository_full_name },
      operation: "fetch_file",
    };
  }
  if (kind === "actions" && segments[3] === "runs" && segments[4] !== undefined && segments.length === 5) {
    assertQuery(url, []);
    const run_id = Number(segments[4]);
    if (!Number.isSafeInteger(run_id) || run_id < 1) invalid("The workflow run URL is invalid");
    return { arguments: { repository_full_name, run_id }, operation: "fetch_workflow_run" };
  }
  return invalid("This GitHub URL does not map to a registered read operation");
}

function mapApiUrl(url: URL, segments: string[]): MappedGitHubRequest {
  if (segments[0] !== "repos") invalid("This GitHub REST URL is not allowlisted");
  const repository_full_name = assertRepository(segments[1], segments[2]);
  const kind = segments[3];
  if (segments.length === 3) {
    assertQuery(url, []);
    return { arguments: { repository_full_name }, operation: "get_repository" };
  }
  if (kind === "contents") {
    assertQuery(url, ["ref"]);
    const path = segments.slice(4).join("/");
    if (!path) {
      return {
        arguments: { path: "", ...(url.searchParams.get("ref") ? { ref: url.searchParams.get("ref") } : {}), repository_full_name },
        operation: "list_directory",
      };
    }
    return {
      arguments: { path, ...(url.searchParams.get("ref") ? { ref: url.searchParams.get("ref") } : {}), repository_full_name },
      operation: "fetch_file",
    };
  }
  if (kind === "issues") {
    if (segments[4] !== undefined) {
      assertQuery(url, []);
      const issue_number = Number(segments[4]);
      if (!Number.isSafeInteger(issue_number) || issue_number < 1 || segments.length !== 5) invalid("The issue REST URL is invalid");
      return { arguments: { issue_number, repository_full_name }, operation: "fetch_issue" };
    }
    assertQuery(url, ["assignee", "labels", "page", "per_page", "q", "since", "state"]);
    return { arguments: commonIssueArguments(url, repository_full_name), operation: "search_issues" };
  }
  if (kind === "pulls" && segments[4] !== undefined && segments.length === 5) {
    assertQuery(url, []);
    const pr_number = Number(segments[4]);
    if (!Number.isSafeInteger(pr_number) || pr_number < 1) invalid("The pull request REST URL is invalid");
    return { arguments: { pr_number, repository_full_name }, operation: "get_pr_info" };
  }
  if (kind === "commits" && segments[4] !== undefined && segments.length === 5) {
    assertQuery(url, []);
    return { arguments: { commit_sha: segments[4], repository_full_name }, operation: "fetch_commit" };
  }
  if (kind === "branches" && segments[4] !== undefined && segments.length === 5) {
    assertQuery(url, []);
    return { arguments: { branch: segments[4], repository_full_name }, operation: "get_branch" };
  }
  if (kind === "actions" && segments[4] === "runs" && segments[5] !== undefined && segments.length === 6) {
    assertQuery(url, []);
    const run_id = Number(segments[5]);
    if (!Number.isSafeInteger(run_id) || run_id < 1) invalid("The workflow run REST URL is invalid");
    return { arguments: { repository_full_name, run_id }, operation: "fetch_workflow_run" };
  }
  return invalid("This GitHub REST URL does not map to a registered read operation");
}

export function mapGitHubUrl(value: string): MappedGitHubRequest {
  if (/%(?:2f|5c|2e)/iu.test(value) || value.includes("\\")) {
    invalid("Encoded separators, encoded traversal, and backslashes are not allowed in GitHub URLs");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("The fetch URL is invalid");
  }
  if (url.protocol !== "https:") invalid("The fetch URL must use HTTPS");
  if (!ALLOWED_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    invalid("The fetch URL must use an allowlisted GitHub host without user information or a custom port");
  }
  if (url.hash) invalid("URL fragments are not supported");
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("/"))) {
    invalid("Path traversal and encoded path separators are not allowed");
  }
  if (url.hostname === "github.com") return mapWebUrl(url, segments);
  if (url.hostname === "api.github.com") return mapApiUrl(url, segments);

  assertQuery(url, []);
  const repository_full_name = assertRepository(segments[0], segments[1]);
  if (segments.length < 4) invalid("The raw GitHub URL must contain a ref and file path");
  return {
    arguments: { path: segments.slice(3).join("/"), ref: segments[2], repository_full_name },
    operation: "fetch_file",
  };
}
