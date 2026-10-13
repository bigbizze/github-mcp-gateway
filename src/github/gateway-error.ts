import { ConnectorInputError, safeGitHubError } from "./errors";
import { ReferenceTokenError } from "../security/reference-token";

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

interface StatusError extends Error {
  response?: { headers?: Record<string, string | undefined> };
  status?: number;
}

export function normalizeGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof ReferenceTokenError) {
    return new GatewayError(error.code, error.message);
  }
  if (error instanceof ConnectorInputError) {
    return new GatewayError("invalid_arguments", error.message);
  }
  if (error instanceof Error) {
    const status = (error as StatusError).status;
    if (status === 404) {
      return new GatewayError("not_found", "The repository or GitHub resource was not found");
    }
    if (status === 401) {
      return new GatewayError("installation_required", "GitHub rejected the installation credentials");
    }
    if (status === 403) {
      const remaining = (error as StatusError).response?.headers?.["x-ratelimit-remaining"];
      if (remaining === "0") return new GatewayError("rate_limited", safeGitHubError(error), true);
      return new GatewayError("forbidden", "The GitHub App cannot read this resource");
    }
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      return new GatewayError("upstream_error", "GitHub is temporarily unavailable", true);
    }
  }
  return new GatewayError("upstream_error", "The GitHub request failed safely", true);
}
