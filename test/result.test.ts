import { describe, expect, it } from "vitest";
import { exactNextRequest, fitCollection, MAX_RESULT_BYTES, successEnvelope, byteLength } from "../src/github/result";

describe("bounded result assembly", () => {
  it("keeps a complete collection and its exact next request within the byte limit", () => {
    const next = exactNextRequest("search_issues", {
      page: 2,
      per_page: 20,
      repository_full_name: "owner/repo",
    });
    const result = fitCollection("search_issues", {}, "issues", [{ issue_number: 1 }], next);
    expect(result.included).toBe(1);
    expect(result.data.next_request).toEqual(next);
    expect(byteLength(successEnvelope("search_issues", result.data))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it("returns an implementation error instead of losing an oversized item", () => {
    expect(() => fitCollection("search_issues", {}, "issues", [{ title: "x".repeat(25_000) }])).toThrow(
      expect.objectContaining({ code: "output_limit_exceeded" }),
    );
  });
});
