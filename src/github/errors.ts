interface GitHubLikeError extends Error {
  response?: { headers?: Record<string, string | undefined> };
  status?: number;
}

export interface GitHubErrorDiagnostic {
  cause?: { message: string; name: string };
  message: string;
  name: string;
  status: number | null;
}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN(?: RSA)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA)? PRIVATE KEY-----/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+)\b/gu;

function sanitizedDiagnosticMessage(message: string): string {
  return message
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED_GITHUB_TOKEN]")
    .slice(0, 500);
}

export class ConnectorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInputError";
  }
}

function isGitHubLikeError(error: unknown): error is GitHubLikeError {
  return error instanceof Error;
}

export function githubErrorDiagnostic(error: unknown): GitHubErrorDiagnostic {
  if (!(error instanceof Error)) {
    return {
      message: "A non-Error value was thrown",
      name: "NonError",
      status: null,
    };
  }

  const status = (error as GitHubLikeError).status;
  const diagnostic: GitHubErrorDiagnostic = {
    message: sanitizedDiagnosticMessage(error.message),
    name: error.name,
    status: typeof status === "number" ? status : null,
  };
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    diagnostic.cause = {
      message: sanitizedDiagnosticMessage(cause.message),
      name: cause.name,
    };
  }
  return diagnostic;
}

export function safeGitHubError(error: unknown): string {
  if (!isGitHubLikeError(error)) return "Unexpected GitHub integration error";

  if (error instanceof ConnectorInputError) return error.message;

  const status = error.status;
  const headers = error.response?.headers;
  if (status === 403 && headers?.["x-ratelimit-remaining"] === "0") {
    const reset = Number(headers["x-ratelimit-reset"]);
    const resetAt = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : "unknown";
    return `GitHub API rate limit exceeded; retry after ${resetAt}`;
  }
  if (status === 404) return "Repository or GitHub resource was not found or is not installed";
  if (status === 401) return "GitHub rejected the connector's installation credentials";
  if (status === 403) return "The GitHub App does not have permission to read this resource";
  if (typeof status === "number") return `GitHub API request failed with status ${status}`;
  return "Unexpected GitHub integration error";
}
