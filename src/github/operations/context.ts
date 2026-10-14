import type { z } from "zod";
import { GatewayError } from "../../errors";
import type { ReferenceTokens, TokenScope } from "../../security/reference-token";
import type { OperationInput, OperationName } from "../catalog";
import type { RangeRequest } from "../range-http";
import { collection, exactNextRequest, type NextRequest, type OperationResult } from "../result";
import { type ApiResponse, type GitHubSession, hasNextPage } from "../session";
import type { KnownTextWindow } from "../text-window";

export const TEXT_TTL_SECONDS = 60 * 60;
export const SCAN_TTL_SECONDS = 15 * 60;
export const ARTIFACT_TTL_SECONDS = 5 * 60;

/** Services that live for the whole Worker request. */
export interface ReaderServices {
  artifactBaseUrl: string;
  fetch: typeof fetch;
  rangeRequest: RangeRequest;
  tokens: ReferenceTokens;
}

/** State and helpers for one tool call. */
export class OperationContext {
  constructor(
    readonly session: GitHubSession,
    readonly services: ReaderServices,
    readonly userId: number,
  ) {}

  /** The same call, but every GitHub read is unauthenticated. Used only by `fetch` for public resources. */
  publicContext(): OperationContext {
    return new OperationContext(this.session.publicSession(), this.services, this.userId);
  }

  seal(scope: TokenScope, ttlSeconds: number, body: unknown): Promise<string> {
    return this.services.tokens.seal(scope, this.userId, ttlSeconds, body);
  }

  async open<S extends z.ZodType>(token: string, scope: TokenScope, bodySchema: S): Promise<z.output<S>> {
    return (await this.services.tokens.open(token, scope, this.userId, bodySchema)).body;
  }
}

export type { OperationResult };

export type OperationHandler<N extends OperationName> = (
  context: OperationContext,
  input: OperationInput<N>,
) => Promise<OperationResult>;

export type OperationHandlers<N extends OperationName> = { [K in N]: OperationHandler<K> };

export function pagination(page: number, perPage: number, returned: number, response: ApiResponse) {
  return { has_next: hasNextPage(response), page, per_page: perPage, returned };
}

interface PagedInput {
  page: number;
  per_page: number;
}

/**
 * Builds the standard result for one page of GitHub items: pagination metadata, the items, and
 * an exact `next_request` for the following page.
 */
export function pagedCollection<N extends OperationName>(
  operation: N,
  input: OperationInput<N> & PagedInput,
  response: ApiResponse,
  key: string,
  items: readonly unknown[],
  metadata: Record<string, unknown> = {},
): OperationResult {
  const nextRequest = hasNextPage(response)
    ? exactNextRequest(operation, { ...input, page: input.page + 1 })
    : undefined;
  return {
    data: collection(
      { ...metadata, pagination: pagination(input.page, input.per_page, items.length, response) },
      key,
      items,
      nextRequest,
    ),
  };
}

/** The public fields of a text window. Internal fields such as `next_line` stay out of results. */
export function windowFields(window: KnownTextWindow) {
  return {
    ...(window.content !== undefined ? { content: window.content } : {}),
    ...(window.end_line !== undefined ? { end_line: window.end_line } : {}),
    ...(window.start_line !== undefined ? { start_line: window.start_line } : {}),
    state: window.state,
    total_lines: window.total_lines,
  };
}

export function rangeTooLarge(largestSafeEnd: number, nextRequest: NextRequest): GatewayError {
  return new GatewayError(
    "range_too_large",
    `The requested range is too large. The largest safe end_line is ${largestSafeEnd}`,
    false,
    { largest_safe_end_line: largestSafeEnd, next_request: nextRequest },
  );
}

/** Rejects a continuation token whose request arguments differ from the current request. */
export function requireSameArguments(expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new GatewayError("invalid_token", "The continuation token arguments do not match");
  }
}

