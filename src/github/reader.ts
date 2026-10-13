import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import type { GitHubAppConfig } from "../types";
import { argumentHash, bodyHash, type ReferenceTokenPayload, type TokenCodec } from "../security/reference-token";
import type { BackendResult, GitHubBackend } from "./gateway";
import { GatewayError } from "./gateway-error";
import { operationCatalog, type OperationName } from "./catalog";
import { mapGitHubUrl } from "./url-router";
import { parseRepository, validateCodeSearchQuery } from "./repository";
import { exactNextRequest, fitCollection, hasNextLink, type NextRequest } from "./result";
import type { RangeRequest } from "./range-http";
import { decodeText, scanFileChunk, sliceKnownText, validateUtf8Chunk } from "./text";

const API_VERSION = "2026-03-10";
const MAX_SUBREQUESTS = 20;
const FILE_SCAN_BYTES = 64 * 1024;
const ONE_MIB = 1024 * 1024;
const ONE_HUNDRED_MIB = 100 * ONE_MIB;
const SCAN_TTL_SECONDS = 15 * 60;
const TEXT_TTL_SECONDS = 60 * 60;
const ARTIFACT_TTL_SECONDS = 5 * 60;

type JsonRecord = Record<string, unknown>;

interface ApiResponse {
  data: unknown;
  headers: Record<string, string | undefined>;
  status?: number;
}

export interface OctokitLike {
  request(route: string, parameters?: Record<string, unknown>): Promise<ApiResponse>;
}

type AppAuthentication = (options: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface GitHubReaderOptions {
  artifactBaseUrl: string;
  authFactory?: (config: GitHubAppConfig, fetchImpl: typeof fetch) => AppAuthentication;
  fetch?: typeof fetch;
  now?: () => number;
  octokitFactory?: (token?: string) => OctokitLike;
  rangeRequest?: RangeRequest;
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError("upstream_error", "GitHub returned an unexpected response shape", true);
  }
  return value as JsonRecord;
}

function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new GatewayError("upstream_error", "GitHub returned an unexpected collection shape", true);
  }
  return value.map(record);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nested(value: JsonRecord, key: string): JsonRecord {
  return record(value[key]);
}

function optionalNested(value: JsonRecord, key: string): JsonRecord | null {
  const item = value[key];
  return item && typeof item === "object" && !Array.isArray(item) ? (item as JsonRecord) : null;
}

function header(response: ApiResponse, name: string): string | undefined {
  return response.headers[name] ?? response.headers[name.toLowerCase()];
}

function pagination(page: number, perPage: number, returned: number, response: ApiResponse) {
  return { has_next: hasNextLink(header(response, "link")), page, per_page: perPage, returned };
}

function repositorySummary(item: JsonRecord) {
  return {
    default_branch: stringValue(item.default_branch),
    full_name: stringValue(item.full_name),
    private: booleanValue(item.private),
    url: stringValue(item.html_url),
  };
}

function userLogin(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return stringValue((value as JsonRecord).login);
}

function labelNames(value: unknown): Array<string | null> {
  if (!Array.isArray(value)) return [];
  return value.map((label) => (typeof label === "string" ? label : stringValue(record(label).name)));
}

function createDefaultAuthFactory(config: GitHubAppConfig, fetchImpl: typeof fetch): AppAuthentication {
  const versionedRequest = new Octokit({ request: { fetch: fetchImpl } }).request.defaults({
    headers: { "x-github-api-version": API_VERSION },
  });
  return createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    request: versionedRequest,
  }) as unknown as AppAuthentication;
}

export class GitHubReader implements GitHubBackend {
  private readonly authFactory: (config: GitHubAppConfig, fetchImpl: typeof fetch) => AppAuthentication;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly octokitFactory: (token?: string) => OctokitLike;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly tokenCodec: TokenCodec,
    private readonly options: GitHubReaderOptions,
  ) {
    this.authFactory = options.authFactory ?? createDefaultAuthFactory;
    this.fetchImpl = (options.fetch ?? fetch).bind(globalThis);
    this.now = options.now ?? Date.now;
    this.octokitFactory =
      options.octokitFactory ??
      ((token) => new Octokit({ ...(token ? { auth: token } : {}), request: { fetch: this.fetchImpl } }) as unknown as OctokitLike);
  }

  async execute(
    operation: OperationName,
    argumentsValue: Record<string, unknown>,
    userId: number,
  ): Promise<BackendResult> {
    return new GitHubExecution(this, userId).execute(operation, argumentsValue);
  }

  async handleArtifactRequest(request: Request, token: string): Promise<Response> {
    const securityHeaders = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        headers: { ...securityHeaders, Allow: "GET, HEAD" },
        status: 405,
      });
    }
    try {
      const payload = await this.tokens.open(token, {
        operation: "download_workflow_artifact",
        purpose: "artifact",
      });
      if (payload.args_hash !== await argumentHash(payload.resource)) {
        throw new GatewayError("invalid_token", "The artifact token resource does not match its binding");
      }
      const repository = stringValue(payload.resource.repository_full_name);
      const artifactId = numberValue(payload.resource.artifact_id);
      if (!repository || artifactId === null) throw new GatewayError("invalid_token", "The artifact token is invalid");
      const location = await new GitHubExecution(this, payload.user_id).artifactRedirect(repository, artifactId);
      return new Response(null, { headers: { ...securityHeaders, Location: location }, status: 302 });
    } catch {
      return new Response("Artifact link is invalid or expired", { headers: securityHeaders, status: 404 });
    }
  }

  createAuth(): AppAuthentication {
    return this.authFactory(this.config, this.fetchImpl);
  }

  createOctokit(token?: string): OctokitLike {
    return this.octokitFactory(token);
  }

  get artifactBaseUrl(): string {
    return this.options.artifactBaseUrl.replace(/\/$/u, "");
  }

  get clock(): () => number {
    return this.now;
  }

  get fetcher(): typeof fetch {
    return this.fetchImpl;
  }

  get rangeRequester(): RangeRequest {
    if (!this.options.rangeRequest) {
      throw new GatewayError("upstream_error", "The file range transport is unavailable");
    }
    return this.options.rangeRequest;
  }

  get tokens(): TokenCodec {
    return this.tokenCodec;
  }
}

class GitHubExecution {
  private appCache?: { auth: AppAuthentication; octokit: OctokitLike };
  private readonly repositoryCache = new Map<string, { octokit: OctokitLike; token?: string }>();
  private publicMode = false;
  private subrequests = 0;

  constructor(
    private readonly reader: GitHubReader,
    private readonly userId: number,
  ) {}

  async execute(operation: OperationName, args: JsonRecord): Promise<BackendResult> {
    switch (operation) {
      case "list_repositories": return { data: await this.listRepositories(args, false) };
      case "search_repositories": return { data: await this.listRepositories(args, true) };
      case "get_repository": return { data: await this.getRepository(args) };
      case "get_branch": return { data: await this.getBranch(args) };
      case "search_code": return { data: await this.searchCode(args) };
      case "list_directory": return { data: await this.listDirectory(args) };
      case "fetch_file": return { data: await this.fetchFile(args) };
      case "fetch": return this.fetchMapped(args);
      case "search_commits": return { data: await this.searchCommits(args) };
      case "fetch_commit": return { data: await this.fetchCommit(args) };
      case "list_commit_changed_filenames": return { data: await this.listCommitFiles(args) };
      case "fetch_commit_file_patch": return { data: await this.fetchCommitPatch(args) };
      case "get_commit_combined_status": return { data: await this.getCombinedStatus(args) };
      case "search_prs": return { data: await this.searchPullRequests(args) };
      case "get_pr_info": return { data: await this.getPullRequest(args) };
      case "list_pr_changed_filenames": return { data: await this.listPullRequestFiles(args) };
      case "fetch_pr_file_patch": return { data: await this.fetchPullRequestPatch(args) };
      case "list_pull_request_reviews": return { data: await this.listPullRequestReviews(args) };
      case "list_pull_request_comments": return { data: await this.listIssueComments(args, true) };
      case "search_issues": return { data: await this.searchIssues(args) };
      case "fetch_issue": return { data: await this.fetchIssue(args) };
      case "list_issue_comments": return { data: await this.listIssueComments(args, false) };
      case "fetch_commit_workflow_runs": return { data: await this.listWorkflowRuns(args) };
      case "fetch_workflow_run": return { data: await this.fetchWorkflowRun(args) };
      case "fetch_workflow_run_jobs": return { data: await this.listWorkflowJobs(args) };
      case "fetch_workflow_job_steps": return { data: await this.listWorkflowSteps(args) };
      case "fetch_workflow_run_artifacts": return { data: await this.listWorkflowArtifacts(args) };
      case "download_workflow_artifact": return this.downloadArtifact(args);
      case "list_organization_members": return { data: await this.listOrganizationMembers(args) };
      case "search_organization_members": return { data: await this.searchOrganizationMembers(args) };
      case "get_organization_membership": return { data: await this.getOrganizationMembership(args) };
      case "read_text": return { data: await this.readText(args) };
    }
  }

  async artifactRedirect(repository: string, artifactId: number): Promise<string> {
    const coordinates = parseRepository(repository);
    const { token } = await this.repositoryClient(repository);
    if (!token) throw new GatewayError("installation_required", "The artifact repository is not installed");
    this.subrequests += 1;
    if (this.subrequests > MAX_SUBREQUESTS) throw new GatewayError("upstream_error", "The operation reached the subrequest limit");
    const response = await this.reader.fetcher(
      `https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/actions/artifacts/${artifactId}/zip`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
        redirect: "manual",
      },
    );
    if (response.status === 410) {
      await response.body?.cancel();
      throw new GatewayError("not_found", "The workflow artifact expired");
    }
    const locationValue = response.headers.get("Location");
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400 || !locationValue) {
      throw new GatewayError("upstream_error", "GitHub did not issue an artifact redirect", true);
    }
    const location = new URL(locationValue);
    if (location.protocol !== "https:" || location.username || location.password || location.port) {
      throw new GatewayError("upstream_error", "GitHub issued an unsafe artifact redirect");
    }
    return location.href;
  }

  private async request(client: OctokitLike, route: string, parameters: JsonRecord = {}): Promise<ApiResponse> {
    this.subrequests += 1;
    if (this.subrequests > MAX_SUBREQUESTS) {
      throw new GatewayError("upstream_error", "The operation reached the 20-subrequest safety limit");
    }
    const existingHeaders = parameters.headers;
    const headers = existingHeaders && typeof existingHeaders === "object" && !Array.isArray(existingHeaders)
      ? (existingHeaders as JsonRecord)
      : {};
    return client.request(route, {
      ...parameters,
      headers: { ...headers, "x-github-api-version": API_VERSION },
    });
  }

  private async appClient(): Promise<{ auth: AppAuthentication; octokit: OctokitLike }> {
    if (this.appCache) return this.appCache;
    const auth = this.reader.createAuth();
    const authentication = await auth({ type: "app" });
    const token = stringValue(authentication.token);
    if (!token) throw new GatewayError("installation_required", "GitHub did not issue an App token");
    this.appCache = { auth, octokit: this.reader.createOctokit(token) };
    return this.appCache;
  }

  private async installationAuthentication(
    auth: AppAuthentication,
    options: JsonRecord,
  ): Promise<JsonRecord> {
    this.subrequests += 1;
    if (this.subrequests > MAX_SUBREQUESTS) {
      throw new GatewayError("upstream_error", "The operation reached the 20-subrequest safety limit");
    }
    return auth(options);
  }

  private async repositoryClient(repository: string): Promise<{ octokit: OctokitLike; token?: string }> {
    const cached = this.repositoryCache.get(repository);
    if (cached) return cached;
    parseRepository(repository);
    if (this.publicMode) {
      const client = { octokit: this.reader.createOctokit() };
      this.repositoryCache.set(repository, client);
      return client;
    }
    const coordinates = parseRepository(repository);
    const { auth, octokit: app } = await this.appClient();
    const installation = await this.request(app, "GET /repos/{owner}/{repo}/installation", {
      owner: coordinates.owner,
      repo: coordinates.repo,
    });
    const installationId = numberValue(record(installation.data).id);
    if (installationId === null) throw new GatewayError("installation_required", "The repository is not installed");
    const authentication = await this.installationAuthentication(auth, {
      installationId,
      repositoryNames: [coordinates.repo],
      type: "installation",
    });
    const token = stringValue(authentication.token);
    if (!token) throw new GatewayError("installation_required", "GitHub did not issue an installation token");
    const client = { octokit: this.reader.createOctokit(token), token };
    this.repositoryCache.set(repository, client);
    return client;
  }

  private async organizationClient(organization: string): Promise<OctokitLike> {
    if (this.publicMode) return this.reader.createOctokit();
    const { auth, octokit: app } = await this.appClient();
    const installation = await this.request(app, "GET /orgs/{org}/installation", { org: organization });
    const installationId = numberValue(record(installation.data).id);
    if (installationId === null) throw new GatewayError("installation_required", "The organization is not installed");
    const authentication = await this.installationAuthentication(auth, {
      installationId,
      type: "installation",
    });
    const token = stringValue(authentication.token);
    if (!token) throw new GatewayError("installation_required", "GitHub did not issue an installation token");
    return this.reader.createOctokit(token);
  }

  private coordinates(args: JsonRecord) {
    const value = stringValue(args.repository_full_name);
    if (!value) throw new GatewayError("invalid_arguments", "repository_full_name is required");
    return parseRepository(value);
  }

  private page(args: JsonRecord): { page: number; perPage: number } {
    return { page: numberValue(args.page) ?? 1, perPage: numberValue(args.per_page) ?? 20 };
  }

  private next(operation: OperationName, args: JsonRecord, nextPage: number): NextRequest {
    return exactNextRequest(operation, { ...args, page: nextPage });
  }

  private nowSeconds(): number {
    return Math.floor(this.reader.clock() / 1000);
  }

  private async sealToken(
    purpose: ReferenceTokenPayload["purpose"],
    operation: string,
    argsHash: string,
    resource: JsonRecord,
    cursor: JsonRecord,
    ttlSeconds: number,
  ): Promise<string> {
    const issued = this.nowSeconds();
    return this.reader.tokens.seal({
      args_hash: argsHash,
      cursor,
      exp: issued + ttlSeconds,
      iat: issued,
      operation,
      purpose,
      resource,
      user_id: this.userId,
    });
  }

  private async listRepositories(args: JsonRecord, searching: boolean): Promise<unknown> {
    const operation: OperationName = searching ? "search_repositories" : "list_repositories";
    const pageSize = numberValue(args.page_size) ?? 20;
    const query = searching ? stringValue(args.query)?.trim().toLowerCase() : null;
    if (searching && !query) throw new GatewayError("invalid_arguments", "query is required");
    const normalizedArgs = { page_size: pageSize, ...(query ? { query } : {}) };
    const argsHash = await argumentHash(normalizedArgs);
    let installationOffset = 0;
    let installationPage = 1;
    let repositoryPage = 1;
    let repositoryOffset = 0;
    const token = stringValue(args.continuation_token);
    if (token) {
      const payload = await this.reader.tokens.open(token, {
        operation,
        purpose: "repository_scan",
        user_id: this.userId,
      });
      if (payload.args_hash !== argsHash) throw new GatewayError("invalid_token", "The continuation token arguments do not match");
      installationOffset = numberValue(payload.cursor.installation_offset) ?? 0;
      installationPage = numberValue(payload.cursor.installation_page) ?? 1;
      repositoryPage = numberValue(payload.cursor.repository_page) ?? 1;
      repositoryOffset = numberValue(payload.cursor.repository_offset) ?? 0;
    }
    const { auth, octokit: app } = await this.appClient();
    const selected: unknown[] = [];
    let complete = false;
    let cursor = {
      installation_offset: installationOffset,
      installation_page: installationPage,
      repository_offset: repositoryOffset,
      repository_page: repositoryPage,
    };

    scan: while (this.subrequests < MAX_SUBREQUESTS) {
      const installationsResponse = await this.request(app, "GET /app/installations", {
        page: installationPage,
        per_page: 100,
      });
      const installations = records(installationsResponse.data);
      for (let installIndex = installationOffset; installIndex < installations.length; installIndex += 1) {
        if (this.subrequests > MAX_SUBREQUESTS - 2) break scan;
        const installationId = numberValue(installations[installIndex]?.id);
        if (installationId === null) continue;
        const authentication = await this.installationAuthentication(auth, {
          installationId,
          type: "installation",
        });
        const installationToken = stringValue(authentication.token);
        if (!installationToken) continue;
        const octokit = this.reader.createOctokit(installationToken);
        let currentPage = installIndex === installationOffset ? repositoryPage : 1;
        let currentOffset = installIndex === installationOffset ? repositoryOffset : 0;
        while (true) {
          const response = await this.request(octokit, "GET /installation/repositories", {
            page: currentPage,
            per_page: 100,
          });
          const data = record(response.data);
          const repositories = records(data.repositories);
          for (let index = currentOffset; index < repositories.length; index += 1) {
            const summary = repositorySummary(repositories[index] ?? {});
            cursor = {
              installation_offset: installIndex,
              installation_page: installationPage,
              repository_offset: index + 1,
              repository_page: currentPage,
            };
            if (!query || summary.full_name?.toLowerCase().includes(query)) selected.push(summary);
            if (selected.length >= pageSize) break scan;
          }
          if (!hasNextLink(header(response, "link"))) break;
          currentPage += 1;
          currentOffset = 0;
          cursor = {
            installation_offset: installIndex,
            installation_page: installationPage,
            repository_offset: 0,
            repository_page: currentPage,
          };
        }
        cursor = {
          installation_offset: installIndex + 1,
          installation_page: installationPage,
          repository_offset: 0,
          repository_page: 1,
        };
      }
      if (!hasNextLink(header(installationsResponse, "link"))) {
        complete = true;
        break;
      }
      installationPage += 1;
      installationOffset = 0;
      repositoryPage = 1;
      repositoryOffset = 0;
      cursor = {
        installation_offset: 0,
        installation_page: installationPage,
        repository_offset: 0,
        repository_page: 1,
      };
    }

    let nextRequest: NextRequest | undefined;
    if (!complete) {
      const continuation = await this.sealToken(
        "repository_scan",
        operation,
        argsHash,
        {},
        cursor,
        SCAN_TTL_SECONDS,
      );
      nextRequest = exactNextRequest(operation, { ...normalizedArgs, continuation_token: continuation });
    }
    const state = complete ? "complete" : selected.length === 0 ? "seeking" : "partial";
    return fitCollection(operation, { state }, "repositories", selected, nextRequest).data;
  }

  private async getRepository(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}", {
      owner: coordinates.owner,
      repo: coordinates.repo,
    });
    const data = record(response.data);
    return {
      ...repositorySummary(data),
      archived: booleanValue(data.archived),
      created_at: stringValue(data.created_at),
      description: stringValue(data.description),
      fork: booleanValue(data.fork),
      language: stringValue(data.language),
      pushed_at: stringValue(data.pushed_at),
      size_kib: numberValue(data.size),
      updated_at: stringValue(data.updated_at),
      visibility: stringValue(data.visibility),
    };
  }

  private async getBranch(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const branch = stringValue(args.branch);
    if (!branch) throw new GatewayError("invalid_arguments", "branch is required");
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/branches/{branch}", {
      branch,
      owner: coordinates.owner,
      repo: coordinates.repo,
    });
    const data = record(response.data);
    const commit = nested(data, "commit");
    return {
      commit_sha: stringValue(commit.sha),
      name: stringValue(data.name),
      protected: booleanValue(data.protected),
      repository_full_name: coordinates.fullName,
    };
  }

  private async searchCode(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const query = stringValue(args.query);
    if (!query) throw new GatewayError("invalid_arguments", "query is required");
    const safeQuery = validateCodeSearchQuery(query);
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /search/code", {
      page,
      per_page: perPage,
      q: `${safeQuery} repo:${coordinates.fullName}`,
    });
    const data = record(response.data);
    const items = records(data.items).map((item) => ({
      name: stringValue(item.name),
      path: stringValue(item.path),
      repository_full_name: stringValue(optionalNested(item, "repository")?.full_name),
      sha: stringValue(item.sha),
      url: stringValue(item.html_url),
    }));
    const hasNext = hasNextLink(header(response, "link"));
    const nextRequest = hasNext ? this.next("search_code", args, page + 1) : undefined;
    return fitCollection(
      "search_code",
      { pagination: pagination(page, perPage, items.length, response), total_count: numberValue(data.total_count) },
      "items",
      items,
      nextRequest,
    ).data;
  }

  private async listDirectory(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const path = stringValue(args.path) ?? "";
    const ref = stringValue(args.ref);
    const offset = numberValue(args.offset) ?? 0;
    const limit = numberValue(args.limit) ?? 20;
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/contents/{path}", {
      owner: coordinates.owner,
      path,
      repo: coordinates.repo,
      ...(ref ? { ref } : {}),
    });
    if (!Array.isArray(response.data)) throw new GatewayError("invalid_arguments", "The requested path is not a directory");
    const all = records(response.data);
    const selected = all.slice(offset, offset + limit).map((entry) => ({
      name: stringValue(entry.name),
      path: stringValue(entry.path),
      sha: stringValue(entry.sha),
      size: numberValue(entry.size),
      type: stringValue(entry.type),
      url: stringValue(entry.html_url),
    }));
    const nextOffset = offset + selected.length < all.length ? offset + selected.length : null;
    const completeness = all.length === 1000 ? "unknown" : "complete";
    const nextRequest = nextOffset === null
      ? undefined
      : exactNextRequest("list_directory", { ...args, offset: nextOffset });
    return fitCollection(
      "list_directory",
      {
        completeness,
        next_offset: nextOffset,
        path,
        repository_full_name: coordinates.fullName,
        total_entries: all.length,
      },
      "entries",
      selected,
      nextRequest,
    ).data;
  }

  private async fetchMapped(args: JsonRecord): Promise<BackendResult> {
    const token = stringValue(args.continuation_token);
    if (token) return { data: await this.fetchFile({ continuation_token: token }) };
    const url = stringValue(args.url);
    if (!url) throw new GatewayError("invalid_arguments", "url is required");
    const mapped = mapGitHubUrl(url);
    // URL query values must meet the same limits as direct calls, such as per_page <= 20.
    const parsed = operationCatalog[mapped.operation].input.safeParse(mapped.arguments);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first ? `${first.path.length > 0 ? `${first.path.join(".")}: ` : ""}${first.message}` : "invalid arguments";
      throw new GatewayError("invalid_arguments", `The URL maps to ${mapped.operation} with ${detail}`);
    }
    const mappedArguments = parsed.data as JsonRecord;
    try {
      return await this.execute(mapped.operation, mappedArguments);
    } catch (error) {
      const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
      if (status !== 404) throw error;
      this.publicMode = true;
      this.repositoryCache.clear();
      return this.execute(mapped.operation, mappedArguments);
    }
  }

  private async resolveCommitSha(coordinates: ReturnType<typeof parseRepository>, ref: string | null): Promise<string> {
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    let requestedRef = ref;
    if (!requestedRef) {
      const repository = await this.request(octokit, "GET /repos/{owner}/{repo}", {
        owner: coordinates.owner,
        repo: coordinates.repo,
      });
      requestedRef = stringValue(record(repository.data).default_branch);
    }
    if (!requestedRef) throw new GatewayError("not_found", "The repository has no default branch");
    const commit = await this.request(octokit, "GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: coordinates.owner,
      ref: requestedRef,
      repo: coordinates.repo,
    });
    const sha = stringValue(record(commit.data).sha);
    if (!sha) throw new GatewayError("upstream_error", "GitHub did not return a commit SHA");
    return sha;
  }

  private async fileMetadata(repository: string, path: string, commitSha: string) {
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    let response: ApiResponse;
    try {
      response = await this.request(octokit, "GET /repos/{owner}/{repo}/contents/{path}", {
        owner: coordinates.owner,
        path,
        ref: commitSha,
        repo: coordinates.repo,
      });
    } catch (error) {
      const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
      if (status !== 403) throw error;
      const commitResponse = await this.request(octokit, "GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        commit_sha: commitSha,
        owner: coordinates.owner,
        repo: coordinates.repo,
      });
      const treeSha = stringValue(nested(record(commitResponse.data), "tree").sha);
      if (!treeSha) throw error;
      const treeResponse = await this.request(octokit, "GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: coordinates.owner,
        recursive: "1",
        repo: coordinates.repo,
        tree_sha: treeSha,
      });
      const treeData = record(treeResponse.data);
      const entry = records(treeData.tree).find((candidate) => stringValue(candidate.path) === path);
      if (!entry || stringValue(entry.type) !== "blob") throw error;
      response = {
        data: {
          content: null,
          download_url: null,
          encoding: "none",
          html_url: `https://github.com/${coordinates.fullName}/blob/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`,
          path,
          sha: stringValue(entry.sha),
          size: numberValue(entry.size),
          type: "file",
        },
        headers: {},
      };
    }
    if (Array.isArray(response.data)) throw new GatewayError("invalid_arguments", "The requested path is a directory");
    const data = record(response.data);
    if (stringValue(data.type) !== "file") throw new GatewayError("invalid_arguments", "The requested path is not a regular file");
    return { data };
  }

  private decodeBase64(value: string): Uint8Array {
    try {
      const binary = atob(value.replace(/\s/gu, ""));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new GatewayError("upstream_error", "GitHub returned invalid base64 file content", true);
    }
  }

  private async fileContinuation(
    argsHash: string,
    resource: JsonRecord,
    cursor: JsonRecord,
  ): Promise<NextRequest> {
    const token = await this.sealToken(
      "file",
      "fetch_file",
      argsHash,
      resource,
      cursor,
      TEXT_TTL_SECONDS,
    );
    return exactNextRequest("fetch_file", { continuation_token: token });
  }

  private fileBase(resource: JsonRecord, data: JsonRecord) {
    return {
      blob_sha: stringValue(resource.blob_sha),
      commit_sha: stringValue(resource.commit_sha),
      path: stringValue(resource.path),
      repository_full_name: stringValue(resource.repository_full_name),
      size: numberValue(resource.size),
      url: stringValue(data.html_url),
    };
  }

  private async fetchFile(args: JsonRecord): Promise<unknown> {
    const continuation = stringValue(args.continuation_token);
    let argsHash: string;
    let resource: JsonRecord;
    let cursor: JsonRecord;
    if (continuation) {
      const payload = await this.reader.tokens.open(continuation, {
        operation: "fetch_file",
        purpose: "file",
        user_id: this.userId,
      });
      if (payload.args_hash !== await argumentHash(payload.resource)) {
        throw new GatewayError("invalid_token", "The file token resource does not match its binding");
      }
      argsHash = payload.args_hash;
      resource = payload.resource;
      cursor = payload.cursor;
    } else {
      const coordinates = this.coordinates(args);
      const path = stringValue(args.path);
      if (!path) throw new GatewayError("invalid_arguments", "path is required");
      const requestedStart = numberValue(args.start_line) ?? 1;
      const requestedEnd = numberValue(args.end_line) ?? undefined;
      const commitSha = await this.resolveCommitSha(coordinates, stringValue(args.ref));
      const metadata = await this.fileMetadata(coordinates.fullName, path, commitSha);
      const size = numberValue(metadata.data.size) ?? 0;
      resource = {
        blob_sha: stringValue(metadata.data.sha),
        commit_sha: commitSha,
        path,
        repository_full_name: coordinates.fullName,
        requested_end_line: requestedEnd ?? null,
        requested_start_line: requestedStart,
        size,
      };
      argsHash = await argumentHash(resource);
      cursor = { byte_offset: 0, line_number: 1, mid_line: false };
    }

    const repository = stringValue(resource.repository_full_name);
    const path = stringValue(resource.path);
    const commitSha = stringValue(resource.commit_sha);
    if (!repository || !path || !commitSha) throw new GatewayError("invalid_token", "The file token has invalid resource data");
    const metadata = await this.fileMetadata(repository, path, commitSha);
    if (stringValue(metadata.data.sha) !== stringValue(resource.blob_sha)) {
      throw new GatewayError("stale_reference", "The pinned file resource no longer matches its blob SHA");
    }
    const size = numberValue(resource.size) ?? numberValue(metadata.data.size) ?? 0;
    const requestedStart = numberValue(resource.requested_start_line) ?? 1;
    const requestedEnd = numberValue(resource.requested_end_line) ?? undefined;
    const base = this.fileBase(resource, metadata.data);
    if (size === 0) {
      return { ...base, binary: false, state: requestedStart === 1 ? "complete" : "eof", total_lines: 0 };
    }
    if (size > ONE_HUNDRED_MIB) {
      return { ...base, binary: null, content_available: false, reason: "contents_api_size_limit", state: "complete" };
    }

    const inlineContent = stringValue(metadata.data.content);
    const encoding = stringValue(metadata.data.encoding);
    const downloadUrl = stringValue(metadata.data.download_url);
    const useInlineContent = size <= ONE_MIB && inlineContent !== null && encoding === "base64";
    if (useInlineContent) {
      const inlineBytes = this.decodeBase64(inlineContent);
      if (inlineBytes.byteLength !== size) {
        throw new GatewayError("upstream_error", "GitHub returned incomplete inline file content", true);
      }
      let text: string;
      try {
        text = decodeText(inlineBytes);
      } catch (error) {
        if (error instanceof GatewayError && error.code === "binary_detected") {
          return { ...base, binary: true, state: "complete" };
        }
        throw error;
      }
      const startLine = numberValue(cursor.inline_next_line) ?? requestedStart;
      const window = sliceKnownText(text, startLine, requestedEnd);
      if (window.state === "range_too_large") {
        const largestSafeEnd = window.largest_safe_end_line ?? startLine;
        throw new GatewayError(
          "range_too_large",
          `The requested range is too large. The largest safe end_line is ${largestSafeEnd}`,
          false,
          {
            largest_safe_end_line: largestSafeEnd,
            next_request: exactNextRequest("fetch_file", {
              end_line: largestSafeEnd,
              path,
              ref: commitSha,
              repository_full_name: repository,
              start_line: startLine,
            }),
          },
        );
      }
      const nextRequest = window.next_line
        ? await this.fileContinuation(argsHash, resource, { inline_next_line: window.next_line })
        : undefined;
      return {
        ...base,
        binary: false,
        ...(window.content !== undefined ? { content: window.content } : {}),
        ...(window.end_line !== undefined ? { end_line: window.end_line } : {}),
        ...(nextRequest ? { next_request: nextRequest } : {}),
        ...(window.start_line !== undefined ? { start_line: window.start_line } : {}),
        state: window.state,
        total_lines: window.total_lines,
      };
    }
    if (!downloadUrl) {
      throw new GatewayError("range_not_supported", "GitHub did not provide a range-capable download URL for this file");
    }

    const byteOffset = numberValue(cursor.byte_offset) ?? 0;
    let lineNumber = numberValue(cursor.line_number) ?? 1;
    let midLine = booleanValue(cursor.mid_line);
    const carryValue = cursor.utf8_carry;
    let utf8Carry = Array.isArray(carryValue)
      ? carryValue.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
      : [];
    if (byteOffset >= size) {
      return { ...base, binary: false, state: "eof", total_lines: Math.max(0, lineNumber - 1) };
    }
    const rangeEnd = Math.min(size - 1, byteOffset + FILE_SCAN_BYTES - 1);
    this.subrequests += 1;
    if (this.subrequests > MAX_SUBREQUESTS) throw new GatewayError("upstream_error", "The operation reached the 20-subrequest safety limit");
    const response = await this.reader.rangeRequester(downloadUrl, byteOffset, rangeEnd);
    if (response.status >= 300 && response.status < 400) {
      throw new GatewayError("range_not_supported", "The GitHub download URL returned an unexpected redirect");
    }
    const contentRange = response.headers.get("Content-Range");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange ?? "");
    if (response.status !== 206 || !match) {
      throw new GatewayError("range_not_supported", "The GitHub download source did not honor the byte range");
    }
    const actualStart = Number(match[1]);
    const actualEnd = Number(match[2]);
    const actualTotal = Number(match[3]);
    if (actualStart !== byteOffset || actualEnd > rangeEnd || actualTotal !== size) {
      throw new GatewayError(
        "range_not_supported",
        "GitHub returned a mismatched Content-Range",
        false,
        {
          content_encoding: response.headers.get("Content-Encoding"),
          expected: { end_at_most: rangeEnd, start: byteOffset, total: size },
          received: { end: actualEnd, start: actualStart, total: actualTotal },
        },
      );
    }
    let bytes = response.bytes;
    if (bytes.byteLength !== actualEnd - actualStart + 1) {
      throw new GatewayError("range_not_supported", "GitHub returned a byte count that does not match Content-Range");
    }
    const eof = actualEnd + 1 === size;
    if (bytes.includes(0)) {
      if (byteOffset > 0) throw new GatewayError("binary_detected", "Binary data appeared after earlier text chunks");
      return { ...base, binary: true, state: "complete" };
    }

    let skippedBytes = 0;
    if (midLine && lineNumber < requestedStart) {
      const firstLf = bytes.indexOf(10);
      if (firstLf < 0) {
        try {
          utf8Carry = validateUtf8Chunk(bytes, utf8Carry, eof);
        } catch (error) {
          if (byteOffset === 0 && error instanceof GatewayError && error.code === "binary_detected") {
            return { ...base, binary: true, state: "complete" };
          }
          throw error;
        }
        if (eof) return { ...base, binary: false, state: "eof", total_lines: lineNumber };
        const nextRequest = await this.fileContinuation(argsHash, resource, {
          byte_offset: actualEnd + 1,
          line_number: lineNumber,
          mid_line: true,
          utf8_carry: utf8Carry,
        });
        return { ...base, binary: false, next_request: nextRequest, state: "seeking" };
      }
      try {
        validateUtf8Chunk(bytes.slice(0, firstLf + 1), utf8Carry, true);
      } catch (error) {
        if (byteOffset === 0 && error instanceof GatewayError && error.code === "binary_detected") {
          return { ...base, binary: true, state: "complete" };
        }
        throw error;
      }
      skippedBytes = firstLf + 1;
      bytes = bytes.slice(skippedBytes);
      lineNumber += 1;
      midLine = false;
      utf8Carry = [];
    }

    const scanned = scanFileChunk(bytes, lineNumber, requestedStart, requestedEnd, eof);
    if (scanned.binary) {
      if (byteOffset > 0) throw new GatewayError("binary_detected", "Binary data appeared after earlier text chunks");
      return { ...base, binary: true, state: "complete" };
    }
    if (scanned.state === "seeking" && scanned.consumed_bytes === 0 && !eof) {
      if (lineNumber >= requestedStart) {
        throw new GatewayError("line_too_large", `Line ${lineNumber} cannot fit in one result`);
      }
      let nextCarry: number[];
      try {
        nextCarry = validateUtf8Chunk(bytes, utf8Carry, false);
      } catch (error) {
        if (byteOffset === 0 && error instanceof GatewayError && error.code === "binary_detected") {
          return { ...base, binary: true, state: "complete" };
        }
        throw error;
      }
      const nextRequest = await this.fileContinuation(argsHash, resource, {
        byte_offset: actualEnd + 1,
        line_number: lineNumber,
        mid_line: true,
        utf8_carry: nextCarry,
      });
      return { ...base, binary: false, next_request: nextRequest, state: "seeking" };
    }
    if (
      requestedEnd !== undefined &&
      scanned.state === "partial" &&
      scanned.consumed_bytes < bytes.length
    ) {
      const largestSafeEnd = scanned.end_line ?? requestedStart;
      throw new GatewayError(
        "range_too_large",
        `The requested range is too large. The largest safe end_line is ${largestSafeEnd}`,
        false,
        {
          largest_safe_end_line: largestSafeEnd,
          next_request: exactNextRequest("fetch_file", {
            end_line: largestSafeEnd,
            path,
            ref: commitSha,
            repository_full_name: repository,
            start_line: requestedStart,
          }),
        },
      );
    }
    const nextByteOffset = byteOffset + skippedBytes + scanned.consumed_bytes;
    if (!scanned.content && eof && scanned.state === "complete" && scanned.next_line <= requestedStart) {
      return { ...base, binary: false, state: "eof", total_lines: Math.max(0, scanned.next_line - 1) };
    }
    const needsContinuation = scanned.state === "partial" || scanned.state === "seeking";
    const nextRequest = needsContinuation
      ? await this.fileContinuation(argsHash, resource, {
          byte_offset: nextByteOffset,
          line_number: scanned.next_line,
          mid_line: midLine,
        })
      : undefined;
    return {
      ...base,
      binary: false,
      ...(scanned.content !== undefined ? { content: scanned.content } : {}),
      ...(scanned.end_line !== undefined ? { end_line: scanned.end_line } : {}),
      ...(nextRequest ? { next_request: nextRequest } : {}),
      ...(scanned.start_line !== undefined ? { start_line: scanned.start_line } : {}),
      state: scanned.state,
      ...(eof ? { total_lines: Math.max(0, scanned.next_line - 1) } : {}),
    };
  }

  private async textReference(kind: string, text: string, resourceData: JsonRecord): Promise<string> {
    const hash = await bodyHash(text);
    const resource = { ...resourceData, body_hash: hash, kind };
    return this.sealToken(
      "text",
      "read_text",
      await argumentHash(resource),
      resource,
      { next_line: 1 },
      TEXT_TTL_SECONDS,
    );
  }

  private async inlineText(kind: string, text: string | null, resourceData: JsonRecord) {
    if (text === null) return { content: null, state: "complete" as const, total_lines: 0 };
    const window = sliceKnownText(text);
    if (window.next_line === undefined) {
      return {
        ...(window.content !== undefined ? { content: window.content } : {}),
        ...(window.end_line !== undefined ? { end_line: window.end_line } : {}),
        ...(window.start_line !== undefined ? { start_line: window.start_line } : {}),
        state: window.state,
        total_lines: window.total_lines,
      };
    }
    const referenceToken = await this.textReference(kind, text, resourceData);
    const payload = await this.reader.tokens.open(referenceToken, {
      operation: "read_text",
      purpose: "text",
      user_id: this.userId,
    });
    const continuationToken = await this.sealToken(
      "text",
      "read_text",
      payload.args_hash,
      payload.resource,
      { next_line: window.next_line },
      TEXT_TTL_SECONDS,
    );
    const nextRequest: NextRequest = exactNextRequest("read_text", { continuation_token: continuationToken });
    return {
      ...(window.content !== undefined ? { content: window.content } : {}),
      ...(window.end_line !== undefined ? { end_line: window.end_line } : {}),
      ...(nextRequest ? { next_request: nextRequest } : {}),
      reference_token: referenceToken,
      ...(window.start_line !== undefined ? { start_line: window.start_line } : {}),
      state: window.state,
      total_lines: window.total_lines,
    };
  }

  private async commitMessageReference(repository: string, commitSha: string, message: string): Promise<string> {
    return this.textReference("commit_message", message, {
      commit_sha: commitSha,
      repository_full_name: repository,
    });
  }

  private commitSummary(item: JsonRecord, messageReference: string) {
    const commit = nested(item, "commit");
    const author = optionalNested(commit, "author");
    return {
      author: userLogin(item.author) ?? stringValue(author?.name),
      authored_at: stringValue(author?.date),
      commit_sha: stringValue(item.sha),
      message_first_line: (stringValue(commit.message) ?? "").split(/\r?\n/u, 1)[0] ?? "",
      message_reference_token: messageReference,
      url: stringValue(item.html_url),
    };
  }

  private async searchCommits(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const { page, perPage } = this.page(args);
    const query = stringValue(args.query);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    let response: ApiResponse;
    let commits: JsonRecord[];
    if (query) {
      const safeQuery = validateCodeSearchQuery(query);
      response = await this.request(octokit, "GET /search/commits", {
        page,
        per_page: perPage,
        q: `${safeQuery} repo:${coordinates.fullName}`,
      });
      commits = records(record(response.data).items);
    } else {
      response = await this.request(octokit, "GET /repos/{owner}/{repo}/commits", {
        owner: coordinates.owner,
        page,
        per_page: perPage,
        repo: coordinates.repo,
        ...(stringValue(args.ref) ? { sha: stringValue(args.ref) } : {}),
        ...(stringValue(args.path) ? { path: stringValue(args.path) } : {}),
        ...(stringValue(args.since) ? { since: stringValue(args.since) } : {}),
        ...(stringValue(args.until) ? { until: stringValue(args.until) } : {}),
      });
      commits = records(response.data);
    }
    const summaries = [];
    for (const item of commits) {
      const commit = nested(item, "commit");
      const message = stringValue(commit.message) ?? "";
      const sha = stringValue(item.sha) ?? "";
      summaries.push(this.commitSummary(item, await this.commitMessageReference(coordinates.fullName, sha, message)));
    }
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("search_commits", args, page + 1)
      : undefined;
    return fitCollection(
      "search_commits",
      { pagination: pagination(page, perPage, summaries.length, response) },
      "commits",
      summaries,
      nextRequest,
    ).data;
  }

  private async fetchCommit(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const commitSha = stringValue(args.commit_sha);
    if (!commitSha) throw new GatewayError("invalid_arguments", "commit_sha is required");
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: coordinates.owner,
      per_page: 1,
      ref: commitSha,
      repo: coordinates.repo,
    });
    const data = record(response.data);
    const commit = nested(data, "commit");
    const author = optionalNested(commit, "author");
    const message = stringValue(commit.message);
    return {
      author: userLogin(data.author) ?? stringValue(author?.name),
      authored_at: stringValue(author?.date),
      commit_sha: stringValue(data.sha),
      message: await this.inlineText("commit_message", message, {
        commit_sha: stringValue(data.sha),
        repository_full_name: coordinates.fullName,
      }),
      parents: Array.isArray(data.parents) ? records(data.parents).map((parent) => stringValue(parent.sha)) : [],
      repository_full_name: coordinates.fullName,
      stats: optionalNested(data, "stats"),
      tree_sha: stringValue(optionalNested(commit, "tree")?.sha),
      url: stringValue(data.html_url),
    };
  }

  private commitFileSummary(file: JsonRecord) {
    return {
      additions: numberValue(file.additions),
      blob_sha: stringValue(file.sha),
      changes: numberValue(file.changes),
      deletions: numberValue(file.deletions),
      path: stringValue(file.filename),
      previous_path: stringValue(file.previous_filename),
      status: stringValue(file.status),
      url: stringValue(file.blob_url),
    };
  }

  private async commitFilesPage(
    repository: string,
    commitSha: string,
    page: number,
    perPage: number,
  ): Promise<{ commit: JsonRecord; files: JsonRecord[]; response: ApiResponse }> {
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: coordinates.owner,
      page,
      per_page: perPage,
      ref: commitSha,
      repo: coordinates.repo,
    });
    const commit = record(response.data);
    return { commit, files: Array.isArray(commit.files) ? records(commit.files) : [], response };
  }

  private async listCommitFiles(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const commitSha = stringValue(args.commit_sha);
    if (!commitSha) throw new GatewayError("invalid_arguments", "commit_sha is required");
    const { page, perPage } = this.page(args);
    const result = await this.commitFilesPage(coordinates.fullName, commitSha, page, perPage);
    const files = result.files.map((file) => this.commitFileSummary(file));
    const nextRequest = hasNextLink(header(result.response, "link"))
      ? this.next("list_commit_changed_filenames", args, page + 1)
      : undefined;
    return fitCollection(
      "list_commit_changed_filenames",
      { commit_sha: stringValue(result.commit.sha), pagination: pagination(page, perPage, files.length, result.response) },
      "files",
      files,
      nextRequest,
    ).data;
  }

  private async findCommitFile(repository: string, commitSha: string, path: string) {
    let page = 1;
    while (page <= MAX_SUBREQUESTS) {
      const result = await this.commitFilesPage(repository, commitSha, page, 20);
      const file = result.files.find((candidate) => stringValue(candidate.filename) === path);
      if (file) return { commit: result.commit, file };
      if (!hasNextLink(header(result.response, "link"))) break;
      page += 1;
    }
    throw new GatewayError("invalid_arguments", "The path is not in the commit changed-filename list");
  }

  private async fileTypeAt(repository: string, ref: string | null, path: string): Promise<string> {
    if (!ref) return "unknown";
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    try {
      const response = await this.request(octokit, "GET /repos/{owner}/{repo}/contents/{path}", {
        owner: coordinates.owner,
        path,
        ref,
        repo: coordinates.repo,
      });
      if (Array.isArray(response.data)) return "directory";
      const data = record(response.data);
      if (stringValue(data.submodule_git_url)) return "submodule";
      const type = stringValue(data.type);
      if (type === "file" || type === "symlink" || type === "submodule") return type;
      return "unknown";
    } catch (error) {
      const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
      if (status === 404) return "unknown";
      throw error;
    }
  }

  private async fetchCommitPatch(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const commitSha = stringValue(args.commit_sha);
    const path = stringValue(args.path);
    if (!commitSha || !path) throw new GatewayError("invalid_arguments", "commit_sha and path are required");
    const { commit, file } = await this.findCommitFile(coordinates.fullName, commitSha, path);
    const parents = Array.isArray(commit.parents) ? records(commit.parents) : [];
    const base = parents.length === 0
      ? { type: "empty" }
      : { commit_sha: stringValue(parents[0]?.sha), repository_full_name: coordinates.fullName, type: "commit" };
    const target = { commit_sha: stringValue(commit.sha), repository_full_name: coordinates.fullName, type: "commit" };
    const patch = stringValue(file.patch);
    const status = stringValue(file.status);
    const fileType = await this.fileTypeAt(
      coordinates.fullName,
      status === "removed" ? stringValue(parents[0]?.sha) : stringValue(commit.sha),
      status === "removed" ? stringValue(file.previous_filename) ?? path : path,
    );
    return {
      base,
      blob_sha: stringValue(file.sha),
      commit_sha: stringValue(commit.sha),
      completeness: "unverified",
      file_type: fileType,
      path,
      previous_path: stringValue(file.previous_filename),
      repository_full_name: coordinates.fullName,
      source: "github",
      status,
      target,
      ...(patch
        ? { patch: await this.inlineText("commit_patch", patch, { commit_sha: stringValue(commit.sha), path, repository_full_name: coordinates.fullName }) }
        : { patch: null, patch_availability: "omitted_by_github" }),
    };
  }

  private async getCombinedStatus(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const ref = stringValue(args.ref);
    if (!ref) throw new GatewayError("invalid_arguments", "ref is required");
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/commits/{ref}/status", {
      owner: coordinates.owner,
      page,
      per_page: perPage,
      ref,
      repo: coordinates.repo,
    });
    const data = record(response.data);
    const statuses = records(data.statuses).map((status) => ({
      context: stringValue(status.context),
      created_at: stringValue(status.created_at),
      creator: userLogin(status.creator),
      description: stringValue(status.description),
      state: stringValue(status.state),
      target_url: stringValue(status.target_url),
      updated_at: stringValue(status.updated_at),
    }));
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("get_commit_combined_status", args, page + 1)
      : undefined;
    const bounded = fitCollection("get_commit_combined_status", {}, "statuses", statuses, nextRequest).data;
    return {
      ...bounded,
      commit_sha: stringValue(data.sha),
      pagination: pagination(page, perPage, statuses.length, response),
      repository_full_name: coordinates.fullName,
      state: stringValue(data.state),
      total_count: numberValue(data.total_count),
    };
  }

  private pullRequestSummary(item: JsonRecord) {
    const base = optionalNested(item, "base");
    const head = optionalNested(item, "head");
    return {
      author: userLogin(item.user),
      base: stringValue(base?.ref),
      created_at: stringValue(item.created_at),
      draft: booleanValue(item.draft),
      head: stringValue(head?.ref),
      pr_number: numberValue(item.number),
      state: stringValue(item.state),
      title: stringValue(item.title),
      updated_at: stringValue(item.updated_at),
      url: stringValue(item.html_url),
    };
  }

  private async searchPullRequests(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const { page, perPage } = this.page(args);
    const query = stringValue(args.query);
    const state = stringValue(args.state) ?? "open";
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    let response: ApiResponse;
    let items: JsonRecord[];
    if (query) {
      const safeQuery = validateCodeSearchQuery(query);
      const qualifiers = [
        `repo:${coordinates.fullName}`,
        "is:pr",
        ...(state === "all" ? [] : [`is:${state}`]),
        ...(stringValue(args.base) ? [`base:${stringValue(args.base)}`] : []),
        ...(stringValue(args.head) ? [`head:${stringValue(args.head)}`] : []),
      ];
      response = await this.request(octokit, "GET /search/issues", {
        page,
        per_page: perPage,
        q: `${safeQuery} ${qualifiers.join(" ")}`,
      });
      items = records(record(response.data).items);
    } else {
      response = await this.request(octokit, "GET /repos/{owner}/{repo}/pulls", {
        owner: coordinates.owner,
        page,
        per_page: perPage,
        repo: coordinates.repo,
        state,
        ...(stringValue(args.base) ? { base: stringValue(args.base) } : {}),
        ...(stringValue(args.head) ? { head: stringValue(args.head) } : {}),
      });
      items = records(response.data);
    }
    const pullRequests = items.map((item) => this.pullRequestSummary(item));
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("search_prs", args, page + 1)
      : undefined;
    return fitCollection(
      "search_prs",
      { pagination: pagination(page, perPage, pullRequests.length, response) },
      "pull_requests",
      pullRequests,
      nextRequest,
    ).data;
  }

  private async getPullRequestData(repository: string, prNumber: number): Promise<JsonRecord> {
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: coordinates.owner,
      pull_number: prNumber,
      repo: coordinates.repo,
    });
    return record(response.data);
  }

  private async getPullRequest(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const prNumber = numberValue(args.pr_number);
    if (prNumber === null) throw new GatewayError("invalid_arguments", "pr_number is required");
    const data = await this.getPullRequestData(coordinates.fullName, prNumber);
    const base = nested(data, "base");
    const head = nested(data, "head");
    return {
      additions: numberValue(data.additions),
      author: userLogin(data.user),
      base: {
        commit_sha: stringValue(base.sha),
        ref: stringValue(base.ref),
        repository_full_name: stringValue(optionalNested(base, "repo")?.full_name),
      },
      body: await this.inlineText("pr_body", stringValue(data.body), {
        pr_number: prNumber,
        repository_full_name: coordinates.fullName,
      }),
      changed_files: numberValue(data.changed_files),
      commits: numberValue(data.commits),
      created_at: stringValue(data.created_at),
      deletions: numberValue(data.deletions),
      draft: booleanValue(data.draft),
      head: {
        commit_sha: stringValue(head.sha),
        ref: stringValue(head.ref),
        repository_full_name: stringValue(optionalNested(head, "repo")?.full_name),
      },
      mergeable: data.mergeable ?? null,
      merged: booleanValue(data.merged),
      pr_number: numberValue(data.number),
      state: stringValue(data.state),
      title: stringValue(data.title),
      updated_at: stringValue(data.updated_at),
      url: stringValue(data.html_url),
    };
  }

  private pullRequestFileSummary(file: JsonRecord) {
    return {
      additions: numberValue(file.additions),
      blob_sha: stringValue(file.sha),
      changes: numberValue(file.changes),
      deletions: numberValue(file.deletions),
      path: stringValue(file.filename),
      previous_path: stringValue(file.previous_filename),
      status: stringValue(file.status),
      url: stringValue(file.blob_url),
    };
  }

  private async pullRequestFilesPage(repository: string, prNumber: number, page: number, perPage: number) {
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: coordinates.owner,
      page,
      per_page: perPage,
      pull_number: prNumber,
      repo: coordinates.repo,
    });
    return { files: records(response.data), response };
  }

  private async listPullRequestFiles(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const prNumber = numberValue(args.pr_number);
    if (prNumber === null) throw new GatewayError("invalid_arguments", "pr_number is required");
    const { page, perPage } = this.page(args);
    const result = await this.pullRequestFilesPage(coordinates.fullName, prNumber, page, perPage);
    const files = result.files.map((file) => this.pullRequestFileSummary(file));
    const nextRequest = hasNextLink(header(result.response, "link"))
      ? this.next("list_pr_changed_filenames", args, page + 1)
      : undefined;
    return fitCollection(
      "list_pr_changed_filenames",
      { pagination: pagination(page, perPage, files.length, result.response), pr_number: prNumber },
      "files",
      files,
      nextRequest,
    ).data;
  }

  private async findPullRequestFile(repository: string, prNumber: number, path: string): Promise<JsonRecord> {
    let page = 1;
    while (page <= MAX_SUBREQUESTS) {
      const result = await this.pullRequestFilesPage(repository, prNumber, page, 20);
      const file = result.files.find((candidate) => stringValue(candidate.filename) === path);
      if (file) return file;
      if (!hasNextLink(header(result.response, "link"))) break;
      page += 1;
    }
    throw new GatewayError("invalid_arguments", "The path is not in the pull request changed-filename list");
  }

  private async fetchPullRequestPatch(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const prNumber = numberValue(args.pr_number);
    const path = stringValue(args.path);
    if (prNumber === null || !path) throw new GatewayError("invalid_arguments", "pr_number and path are required");
    const [pullRequest, file] = await Promise.all([
      this.getPullRequestData(coordinates.fullName, prNumber),
      this.findPullRequestFile(coordinates.fullName, prNumber, path),
    ]);
    const baseData = nested(pullRequest, "base");
    const headData = nested(pullRequest, "head");
    const base = {
      commit_sha: stringValue(baseData.sha),
      repository_full_name: stringValue(optionalNested(baseData, "repo")?.full_name),
      type: "commit",
    };
    const target = {
      commit_sha: stringValue(headData.sha),
      repository_full_name: stringValue(optionalNested(headData, "repo")?.full_name),
      type: "commit",
    };
    const patch = stringValue(file.patch);
    const status = stringValue(file.status);
    const fileType = await this.fileTypeAt(
      coordinates.fullName,
      status === "removed" ? stringValue(baseData.sha) : stringValue(headData.sha),
      status === "removed" ? stringValue(file.previous_filename) ?? path : path,
    );
    return {
      base,
      blob_sha: stringValue(file.sha),
      completeness: "unverified",
      file_type: fileType,
      path,
      previous_path: stringValue(file.previous_filename),
      pr_number: prNumber,
      repository_full_name: coordinates.fullName,
      source: "github",
      status,
      target,
      ...(patch
        ? { patch: await this.inlineText("pr_patch", patch, { path, pr_number: prNumber, repository_full_name: coordinates.fullName }) }
        : { patch: null, patch_availability: "omitted_by_github" }),
    };
  }

  private async listPullRequestReviews(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const prNumber = numberValue(args.pr_number);
    if (prNumber === null) throw new GatewayError("invalid_arguments", "pr_number is required");
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: coordinates.owner,
      page,
      per_page: perPage,
      pull_number: prNumber,
      repo: coordinates.repo,
    });
    const reviews = [];
    for (const review of records(response.data)) {
      const body = stringValue(review.body) ?? "";
      reviews.push({
        author: userLogin(review.user),
        body_reference_token: await this.textReference("pr_review", body, {
          pr_number: prNumber,
          repository_full_name: coordinates.fullName,
          review_id: numberValue(review.id),
        }),
        commit_sha: stringValue(review.commit_id),
        review_id: numberValue(review.id),
        state: stringValue(review.state),
        submitted_at: stringValue(review.submitted_at),
        url: stringValue(review.html_url),
      });
    }
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("list_pull_request_reviews", args, page + 1)
      : undefined;
    return fitCollection(
      "list_pull_request_reviews",
      { pagination: pagination(page, perPage, reviews.length, response), pr_number: prNumber },
      "reviews",
      reviews,
      nextRequest,
    ).data;
  }

  private issueSummary(issue: JsonRecord) {
    return {
      assignees: Array.isArray(issue.assignees) ? records(issue.assignees).map((assignee) => stringValue(assignee.login)) : [],
      author: userLogin(issue.user),
      created_at: stringValue(issue.created_at),
      issue_number: numberValue(issue.number),
      labels: labelNames(issue.labels),
      state: stringValue(issue.state),
      title: stringValue(issue.title),
      updated_at: stringValue(issue.updated_at),
      url: stringValue(issue.html_url),
    };
  }

  private async searchIssues(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const { page, perPage } = this.page(args);
    const query = stringValue(args.query);
    const state = stringValue(args.state) ?? "open";
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    let response: ApiResponse;
    let sourceItems: JsonRecord[];
    if (query) {
      const safeQuery = validateCodeSearchQuery(query);
      const qualifiers = [
        `repo:${coordinates.fullName}`,
        "is:issue",
        ...(state === "all" ? [] : [`is:${state}`]),
        ...(stringValue(args.assignee) ? [`assignee:${stringValue(args.assignee)}`] : []),
        ...(stringValue(args.labels)
          ? stringValue(args.labels)?.split(",").map((label) => `label:${JSON.stringify(label.trim())}`) ?? []
          : []),
        ...(stringValue(args.since) ? [`updated:>=${stringValue(args.since)}`] : []),
      ];
      response = await this.request(octokit, "GET /search/issues", {
        page,
        per_page: perPage,
        q: `${safeQuery} ${qualifiers.join(" ")}`,
      });
      sourceItems = records(record(response.data).items);
    } else {
      response = await this.request(octokit, "GET /repos/{owner}/{repo}/issues", {
        owner: coordinates.owner,
        page,
        per_page: perPage,
        repo: coordinates.repo,
        state,
        ...(stringValue(args.assignee) ? { assignee: stringValue(args.assignee) } : {}),
        ...(stringValue(args.labels) ? { labels: stringValue(args.labels) } : {}),
        ...(stringValue(args.since) ? { since: stringValue(args.since) } : {}),
      });
      sourceItems = records(response.data);
    }
    const issues = sourceItems.filter((issue) => issue.pull_request === undefined).map((issue) => this.issueSummary(issue));
    const hasNext = hasNextLink(header(response, "link"));
    const nextRequest = hasNext ? this.next("search_issues", args, page + 1) : undefined;
    const stateValue = hasNext && issues.length === 0 ? "seeking" : hasNext ? "partial" : "complete";
    return fitCollection(
      "search_issues",
      { pagination: pagination(page, perPage, sourceItems.length, response), state: stateValue },
      "issues",
      issues,
      nextRequest,
    ).data;
  }

  private async fetchIssue(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const issueNumber = numberValue(args.issue_number);
    if (issueNumber === null) throw new GatewayError("invalid_arguments", "issue_number is required");
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}", {
      issue_number: issueNumber,
      owner: coordinates.owner,
      repo: coordinates.repo,
    });
    const issue = record(response.data);
    if (issue.pull_request !== undefined) {
      throw new GatewayError("invalid_arguments", "This number is a pull request. Use get_pr_info");
    }
    return {
      ...this.issueSummary(issue),
      body: await this.inlineText("issue_body", stringValue(issue.body), {
        issue_number: issueNumber,
        repository_full_name: coordinates.fullName,
      }),
    };
  }

  private async listIssueComments(args: JsonRecord, pullRequest: boolean): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const number = numberValue(pullRequest ? args.pr_number : args.issue_number);
    if (number === null) throw new GatewayError("invalid_arguments", pullRequest ? "pr_number is required" : "issue_number is required");
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      issue_number: number,
      owner: coordinates.owner,
      page,
      per_page: perPage,
      repo: coordinates.repo,
    });
    const comments = [];
    for (const comment of records(response.data)) {
      const body = stringValue(comment.body) ?? "";
      comments.push({
        author: userLogin(comment.user),
        body_reference_token: await this.textReference("issue_comment", body, {
          comment_id: numberValue(comment.id),
          repository_full_name: coordinates.fullName,
        }),
        comment_id: numberValue(comment.id),
        created_at: stringValue(comment.created_at),
        updated_at: stringValue(comment.updated_at),
        url: stringValue(comment.html_url),
      });
    }
    const operation: OperationName = pullRequest ? "list_pull_request_comments" : "list_issue_comments";
    const nextRequest = hasNextLink(header(response, "link")) ? this.next(operation, args, page + 1) : undefined;
    return fitCollection(
      operation,
      { pagination: pagination(page, perPage, comments.length, response), [pullRequest ? "pr_number" : "issue_number"]: number },
      "comments",
      comments,
      nextRequest,
    ).data;
  }

  private workflowRunSummary(run: JsonRecord) {
    return {
      attempt: numberValue(run.run_attempt),
      conclusion: stringValue(run.conclusion),
      created_at: stringValue(run.created_at),
      event: stringValue(run.event),
      head_branch: stringValue(run.head_branch),
      head_sha: stringValue(run.head_sha),
      name: stringValue(run.name),
      run_id: numberValue(run.id),
      run_number: numberValue(run.run_number),
      status: stringValue(run.status),
      updated_at: stringValue(run.updated_at),
      url: stringValue(run.html_url),
      workflow_id: numberValue(run.workflow_id),
    };
  }

  private async listWorkflowRuns(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const commitSha = stringValue(args.commit_sha);
    if (!commitSha) throw new GatewayError("invalid_arguments", "commit_sha is required");
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/actions/runs", {
      head_sha: commitSha,
      owner: coordinates.owner,
      page,
      per_page: perPage,
      repo: coordinates.repo,
    });
    const data = record(response.data);
    const runs = records(data.workflow_runs).map((run) => this.workflowRunSummary(run));
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("fetch_commit_workflow_runs", args, page + 1)
      : undefined;
    return fitCollection(
      "fetch_commit_workflow_runs",
      { commit_sha: commitSha, pagination: pagination(page, perPage, runs.length, response), total_count: numberValue(data.total_count) },
      "workflow_runs",
      runs,
      nextRequest,
    ).data;
  }

  private async workflowRunData(repository: string, runId: number): Promise<JsonRecord> {
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
      owner: coordinates.owner,
      repo: coordinates.repo,
      run_id: runId,
    });
    return record(response.data);
  }

  private async fetchWorkflowRun(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const runId = numberValue(args.run_id);
    if (runId === null) throw new GatewayError("invalid_arguments", "run_id is required");
    const run = await this.workflowRunData(coordinates.fullName, runId);
    return {
      ...this.workflowRunSummary(run),
      actor: userLogin(run.actor),
      cancel_url: stringValue(run.cancel_url),
      check_suite_id: numberValue(run.check_suite_id),
      jobs_url: stringValue(run.jobs_url),
      logs_url: stringValue(run.logs_url),
      repository_full_name: coordinates.fullName,
      rerun_url: stringValue(run.rerun_url),
      workflow_url: stringValue(run.workflow_url),
    };
  }

  private workflowJobSummary(job: JsonRecord) {
    return {
      completed_at: stringValue(job.completed_at),
      conclusion: stringValue(job.conclusion),
      head_sha: stringValue(job.head_sha),
      job_id: numberValue(job.id),
      name: stringValue(job.name),
      runner_group_name: stringValue(job.runner_group_name),
      runner_name: stringValue(job.runner_name),
      started_at: stringValue(job.started_at),
      status: stringValue(job.status),
      url: stringValue(job.html_url),
    };
  }

  private async listWorkflowJobs(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const runId = numberValue(args.run_id);
    if (runId === null) throw new GatewayError("invalid_arguments", "run_id is required");
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      filter: stringValue(args.filter) ?? "latest",
      owner: coordinates.owner,
      page,
      per_page: perPage,
      repo: coordinates.repo,
      run_id: runId,
    });
    const data = record(response.data);
    const jobs = records(data.jobs).map((job) => this.workflowJobSummary(job));
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("fetch_workflow_run_jobs", args, page + 1)
      : undefined;
    return fitCollection(
      "fetch_workflow_run_jobs",
      { pagination: pagination(page, perPage, jobs.length, response), run_id: runId, total_count: numberValue(data.total_count) },
      "jobs",
      jobs,
      nextRequest,
    ).data;
  }

  private async listWorkflowSteps(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const jobId = numberValue(args.job_id);
    if (jobId === null) throw new GatewayError("invalid_arguments", "job_id is required");
    const offset = numberValue(args.offset) ?? 0;
    const limit = numberValue(args.limit) ?? 20;
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/actions/jobs/{job_id}", {
      job_id: jobId,
      owner: coordinates.owner,
      repo: coordinates.repo,
    });
    const job = record(response.data);
    const all = Array.isArray(job.steps) ? records(job.steps) : [];
    const steps = all.slice(offset, offset + limit).map((step) => ({
      completed_at: stringValue(step.completed_at),
      conclusion: stringValue(step.conclusion),
      name: stringValue(step.name),
      number: numberValue(step.number),
      started_at: stringValue(step.started_at),
      status: stringValue(step.status),
    }));
    const nextOffset = offset + steps.length < all.length ? offset + steps.length : null;
    const nextRequest = nextOffset === null
      ? undefined
      : exactNextRequest("fetch_workflow_job_steps", { ...args, offset: nextOffset });
    return fitCollection(
      "fetch_workflow_job_steps",
      { job_id: jobId, next_offset: nextOffset, total_steps: all.length },
      "steps",
      steps,
      nextRequest,
    ).data;
  }

  private artifactSummary(artifact: JsonRecord) {
    return {
      artifact_id: numberValue(artifact.id),
      created_at: stringValue(artifact.created_at),
      expired: booleanValue(artifact.expired),
      expires_at: stringValue(artifact.expires_at),
      name: stringValue(artifact.name),
      size_in_bytes: numberValue(artifact.size_in_bytes),
      updated_at: stringValue(artifact.updated_at),
    };
  }

  private async listWorkflowArtifacts(args: JsonRecord): Promise<unknown> {
    const coordinates = this.coordinates(args);
    const runId = numberValue(args.run_id);
    if (runId === null) throw new GatewayError("invalid_arguments", "run_id is required");
    const { page, perPage } = this.page(args);
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
      owner: coordinates.owner,
      page,
      per_page: perPage,
      repo: coordinates.repo,
      run_id: runId,
      ...(stringValue(args.name) ? { name: stringValue(args.name) } : {}),
    });
    const data = record(response.data);
    const artifacts = records(data.artifacts).map((artifact) => this.artifactSummary(artifact));
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("fetch_workflow_run_artifacts", args, page + 1)
      : undefined;
    return fitCollection(
      "fetch_workflow_run_artifacts",
      { pagination: pagination(page, perPage, artifacts.length, response), run_id: runId, total_count: numberValue(data.total_count) },
      "artifacts",
      artifacts,
      nextRequest,
    ).data;
  }

  private async downloadArtifact(args: JsonRecord): Promise<BackendResult> {
    const coordinates = this.coordinates(args);
    const artifactId = numberValue(args.artifact_id);
    if (artifactId === null) throw new GatewayError("invalid_arguments", "artifact_id is required");
    const { octokit } = await this.repositoryClient(coordinates.fullName);
    const response = await this.request(octokit, "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}", {
      artifact_id: artifactId,
      owner: coordinates.owner,
      repo: coordinates.repo,
    });
    const artifact = record(response.data);
    if (booleanValue(artifact.expired)) throw new GatewayError("not_found", "The workflow artifact expired");
    const resource = {
      artifact_id: artifactId,
      name: stringValue(artifact.name),
      repository_full_name: coordinates.fullName,
      size_in_bytes: numberValue(artifact.size_in_bytes),
    };
    const token = await this.sealToken(
      "artifact",
      "download_workflow_artifact",
      await argumentHash(resource),
      resource,
      {},
      ARTIFACT_TTL_SECONDS,
    );
    const uri = `${this.reader.artifactBaseUrl}/artifacts/v1/${token}`;
    return {
      data: { ...this.artifactSummary(artifact), bearer_credential: true, expires_in_seconds: ARTIFACT_TTL_SECONDS, uri },
      resource_link: {
        description: "Short-lived bearer link for the complete workflow artifact ZIP.",
        mimeType: "application/zip",
        name: `${stringValue(artifact.name) ?? "workflow-artifact"}.zip`,
        ...(numberValue(artifact.size_in_bytes) !== null ? { size: numberValue(artifact.size_in_bytes) as number } : {}),
        uri,
      },
    };
  }

  private memberSummary(member: JsonRecord) {
    return {
      avatar_url: stringValue(member.avatar_url),
      type: stringValue(member.type),
      url: stringValue(member.html_url),
      username: stringValue(member.login),
    };
  }

  private async listOrganizationMembers(args: JsonRecord): Promise<unknown> {
    const organization = stringValue(args.organization);
    if (!organization) throw new GatewayError("invalid_arguments", "organization is required");
    const { page, perPage } = this.page(args);
    const octokit = await this.organizationClient(organization);
    const response = await this.request(octokit, "GET /orgs/{org}/members", {
      org: organization,
      page,
      per_page: perPage,
    });
    const members = records(response.data).map((member) => this.memberSummary(member));
    const nextRequest = hasNextLink(header(response, "link"))
      ? this.next("list_organization_members", args, page + 1)
      : undefined;
    return fitCollection(
      "list_organization_members",
      { organization, pagination: pagination(page, perPage, members.length, response) },
      "members",
      members,
      nextRequest,
    ).data;
  }

  private async searchOrganizationMembers(args: JsonRecord): Promise<unknown> {
    const organization = stringValue(args.organization);
    const query = stringValue(args.query)?.trim().toLowerCase();
    const pageSize = numberValue(args.page_size) ?? 20;
    if (!organization || !query) throw new GatewayError("invalid_arguments", "organization and query are required");
    const normalizedArgs = { organization, page_size: pageSize, query };
    const argsHash = await argumentHash(normalizedArgs);
    let page = 1;
    let offset = 0;
    const token = stringValue(args.continuation_token);
    if (token) {
      const payload = await this.reader.tokens.open(token, {
        operation: "search_organization_members",
        purpose: "organization_scan",
        user_id: this.userId,
      });
      if (payload.args_hash !== argsHash || stringValue(payload.resource.organization) !== organization) {
        throw new GatewayError("invalid_token", "The organization scan token does not match this request");
      }
      page = numberValue(payload.cursor.page) ?? 1;
      offset = numberValue(payload.cursor.offset) ?? 0;
    }
    const octokit = await this.organizationClient(organization);
    const selected: unknown[] = [];
    let complete = false;
    let cursor = { offset, page };
    while (this.subrequests < MAX_SUBREQUESTS) {
      const response = await this.request(octokit, "GET /orgs/{org}/members", {
        org: organization,
        page,
        per_page: 100,
      });
      const members = records(response.data);
      for (let index = offset; index < members.length; index += 1) {
        cursor = { offset: index + 1, page };
        const member = this.memberSummary(members[index] ?? {});
        if (member.username?.toLowerCase().includes(query)) selected.push(member);
        if (selected.length >= pageSize) break;
      }
      if (selected.length >= pageSize) break;
      if (!hasNextLink(header(response, "link"))) {
        complete = true;
        break;
      }
      page += 1;
      offset = 0;
      cursor = { offset: 0, page };
    }
    let nextRequest: NextRequest | undefined;
    if (!complete) {
      const continuationToken = await this.sealToken(
        "organization_scan",
        "search_organization_members",
        argsHash,
        { organization },
        cursor,
        SCAN_TTL_SECONDS,
      );
      nextRequest = exactNextRequest("search_organization_members", {
        ...normalizedArgs,
        continuation_token: continuationToken,
      });
    }
    const state = complete ? "complete" : selected.length === 0 ? "seeking" : "partial";
    return fitCollection(
      "search_organization_members",
      { organization, state },
      "members",
      selected,
      nextRequest,
    ).data;
  }

  private async getOrganizationMembership(args: JsonRecord): Promise<unknown> {
    const organization = stringValue(args.organization);
    const username = stringValue(args.username);
    if (!organization || !username) throw new GatewayError("invalid_arguments", "organization and username are required");
    const octokit = await this.organizationClient(organization);
    const response = await this.request(octokit, "GET /orgs/{org}/memberships/{username}", {
      org: organization,
      username,
    });
    const membership = record(response.data);
    return {
      organization,
      organization_url: stringValue(optionalNested(membership, "organization")?.html_url),
      role: stringValue(membership.role),
      state: stringValue(membership.state),
      username: userLogin(membership.user) ?? username,
    };
  }

  private requiredString(resource: JsonRecord, key: string): string {
    const value = stringValue(resource[key]);
    if (!value) throw new GatewayError("invalid_token", `The text token has invalid ${key} data`);
    return value;
  }

  private requiredNumber(resource: JsonRecord, key: string): number {
    const value = numberValue(resource[key]);
    if (value === null) throw new GatewayError("invalid_token", `The text token has invalid ${key} data`);
    return value;
  }

  private async textForResource(resource: JsonRecord): Promise<string> {
    const kind = this.requiredString(resource, "kind");
    const repository = this.requiredString(resource, "repository_full_name");
    const coordinates = parseRepository(repository);
    const { octokit } = await this.repositoryClient(repository);
    if (kind === "issue_body") {
      const response = await this.request(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: this.requiredNumber(resource, "issue_number"),
        owner: coordinates.owner,
        repo: coordinates.repo,
      });
      return stringValue(record(response.data).body) ?? "";
    }
    if (kind === "pr_body") {
      const pullRequest = await this.getPullRequestData(repository, this.requiredNumber(resource, "pr_number"));
      return stringValue(pullRequest.body) ?? "";
    }
    if (kind === "issue_comment") {
      const response = await this.request(octokit, "GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        comment_id: this.requiredNumber(resource, "comment_id"),
        owner: coordinates.owner,
        repo: coordinates.repo,
      });
      return stringValue(record(response.data).body) ?? "";
    }
    if (kind === "pr_review") {
      const response = await this.request(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}", {
        owner: coordinates.owner,
        pull_number: this.requiredNumber(resource, "pr_number"),
        repo: coordinates.repo,
        review_id: this.requiredNumber(resource, "review_id"),
      });
      return stringValue(record(response.data).body) ?? "";
    }
    if (kind === "commit_message") {
      const response = await this.request(octokit, "GET /repos/{owner}/{repo}/commits/{ref}", {
        owner: coordinates.owner,
        ref: this.requiredString(resource, "commit_sha"),
        repo: coordinates.repo,
      });
      return stringValue(nested(record(response.data), "commit").message) ?? "";
    }
    if (kind === "commit_patch") {
      const found = await this.findCommitFile(
        repository,
        this.requiredString(resource, "commit_sha"),
        this.requiredString(resource, "path"),
      );
      return stringValue(found.file.patch) ?? "";
    }
    if (kind === "pr_patch") {
      const file = await this.findPullRequestFile(
        repository,
        this.requiredNumber(resource, "pr_number"),
        this.requiredString(resource, "path"),
      );
      return stringValue(file.patch) ?? "";
    }
    throw new GatewayError("invalid_token", "The text token has an unknown resource kind");
  }

  private async readText(args: JsonRecord): Promise<unknown> {
    const referenceToken = stringValue(args.reference_token);
    const continuationToken = stringValue(args.continuation_token);
    const token = referenceToken ?? continuationToken;
    if (!token) throw new GatewayError("invalid_arguments", "reference_token or continuation_token is required");
    const payload = await this.reader.tokens.open(token, {
      operation: "read_text",
      purpose: "text",
      user_id: this.userId,
    });
    if (payload.args_hash !== await argumentHash(payload.resource)) {
      throw new GatewayError("invalid_token", "The text token resource does not match its binding");
    }
    const text = await this.textForResource(payload.resource);
    const currentHash = await bodyHash(text);
    if (currentHash !== stringValue(payload.resource.body_hash)) {
      throw new GatewayError("stale_reference", "The GitHub text changed after this reference was created");
    }
    const startLine = referenceToken
      ? numberValue(args.start_line) ?? 1
      : numberValue(payload.cursor.next_line) ?? 1;
    const endLine = referenceToken ? numberValue(args.end_line) ?? undefined : undefined;
    const window = sliceKnownText(text, startLine, endLine);
    if (window.state === "range_too_large") {
      const largestSafeEnd = window.largest_safe_end_line ?? startLine;
      throw new GatewayError(
        "range_too_large",
        `The requested range is too large. The largest safe end_line is ${largestSafeEnd}`,
        false,
        {
          largest_safe_end_line: largestSafeEnd,
          next_request: exactNextRequest("read_text", {
            end_line: largestSafeEnd,
            reference_token: token,
            start_line: startLine,
          }),
        },
      );
    }
    let nextRequest: NextRequest | undefined;
    if (window.next_line !== undefined) {
      const nextToken = await this.sealToken(
        "text",
        "read_text",
        payload.args_hash,
        payload.resource,
        { next_line: window.next_line },
        TEXT_TTL_SECONDS,
      );
      nextRequest = exactNextRequest("read_text", { continuation_token: nextToken });
    }
    return {
      ...(window.content !== undefined ? { content: window.content } : {}),
      ...(window.end_line !== undefined ? { end_line: window.end_line } : {}),
      ...(nextRequest ? { next_request: nextRequest } : {}),
      ...(window.start_line !== undefined ? { start_line: window.start_line } : {}),
      state: window.state,
      total_lines: window.total_lines,
    };
  }
}
