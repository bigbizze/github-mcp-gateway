export type GatewayErrorCode =
  | "binary_detected"
  | "forbidden"
  | "installation_required"
  | "invalid_arguments"
  | "invalid_token"
  | "line_too_large"
  | "not_found"
  | "output_limit_exceeded"
  | "range_not_supported"
  | "range_too_large"
  | "rate_limited"
  | "stale_reference"
  | "upstream_error";

/** An error whose code and message are safe to return to the MCP client. */
export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function invalidArguments(message: string): GatewayError {
  return new GatewayError("invalid_arguments", message);
}

interface GitHubRequestError extends Error {
  response?: { headers?: Record<string, string | undefined> };
  status?: number;
}

/** The HTTP status of an Octokit request error, if the error has one. */
export function githubStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as GitHubRequestError).status;
  return typeof status === "number" ? status : undefined;
}

function rateLimitMessage(error: GitHubRequestError): string {
  const reset = Number(error.response?.headers?.["x-ratelimit-reset"]);
  const resetAt = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : "unknown";
  return `GitHub API rate limit exceeded; retry after ${resetAt}`;
}

/**
 * Converts any thrown value to a GatewayError. GitHub's own error text never passes through,
 * because it can contain request details.
 */
export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const status = githubStatus(error);
  if (status === 404) return new GatewayError("not_found", "The repository or GitHub resource was not found");
  if (status === 401) return new GatewayError("installation_required", "GitHub rejected the installation credentials");
  if (status === 403 || status === 429) {
    const requestError = error as GitHubRequestError;
    if (status === 429 || requestError.response?.headers?.["x-ratelimit-remaining"] === "0") {
      return new GatewayError("rate_limited", rateLimitMessage(requestError), true);
    }
    return new GatewayError("forbidden", "The GitHub App cannot read this resource");
  }
  if (status !== undefined && status >= 500) {
    return new GatewayError("upstream_error", "GitHub is temporarily unavailable", true);
  }
  return new GatewayError("upstream_error", "The GitHub request failed safely", true);
}
