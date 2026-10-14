import { vi } from "vitest";
import { parseOperation } from "../../src/github/catalog";
import type { RangeRequest } from "../../src/github/range-http";
import { GitHubReader } from "../../src/github/reader";
import type { OperationResult } from "../../src/github/result";
import type { OctokitLike } from "../../src/github/session";
import { ReferenceTokens } from "../../src/security/reference-token";

export const TEST_USER_ID = 42;

export type RequestHandler = OctokitLike["request"];

export interface TestReaderOptions {
  fetch?: typeof fetch;
  keyHex?: string;
  now?: () => number;
  /** Chooses the REST client for a token. The default returns `request` for every token. */
  octokit?: (token: string | undefined) => OctokitLike;
  rangeRequest?: RangeRequest;
  request?: RequestHandler;
}

/**
 * A GitHubReader whose App authentication returns `app` for the App token and
 * `installation-<id>` for installation tokens.
 */
export function testReader(options: TestReaderOptions = {}) {
  const request = vi.fn<RequestHandler>(options.request ?? (async (route) => {
    throw new Error(`Unexpected route ${route}`);
  }));
  const tokens = new ReferenceTokens(options.keyHex ?? "ab".repeat(32), options.now);
  const reader = new GitHubReader({
    artifactBaseUrl: "https://worker.example",
    clients: {
      auth: async (authOptions) => ({
        token: authOptions.type === "app" ? "app" : `installation-${String(authOptions.installationId)}`,
      }),
      octokit: options.octokit ?? (() => ({ request })),
    },
    tokens,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.rangeRequest ? { rangeRequest: options.rangeRequest } : {}),
  });
  return { reader, request, tokens };
}

/** Parses the call the way the MCP tool does, so defaults apply, then runs it. */
export function run(reader: GitHubReader, operation: string, argumentsValue: unknown): Promise<OperationResult> {
  return reader.execute(parseOperation(operation, argumentsValue), TEST_USER_ID);
}

export async function runData<T = Record<string, unknown>>(
  reader: GitHubReader,
  operation: string,
  argumentsValue: unknown,
): Promise<T> {
  return (await run(reader, operation, argumentsValue)).data as T;
}
