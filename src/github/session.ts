import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { GatewayError } from "../errors";
import { numberValue, record, stringValue } from "./json";
import { parseRepository } from "./repository";
import { hasNextLink } from "./result";

export const GITHUB_API_VERSION = "2026-03-10";
export const MAX_SUBREQUESTS = 20;

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

export interface ApiResponse {
  data: unknown;
  headers: Record<string, string | undefined>;
  status?: number;
}

export interface OctokitLike {
  request(route: string, parameters?: Record<string, unknown>): Promise<ApiResponse>;
}

export type AppAuthentication = (options: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** How a session authenticates as the GitHub App and builds REST clients. Tests replace both. */
export interface GitHubClientFactories {
  auth: AppAuthentication;
  octokit: (token?: string) => OctokitLike;
}

export function createGitHubClients(app: GitHubAppConfig, fetchImpl: typeof fetch = fetch): GitHubClientFactories {
  const boundFetch = fetchImpl.bind(globalThis);
  const versionedRequest = new Octokit({ request: { fetch: boundFetch } }).request.defaults({
    headers: { "x-github-api-version": GITHUB_API_VERSION },
  });
  return {
    auth: createAppAuth({
      appId: app.appId,
      privateKey: app.privateKey,
      request: versionedRequest,
    }) as unknown as AppAuthentication,
    octokit: (token) =>
      new Octokit({ ...(token ? { auth: token } : {}), request: { fetch: boundFetch } }) as unknown as OctokitLike,
  };
}

export function hasNextPage(response: ApiResponse): boolean {
  return hasNextLink(response.headers.link);
}

/** Counts the GitHub requests of one tool call, including requests made after a public fallback. */
class RequestBudget {
  private used = 0;

  get remaining(): number {
    return MAX_SUBREQUESTS - this.used;
  }

  spend(): void {
    this.used += 1;
    if (this.used > MAX_SUBREQUESTS) {
      throw new GatewayError("upstream_error", `The operation reached the ${MAX_SUBREQUESTS}-subrequest safety limit`);
    }
  }
}

/** A REST client whose requests count against the session budget and pin the API version. */
export class GitHubClient {
  constructor(
    private readonly budget: RequestBudget,
    private readonly octokit: OctokitLike,
  ) {}

  request(route: string, parameters: Record<string, unknown> = {}): Promise<ApiResponse> {
    this.budget.spend();
    return this.octokit.request(route, { ...parameters, headers: { "x-github-api-version": GITHUB_API_VERSION } });
  }
}

/** A client for one repository. `request` fills the `{owner}` and `{repo}` route parameters. */
export class RepositoryClient {
  constructor(
    readonly owner: string,
    readonly repo: string,
    /** For routes outside `/repos/{owner}/{repo}`, such as search. */
    readonly api: GitHubClient,
    /** The installation token, or undefined for an unauthenticated public read. */
    readonly token: string | undefined,
  ) {}

  get fullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  request(route: string, parameters: Record<string, unknown> = {}): Promise<ApiResponse> {
    return this.api.request(route, { owner: this.owner, repo: this.repo, ...parameters });
  }
}

/**
 * GitHub access for one tool call. An installation session reads only through GitHub App
 * installation tokens. A public session reads without credentials and shares the budget.
 */
export class GitHubSession {
  private appClientPromise?: Promise<GitHubClient>;
  private readonly repositories = new Map<string, Promise<RepositoryClient>>();

  constructor(
    private readonly clients: GitHubClientFactories,
    private readonly access: "installation" | "public" = "installation",
    private readonly budget = new RequestBudget(),
  ) {}

  get remainingRequests(): number {
    return this.budget.remaining;
  }

  /** Records one GitHub request that does not go through a GitHubClient. */
  spend(): void {
    this.budget.spend();
  }

  publicSession(): GitHubSession {
    return new GitHubSession(this.clients, "public", this.budget);
  }

  appClient(): Promise<GitHubClient> {
    this.appClientPromise ??= this.createAppClient();
    return this.appClientPromise;
  }

  async installationClient(installationId: number, repositoryName?: string): Promise<{ client: GitHubClient; token: string }> {
    this.budget.spend();
    const authentication = await this.clients.auth({
      installationId,
      type: "installation",
      ...(repositoryName ? { repositoryNames: [repositoryName] } : {}),
    });
    const token = stringValue(authentication.token);
    if (!token) throw new GatewayError("installation_required", "GitHub did not issue an installation token");
    return { client: new GitHubClient(this.budget, this.clients.octokit(token)), token };
  }

  repository(fullName: string): Promise<RepositoryClient> {
    const { owner, repo, fullName: key } = parseRepository(fullName);
    let client = this.repositories.get(key);
    if (!client) {
      client = this.openRepository(owner, repo);
      this.repositories.set(key, client);
    }
    return client;
  }

  async organization(organization: string): Promise<GitHubClient> {
    if (this.access === "public") return new GitHubClient(this.budget, this.clients.octokit());
    const app = await this.appClient();
    const installation = await app.request("GET /orgs/{org}/installation", { org: organization });
    const installationId = numberValue(record(installation.data).id);
    if (installationId === null) throw new GatewayError("installation_required", "The organization is not installed");
    return (await this.installationClient(installationId)).client;
  }

  private async createAppClient(): Promise<GitHubClient> {
    const authentication = await this.clients.auth({ type: "app" });
    const token = stringValue(authentication.token);
    if (!token) throw new GatewayError("installation_required", "GitHub did not issue an App token");
    return new GitHubClient(this.budget, this.clients.octokit(token));
  }

  private async openRepository(owner: string, repo: string): Promise<RepositoryClient> {
    if (this.access === "public") {
      return new RepositoryClient(owner, repo, new GitHubClient(this.budget, this.clients.octokit()), undefined);
    }
    const app = await this.appClient();
    const installation = await app.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
    const installationId = numberValue(record(installation.data).id);
    if (installationId === null) throw new GatewayError("installation_required", "The repository is not installed");
    const { client, token } = await this.installationClient(installationId, repo);
    return new RepositoryClient(owner, repo, client, token);
  }
}
