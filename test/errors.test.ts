import { describe, expect, it } from "vitest";
import { GatewayError, githubStatus, toGatewayError } from "../src/errors";

function githubError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error("private detail with github_pat_sensitive_value"), { response: { headers }, status });
}

describe("toGatewayError", () => {
  it("returns a GatewayError unchanged", () => {
    const error = new GatewayError("invalid_arguments", "Safe input guidance");
    expect(toGatewayError(error)).toBe(error);
  });

  it("never passes through upstream messages", () => {
    for (const error of [new Error("github_pat_sensitive_value"), githubError(404), githubError(500), { token: "x" }]) {
      expect(toGatewayError(error).message).not.toContain("sensitive");
    }
  });

  it.each([
    [401, {}, "installation_required", false],
    [403, {}, "forbidden", false],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited", true],
    [404, {}, "not_found", false],
    [429, {}, "rate_limited", true],
    [502, {}, "upstream_error", true],
  ] as const)("maps HTTP %i %j to %s", (status, headers, code, retryable) => {
    expect(toGatewayError(githubError(status, headers))).toMatchObject({ code, retryable });
  });

  it("reports the rate-limit reset time", () => {
    expect(toGatewayError(githubError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" })).message)
      .toBe("GitHub API rate limit exceeded; retry after 2023-11-14T22:13:20.000Z");
  });
});

describe("githubStatus", () => {
  it("reads the status only from Error values", () => {
    expect(githubStatus(githubError(404))).toBe(404);
    expect(githubStatus({ status: 404 })).toBeUndefined();
    expect(githubStatus(new Error("no status"))).toBeUndefined();
  });
});
