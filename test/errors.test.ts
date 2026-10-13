import { describe, expect, it } from "vitest";
import {
  ConnectorInputError,
  githubErrorDiagnostic,
  safeGitHubError,
} from "../src/github/errors";

describe("githubErrorDiagnostic", () => {
  it("reports useful fields and redacts credentials", () => {
    const error = Object.assign(
      new Error(
        "failed with github_pat_sensitive_value and eyJ12345678.abcdefgh.ijklmnop " +
          "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        { cause: new Error("cause contains ghp_sensitive_value") },
      ),
      { status: 401 },
    );

    expect(githubErrorDiagnostic(error)).toEqual({
      cause: { message: "cause contains [REDACTED_GITHUB_TOKEN]", name: "Error" },
      message:
        "failed with [REDACTED_GITHUB_TOKEN] and [REDACTED_JWT] [REDACTED_PRIVATE_KEY]",
      name: "Error",
      status: 401,
    });
  });

  it("handles non-Error values without logging their contents", () => {
    expect(githubErrorDiagnostic({ token: "private" })).toEqual({
      message: "A non-Error value was thrown",
      name: "NonError",
      status: null,
    });
  });
});

describe("safeGitHubError", () => {
  it("returns deliberate connector input errors", () => {
    expect(safeGitHubError(new ConnectorInputError("Safe input guidance"))).toBe(
      "Safe input guidance",
    );
  });

  it("does not expose arbitrary upstream messages or credentials", () => {
    expect(safeGitHubError(new Error("request failed with github_pat_sensitive-value"))).toBe(
      "Unexpected GitHub integration error",
    );
  });

  it("normalizes common GitHub status failures", () => {
    expect(safeGitHubError(Object.assign(new Error("private detail"), { status: 404 }))).toBe(
      "Repository or GitHub resource was not found or is not installed",
    );
    expect(safeGitHubError(Object.assign(new Error("private detail"), { status: 401 }))).toBe(
      "GitHub rejected the connector's installation credentials",
    );
  });

  it("reports a GitHub rate-limit reset without returning the upstream body", () => {
    const error = Object.assign(new Error("private detail"), {
      response: {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
      },
      status: 403,
    });
    expect(safeGitHubError(error)).toBe(
      "GitHub API rate limit exceeded; retry after 2023-11-14T22:13:20.000Z",
    );
  });
});
