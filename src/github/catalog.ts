import { z } from "zod";
import { invalidArguments } from "../errors";

const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .describe("Repository in owner/name format.");
const positive = z.number().int().min(1);
const page = positive.default(1);
const standardPerPage = positive.max(20).default(20);
const commentPerPage = positive.max(10).default(10);
const continuationToken = z.string().min(1);
const dateTime = z.iso.datetime({ offset: true });
const qualifierValue = z
  .string()
  .regex(/^[^\s"]+$/u, "Must be one value without spaces or quotes")
  .describe("One search qualifier value. It cannot contain spaces or quotes.");

const nextRequestSchema = z.strictObject({
  action: z.literal("execute"),
  arguments: z.record(z.string(), z.unknown()),
  operation: z.string(),
});
const paginationSchema = z.strictObject({
  has_next: z.boolean(),
  page: positive,
  per_page: positive,
  returned: z.number().int().min(0),
});
const collectionResult = (key: string, item: z.ZodType, metadata: z.ZodRawShape = {}) =>
  z.strictObject({
    ...metadata,
    [key]: z.array(item),
    next_request: nextRequestSchema.optional(),
    pagination: paginationSchema.optional(),
    state: z.enum(["complete", "partial", "seeking"]).optional(),
  });
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const repositoryItem = z.strictObject({
  default_branch: nullableString,
  full_name: nullableString,
  private: z.boolean(),
  url: nullableString,
});
const repositoryResult = repositoryItem.extend({
  archived: z.boolean(),
  created_at: nullableString,
  description: nullableString,
  fork: z.boolean(),
  language: nullableString,
  pushed_at: nullableString,
  size_kib: nullableNumber,
  updated_at: nullableString,
  visibility: nullableString,
});
const branchResult = z.strictObject({
  commit_sha: nullableString,
  name: nullableString,
  protected: z.boolean(),
  repository_full_name: z.string(),
});
const codeItem = z.strictObject({
  name: nullableString,
  path: nullableString,
  repository_full_name: nullableString,
  sha: nullableString,
  url: nullableString,
});
const directoryEntry = z.strictObject({
  name: nullableString,
  path: nullableString,
  sha: nullableString,
  size: nullableNumber,
  type: nullableString,
  url: nullableString,
});
const fileResult = z.strictObject({
  binary: z.boolean().nullable().optional(),
  blob_sha: nullableString,
  commit_sha: nullableString,
  content: z.string().optional(),
  content_available: z.boolean().optional(),
  end_line: positive.optional(),
  next_request: nextRequestSchema.optional(),
  path: nullableString,
  reason: z.string().optional(),
  repository_full_name: nullableString,
  size: nullableNumber,
  start_line: positive.optional(),
  state: z.enum(["complete", "partial", "seeking", "eof"]),
  total_lines: z.number().int().min(0).optional(),
  url: nullableString,
});
const commitItem = z.strictObject({
  author: nullableString,
  authored_at: nullableString,
  commit_sha: nullableString,
  message_first_line: z.string(),
  message_reference_token: z.string(),
  url: nullableString,
});
const changedFileItem = z.strictObject({
  additions: nullableNumber,
  blob_sha: nullableString,
  changes: nullableNumber,
  deletions: nullableNumber,
  path: nullableString,
  previous_path: nullableString,
  status: nullableString,
  url: nullableString,
});
const textWindow = z.strictObject({
  content: z.string().nullable().optional(),
  end_line: positive.optional(),
  next_request: nextRequestSchema.optional(),
  reference_token: z.string().optional(),
  start_line: positive.optional(),
  state: z.enum(["complete", "partial", "seeking", "eof"]),
  total_lines: z.number().int().min(0).optional(),
});
const pinnedDescriptor = z.union([
  z.strictObject({ type: z.literal("empty") }),
  z.strictObject({ commit_sha: nullableString, repository_full_name: nullableString, type: z.literal("commit") }),
]);
const patchResult = z.strictObject({
  base: pinnedDescriptor,
  blob_sha: nullableString,
  commit_sha: nullableString.optional(),
  completeness: z.literal("unverified"),
  file_type: z.string(),
  patch: textWindow.nullable(),
  patch_availability: z.literal("omitted_by_github").optional(),
  path: z.string(),
  previous_path: nullableString,
  pr_number: z.number().int().positive().optional(),
  repository_full_name: z.string(),
  source: z.literal("github"),
  status: nullableString,
  target: pinnedDescriptor,
});
const pullRequestItem = z.strictObject({
  author: nullableString,
  base: nullableString,
  created_at: nullableString,
  draft: z.boolean(),
  head: nullableString,
  pr_number: nullableNumber,
  state: nullableString,
  title: nullableString,
  updated_at: nullableString,
  url: nullableString,
});
const issueItem = z.strictObject({
  assignees: z.array(nullableString),
  author: nullableString,
  created_at: nullableString,
  issue_number: nullableNumber,
  labels: z.array(nullableString),
  state: nullableString,
  title: nullableString,
  updated_at: nullableString,
  url: nullableString,
});
const commentItem = z.strictObject({
  author: nullableString,
  body_reference_token: z.string(),
  comment_id: nullableNumber,
  created_at: nullableString,
  updated_at: nullableString,
  url: nullableString,
});
const reviewItem = z.strictObject({
  author: nullableString,
  body_reference_token: z.string(),
  commit_sha: nullableString,
  review_id: nullableNumber,
  state: nullableString,
  submitted_at: nullableString,
  url: nullableString,
});
const workflowRunItem = z.strictObject({
  attempt: nullableNumber,
  conclusion: nullableString,
  created_at: nullableString,
  event: nullableString,
  head_branch: nullableString,
  head_sha: nullableString,
  name: nullableString,
  run_id: nullableNumber,
  run_number: nullableNumber,
  status: nullableString,
  updated_at: nullableString,
  url: nullableString,
  workflow_id: nullableNumber,
});
const workflowJobItem = z.strictObject({
  completed_at: nullableString,
  conclusion: nullableString,
  head_sha: nullableString,
  job_id: nullableNumber,
  name: nullableString,
  runner_group_name: nullableString,
  runner_name: nullableString,
  started_at: nullableString,
  status: nullableString,
  url: nullableString,
});
const workflowStepItem = z.strictObject({
  completed_at: nullableString,
  conclusion: nullableString,
  name: nullableString,
  number: nullableNumber,
  started_at: nullableString,
  status: nullableString,
});
const artifactItem = z.strictObject({
  artifact_id: nullableNumber,
  created_at: nullableString,
  expired: z.boolean(),
  expires_at: nullableString,
  name: nullableString,
  size_in_bytes: nullableNumber,
  updated_at: nullableString,
});
const memberItem = z.strictObject({
  avatar_url: nullableString,
  type: nullableString,
  url: nullableString,
  username: nullableString,
});
const commitResult = z.strictObject({
  author: nullableString,
  authored_at: nullableString,
  commit_sha: nullableString,
  message: textWindow,
  parents: z.array(nullableString),
  repository_full_name: z.string(),
  stats: z.strictObject({ additions: z.number(), deletions: z.number(), total: z.number() }).nullable(),
  tree_sha: nullableString,
  url: nullableString,
});
const statusItem = z.strictObject({
  context: nullableString,
  created_at: nullableString,
  creator: nullableString,
  description: nullableString,
  state: nullableString,
  target_url: nullableString,
  updated_at: nullableString,
});
const refDescriptor = z.strictObject({
  commit_sha: nullableString,
  ref: nullableString,
  repository_full_name: nullableString,
});
const pullRequestResult = z.strictObject({
  additions: nullableNumber,
  author: nullableString,
  base: refDescriptor,
  body: textWindow,
  changed_files: nullableNumber,
  commits: nullableNumber,
  created_at: nullableString,
  deletions: nullableNumber,
  draft: z.boolean(),
  head: refDescriptor,
  mergeable: z.union([z.boolean(), z.null()]),
  merged: z.boolean(),
  pr_number: nullableNumber,
  state: nullableString,
  title: nullableString,
  updated_at: nullableString,
  url: nullableString,
});
const issueResult = issueItem.extend({ body: textWindow });
const workflowRunResult = workflowRunItem.extend({
  actor: nullableString,
  cancel_url: nullableString,
  check_suite_id: nullableNumber,
  jobs_url: nullableString,
  logs_url: nullableString,
  repository_full_name: z.string(),
  rerun_url: nullableString,
  workflow_url: nullableString,
});
const artifactDownloadResult = artifactItem.extend({
  bearer_credential: z.literal(true),
  expires_in_seconds: z.number().int().positive(),
  uri: z.url(),
});
const membershipResult = z.strictObject({
  organization: z.string(),
  organization_url: nullableString,
  role: nullableString,
  state: nullableString,
  username: z.string(),
});

export interface OperationDefinition {
  description: string;
  input: z.ZodType;
  result: z.ZodType;
  signature: string;
}

const fileInitial = z
  .object({
    end_line: positive.optional(),
    path: z.string().min(1),
    ref: z.string().min(1).optional(),
    repository_full_name: repository,
    start_line: positive.optional(),
  })
  .refine((value) => value.end_line === undefined || value.start_line === undefined || value.end_line >= value.start_line, {
    message: "end_line must be greater than or equal to start_line",
    path: ["end_line"],
  });

export const operationCatalog = {
  list_repositories: {
    description: "List repositories from GitHub App installations with a bounded lazy scan.",
    input: z.strictObject({ continuation_token: continuationToken.optional(), page_size: positive.max(20).default(20) }),
    result: collectionResult("repositories", repositoryItem, {
      state: z.enum(["complete", "partial", "seeking"]),
    }),
    signature: "list_repositories(page_size?, continuation_token?)",
  },
  search_repositories: {
    description: "Search installed repository names with a bounded lazy scan.",
    input: z.strictObject({
      continuation_token: continuationToken.optional(),
      page_size: positive.max(20).default(20),
      query: z.string().min(1),
    }),
    result: collectionResult("repositories", repositoryItem, {
      state: z.enum(["complete", "partial", "seeking"]),
    }),
    signature: "search_repositories(query, page_size?, continuation_token?)",
  },
  get_repository: {
    description: "Get metadata for one installed repository.",
    input: z.strictObject({ repository_full_name: repository }),
    result: repositoryResult,
    signature: "get_repository(repository_full_name)",
  },
  get_branch: {
    description: "Get one named branch/ref and its pinned commit SHA; verifies that it exists.",
    input: z.strictObject({ branch: z.string().min(1), repository_full_name: repository }),
    result: branchResult,
    signature: "get_branch(repository_full_name, branch)",
  },
  search_code: {
    description: "Search code within one installed repository.",
    input: z.strictObject({
      page,
      per_page: standardPerPage,
      query: z.string().min(1),
      repository_full_name: repository,
    }),
    result: collectionResult("items", codeItem, { total_count: nullableNumber }),
    signature: "search_code(repository_full_name, query, page?, per_page?)",
  },
  list_directory: {
    description: "List one directory with local offset pagination.",
    input: z.strictObject({
      limit: positive.max(50).default(20),
      offset: z.number().int().min(0).default(0),
      path: z.string().default(""),
      ref: z.string().min(1).optional(),
      repository_full_name: repository,
    }),
    result: collectionResult("entries", directoryEntry, {
      completeness: z.enum(["complete", "unknown"]),
      next_offset: z.number().int().min(0).nullable(),
      path: z.string(),
      repository_full_name: z.string(),
      total_entries: z.number().int().min(0),
    }),
    signature: "list_directory(repository_full_name, path?, ref?, offset?, limit?)",
  },
  fetch_file: {
    description: "Read file content by line (max 16,000 UTF-8 bytes/result). Without end_line, overflow returns state=partial with next_request. With end_line, overflow returns range_too_large. One-line overflow returns line_too_large.",
    input: z.union([fileInitial, z.strictObject({ continuation_token: continuationToken })]),
    result: fileResult,
    signature: "fetch_file(initial_request | continuation_token)",
  },
  fetch: {
    description: "Map one allowlisted GitHub HTTPS URL to a catalog operation.",
    input: z.strictObject({ url: z.url() }),
    result: z.union([
      repositoryResult,
      branchResult,
      fileResult,
      commitResult,
      pullRequestResult,
      issueResult,
      workflowRunResult,
      collectionResult("entries", directoryEntry),
      collectionResult("issues", issueItem),
    ]),
    signature: "fetch(url)",
  },
  search_commits: {
    description: "Search or list commits in one repository.",
    input: z.strictObject({
      page,
      path: z.string().min(1).optional(),
      per_page: standardPerPage,
      query: z.string().min(1).optional(),
      ref: z.string().min(1).optional(),
      repository_full_name: repository,
      since: dateTime.optional(),
      until: dateTime.optional(),
    }),
    result: collectionResult("commits", commitItem),
    signature: "search_commits(repository_full_name, query?, ref?, path?, since?, until?, page?, per_page?)",
  },
  fetch_commit: {
    description: "Get one pinned commit object with its tree SHA and parent SHAs, without its file list.",
    input: z.strictObject({ commit_sha: z.string().min(1), repository_full_name: repository }),
    result: commitResult,
    signature: "fetch_commit(repository_full_name, commit_sha)",
  },
  list_commit_changed_filenames: {
    description: "List changed filenames for one commit.",
    input: z.strictObject({ commit_sha: z.string().min(1), page, per_page: standardPerPage, repository_full_name: repository }),
    result: collectionResult("files", changedFileItem, { commit_sha: nullableString }),
    signature: "list_commit_changed_filenames(repository_full_name, commit_sha, page?, per_page?)",
  },
  fetch_commit_file_patch: {
    description: "Return GitHub's patch for one exact changed commit path when available.",
    input: z.strictObject({ commit_sha: z.string().min(1), path: z.string().min(1), repository_full_name: repository }),
    result: patchResult,
    signature: "fetch_commit_file_patch(repository_full_name, commit_sha, path)",
  },
  get_commit_combined_status: {
    description: "Get the combined commit status and one bounded status page.",
    input: z.strictObject({ page, per_page: standardPerPage, ref: z.string().min(1), repository_full_name: repository }),
    result: z.strictObject({
      commit_sha: nullableString,
      next_request: nextRequestSchema.optional(),
      pagination: paginationSchema,
      repository_full_name: z.string(),
      state: nullableString,
      statuses: z.array(statusItem),
      total_count: nullableNumber,
    }),
    signature: "get_commit_combined_status(repository_full_name, ref, page?, per_page?)",
  },
  search_prs: {
    description: "Search or list pull requests.",
    input: z.strictObject({
      base: qualifierValue.optional(),
      head: qualifierValue.optional(),
      page,
      per_page: standardPerPage,
      query: z.string().min(1).optional(),
      repository_full_name: repository,
      state: z.enum(["open", "closed", "all"]).default("open"),
    }),
    result: collectionResult("pull_requests", pullRequestItem),
    signature: "search_prs(repository_full_name, query?, state?, base?, head?, page?, per_page?)",
  },
  get_pr_info: {
    description: "Get pull request metadata with an inline body window.",
    input: z.strictObject({ pr_number: positive, repository_full_name: repository }),
    result: pullRequestResult,
    signature: "get_pr_info(repository_full_name, pr_number)",
  },
  list_pr_changed_filenames: {
    description: "List changed filenames for one pull request.",
    input: z.strictObject({ page, per_page: standardPerPage, pr_number: positive, repository_full_name: repository }),
    result: collectionResult("files", changedFileItem, { pr_number: z.number().int().positive() }),
    signature: "list_pr_changed_filenames(repository_full_name, pr_number, page?, per_page?)",
  },
  fetch_pr_file_patch: {
    description: "Return GitHub's patch for one exact changed pull request path when available.",
    input: z.strictObject({ path: z.string().min(1), pr_number: positive, repository_full_name: repository }),
    result: patchResult,
    signature: "fetch_pr_file_patch(repository_full_name, pr_number, path)",
  },
  list_pull_request_reviews: {
    description: "List pull request review metadata and body reference tokens.",
    input: z.strictObject({ page, per_page: commentPerPage, pr_number: positive, repository_full_name: repository }),
    result: collectionResult("reviews", reviewItem, { pr_number: z.number().int().positive() }),
    signature: "list_pull_request_reviews(repository_full_name, pr_number, page?, per_page?)",
  },
  list_pull_request_comments: {
    description: "List pull request conversation comment metadata and body reference tokens.",
    input: z.strictObject({ page, per_page: commentPerPage, pr_number: positive, repository_full_name: repository }),
    result: collectionResult("comments", commentItem, { pr_number: z.number().int().positive() }),
    signature: "list_pull_request_comments(repository_full_name, pr_number, page?, per_page?)",
  },
  search_issues: {
    description: "Search or list issues without pull requests.",
    input: z.strictObject({
      assignee: qualifierValue.optional(),
      labels: z.string().min(1).optional(),
      page,
      per_page: standardPerPage,
      query: z.string().min(1).optional(),
      repository_full_name: repository,
      since: dateTime.optional(),
      state: z.enum(["open", "closed", "all"]).default("open"),
    }),
    result: collectionResult("issues", issueItem, {
      state: z.enum(["complete", "partial", "seeking"]),
    }),
    signature: "search_issues(repository_full_name, query?, state?, assignee?, labels?, since?, page?, per_page?)",
  },
  fetch_issue: {
    description: "Get issue metadata with an inline body window.",
    input: z.strictObject({ issue_number: positive, repository_full_name: repository }),
    result: issueResult,
    signature: "fetch_issue(repository_full_name, issue_number)",
  },
  list_issue_comments: {
    description: "List issue comment metadata and body reference tokens.",
    input: z.strictObject({ issue_number: positive, page, per_page: commentPerPage, repository_full_name: repository }),
    result: collectionResult("comments", commentItem, { issue_number: z.number().int().positive() }),
    signature: "list_issue_comments(repository_full_name, issue_number, page?, per_page?)",
  },
  fetch_commit_workflow_runs: {
    description: "List workflow-run status for one head commit SHA.",
    input: z.strictObject({ commit_sha: z.string().min(1), page, per_page: standardPerPage, repository_full_name: repository }),
    result: collectionResult("workflow_runs", workflowRunItem, {
      commit_sha: z.string(),
      total_count: nullableNumber,
    }),
    signature: "fetch_commit_workflow_runs(repository_full_name, commit_sha, page?, per_page?)",
  },
  fetch_workflow_run: {
    description: "Get one workflow run without jobs or artifacts.",
    input: z.strictObject({ repository_full_name: repository, run_id: positive }),
    result: workflowRunResult,
    signature: "fetch_workflow_run(repository_full_name, run_id)",
  },
  fetch_workflow_run_jobs: {
    description: "List workflow jobs without embedded steps.",
    input: z.strictObject({
      filter: z.enum(["latest", "all"]).default("latest"),
      page,
      per_page: standardPerPage,
      repository_full_name: repository,
      run_id: positive,
    }),
    result: collectionResult("jobs", workflowJobItem, {
      run_id: z.number().int().positive(),
      total_count: nullableNumber,
    }),
    signature: "fetch_workflow_run_jobs(repository_full_name, run_id, filter?, page?, per_page?)",
  },
  fetch_workflow_job_steps: {
    description: "Read embedded workflow job steps with local offset pagination.",
    input: z.strictObject({ job_id: positive, limit: positive.max(50).default(20), offset: z.number().int().min(0).default(0), repository_full_name: repository }),
    result: collectionResult("steps", workflowStepItem, {
      job_id: z.number().int().positive(),
      next_offset: z.number().int().min(0).nullable(),
      total_steps: z.number().int().min(0),
    }),
    signature: "fetch_workflow_job_steps(repository_full_name, job_id, offset?, limit?)",
  },
  fetch_workflow_run_artifacts: {
    description: "List workflow artifacts without downloading ZIP data.",
    input: z.strictObject({ name: z.string().min(1).optional(), page, per_page: standardPerPage, repository_full_name: repository, run_id: positive }),
    result: collectionResult("artifacts", artifactItem, {
      run_id: z.number().int().positive(),
      total_count: nullableNumber,
    }),
    signature: "fetch_workflow_run_artifacts(repository_full_name, run_id, name?, page?, per_page?)",
  },
  download_workflow_artifact: {
    description: "Create a five-minute signed resource link for one whole artifact ZIP.",
    input: z.strictObject({ artifact_id: positive, repository_full_name: repository }),
    result: artifactDownloadResult,
    signature: "download_workflow_artifact(repository_full_name, artifact_id)",
  },
  list_organization_members: {
    description: "List public and visible organization members.",
    input: z.strictObject({ organization: z.string().min(1), page, per_page: standardPerPage }),
    result: collectionResult("members", memberItem, { organization: z.string() }),
    signature: "list_organization_members(organization, page?, per_page?)",
  },
  search_organization_members: {
    description: "Search visible organization members with a bounded scan.",
    input: z.strictObject({ continuation_token: continuationToken.optional(), organization: z.string().min(1), page_size: positive.max(20).default(20), query: z.string().min(1) }),
    result: collectionResult("members", memberItem, {
      organization: z.string(),
      state: z.enum(["complete", "partial", "seeking"]),
    }),
    signature: "search_organization_members(organization, query, page_size?, continuation_token?)",
  },
  get_organization_membership: {
    description: "Get one visible organization membership.",
    input: z.strictObject({ organization: z.string().min(1), username: z.string().min(1) }),
    result: membershipResult,
    signature: "get_organization_membership(organization, username)",
  },
  read_text: {
    description: "Read an exact text line range or continue a prior text window.",
    input: z.union([
      z.strictObject({ end_line: positive.optional(), reference_token: continuationToken, start_line: positive.optional() }).refine(
        (value) => value.end_line === undefined || value.start_line === undefined || value.end_line >= value.start_line,
        { message: "end_line must be greater than or equal to start_line", path: ["end_line"] },
      ),
      z.strictObject({ continuation_token: continuationToken }),
    ]),
    result: textWindow,
    signature: "read_text(reference_token, start_line?, end_line?) | read_text(continuation_token)",
  },
} as const satisfies Record<string, OperationDefinition>;

export type OperationName = keyof typeof operationCatalog;

/** The validated arguments of one operation, with defaults applied. */
export type OperationInput<N extends OperationName> = z.output<(typeof operationCatalog)[N]["input"]>;

/** One validated operation request. Only `parseOperation` creates values of this type. */
export type OperationCall = {
  [N in OperationName]: { arguments: OperationInput<N>; operation: N };
}[OperationName];

export const operationNames = Object.keys(operationCatalog) as OperationName[];

const catalogSearchAliases: Partial<Record<OperationName, string>> = {
  fetch_commit: "lookup object tree parent topology merge",
  fetch_commit_workflow_runs: "actions ci checks head sha status",
  fetch_file: "content source bytes",
  get_branch: "ref refs exists archive lookup",
};

export function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(operationCatalog, value);
}

export function parseOperationName(value: string): OperationName {
  if (!isOperationName(value)) throw invalidArguments(`Unknown operation '${value}'`);
  return value;
}

function validationMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "The operation arguments are invalid";
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

/** Validates arguments against the operation's input schema and applies its defaults. */
export function parseOperation(operation: string, argumentsValue: unknown): OperationCall {
  const name = parseOperationName(operation);
  const parsed = operationCatalog[name].input.safeParse(argumentsValue);
  if (!parsed.success) throw invalidArguments(validationMessage(parsed.error));
  return { arguments: parsed.data, operation: name } as OperationCall;
}

export const githubToolInputSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("search"), limit: positive.max(20).default(8), offset: z.number().int().min(0).default(0), query: z.string().min(1) })
    .describe("Use only when the operation name is unknown. Returns concise signatures that are usually sufficient for execute."),
  z
    .object({ action: z.literal("describe"), operation: z.string().min(1) })
    .describe("Use only when an operation signature is insufficient. Returns the complete input and result schemas."),
  z
    .object({ action: z.literal("execute"), arguments: z.record(z.string(), z.unknown()), operation: z.string().min(1) })
    .describe("Preferred action. Call it directly when the operation and arguments are known. No prior search or describe call is required."),
]);

export type GitHubToolInput = z.infer<typeof githubToolInputSchema>;

export function searchCatalog(query: string, limit: number, offset: number) {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/gu) ?? [])];
  const matches = operationNames.map((name, index) => {
    const entry = operationCatalog[name];
    const haystack = `${name} ${entry.signature} ${entry.description} ${catalogSearchAliases[name] ?? ""}`.toLowerCase();
    const matchedTerms = terms.filter((term) => haystack.includes(term));
    const operationText = name.replaceAll("_", " ");
    const operationMatches = matchedTerms.filter((term) => operationText.includes(term)).length;
    return { index, matchedTerms: matchedTerms.length, name, operationMatches };
  }).filter((match) => match.matchedTerms > 0).sort((left, right) =>
    right.matchedTerms - left.matchedTerms
    || right.operationMatches - left.operationMatches
    || left.index - right.index
  );
  const pageMatches = matches.slice(offset, offset + limit).map(({ name }) => ({
    description: operationCatalog[name].description,
    operation: name,
    signature: operationCatalog[name].signature,
  }));
  return {
    ...(matches.length === 0
      ? { hint: "Try fewer terms or: file, commit, branch, pull request, issue, workflow, comment, review." }
      : {}),
    matches: pageMatches,
    next_offset: offset + limit < matches.length ? offset + limit : null,
    total: matches.length,
  };
}

export function describeOperation(operation: OperationName) {
  const entry = operationCatalog[operation];
  return {
    description: entry.description,
    input_schema: z.toJSONSchema(entry.input),
    operation,
    result_schema: z.toJSONSchema(entry.result),
    signature: entry.signature,
  };
}
