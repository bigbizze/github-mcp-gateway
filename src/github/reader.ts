import { githubStatus } from "../errors";
import type { ReferenceTokens } from "../security/reference-token";
import { type OperationCall, type OperationName, parseOperation } from "./catalog";
import { commitOperations } from "./operations/commits";
import { OperationContext, type OperationHandlers, type ReaderServices } from "./operations/context";
import { fileOperations } from "./operations/files";
import { issueOperations } from "./operations/issues";
import { organizationOperations } from "./operations/organizations";
import { pullRequestOperations } from "./operations/pull-requests";
import { repositoryOperations } from "./operations/repositories";
import { textReferenceOperations } from "./operations/text-references";
import { ARTIFACT_SCOPE, artifactDownloadUrl, artifactLinkSchema, workflowOperations } from "./operations/workflows";
import type { RangeRequest } from "./range-http";
import type { OperationResult } from "./result";
import { type GitHubClientFactories, GitHubSession } from "./session";
import { mapGitHubUrl } from "./url-router";

type AnyHandler = (context: OperationContext, input: OperationCall["arguments"]) => Promise<OperationResult>;

function run(context: OperationContext, call: OperationCall): Promise<OperationResult> {
  return (handlers[call.operation] as AnyHandler)(context, call.arguments);
}

const handlers: OperationHandlers<OperationName> = {
  ...repositoryOperations,
  ...fileOperations,
  ...commitOperations,
  ...pullRequestOperations,
  ...issueOperations,
  ...workflowOperations,
  ...organizationOperations,
  ...textReferenceOperations,

  /**
   * Maps a GitHub URL to another operation. If the installation cannot see the resource, the
   * operation runs once more without credentials, so public resources can still be read.
   */
  async fetch(context, input) {
    const mapped = mapGitHubUrl(input.url);
    const call = parseOperation(mapped.operation, mapped.arguments);
    try {
      return await run(context, call);
    } catch (error) {
      if (githubStatus(error) !== 404) throw error;
      return run(context.publicContext(), call);
    }
  },
};

export interface GitHubReaderOptions {
  artifactBaseUrl: string;
  clients: GitHubClientFactories;
  fetch?: typeof fetch;
  rangeRequest?: RangeRequest;
  tokens: ReferenceTokens;
}

function missingRangeTransport(): never {
  throw new Error("No byte-range transport is configured");
}

/** Runs catalog operations against GitHub on behalf of one signed-in user. */
export class GitHubReader {
  private readonly clients: GitHubClientFactories;
  private readonly services: ReaderServices;

  constructor(options: GitHubReaderOptions) {
    this.clients = options.clients;
    this.services = {
      artifactBaseUrl: options.artifactBaseUrl.replace(/\/$/u, ""),
      fetch: (options.fetch ?? fetch).bind(globalThis),
      rangeRequest: options.rangeRequest ?? missingRangeTransport,
      tokens: options.tokens,
    };
  }

  execute(call: OperationCall, userId: number): Promise<OperationResult> {
    return run(new OperationContext(new GitHubSession(this.clients), this.services, userId), call);
  }

  /**
   * Resolves an artifact link to GitHub's signed storage URL for the ZIP. The link is a bearer
   * credential: it works without sign-in until it expires.
   */
  async artifactRedirect(token: string): Promise<string> {
    const { body } = await this.services.tokens.open(token, ARTIFACT_SCOPE, "any", artifactLinkSchema);
    return artifactDownloadUrl(new GitHubSession(this.clients), this.services.fetch, body);
  }
}
