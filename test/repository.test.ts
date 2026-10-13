import { describe, expect, it } from "vitest";
import { ConnectorInputError } from "../src/github/errors";
import { parseRepository, validateCodeSearchQuery } from "../src/github/repository";

describe("parseRepository", () => {
  it("normalizes an owner/name pair", () => {
    expect(parseRepository(" example-owner/example.repo ")).toEqual({
      fullName: "example-owner/example.repo",
      owner: "example-owner",
      repo: "example.repo",
    });
  });

  it.each(["", "repository", "owner/repo/extra", "https://github.com/owner/repo"])(
    "rejects invalid repository input %j",
    (value) => {
      expect(() => parseRepository(value)).toThrow(ConnectorInputError);
    },
  );
});

describe("validateCodeSearchQuery", () => {
  it("allows GitHub search syntax that does not alter repository scope", () => {
    expect(validateCodeSearchQuery(" language:typescript addEventListener ")).toBe(
      "language:typescript addEventListener",
    );
  });

  it.each(["", "repo:other/repo token", "token ORG:example", "user:someone token"])(
    "rejects empty or scope-changing input %j",
    (value) => {
      expect(() => validateCodeSearchQuery(value)).toThrow(ConnectorInputError);
    },
  );
});
