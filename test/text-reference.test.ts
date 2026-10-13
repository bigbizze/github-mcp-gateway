import { describe, expect, it, vi } from "vitest";
import { GitHubReader, type OctokitLike } from "../src/github/reader";
import { AesGcmTokenCodec } from "../src/security/reference-token";

function issueReader(initialBody: string) {
  let body = initialBody;
  const octokit: OctokitLike = {
    request: vi.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 1 }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        return {
          data: {
            assignees: [],
            body,
            created_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/owner/repo/issues/1",
            labels: [],
            number: 1,
            state: "open",
            title: "Issue",
            updated_at: "2026-01-01T00:00:00Z",
            user: { login: "author" },
          },
          headers: {},
        };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return {
          data: [{
            body: "comment body",
            created_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/owner/repo/issues/1#issuecomment-9",
            id: 9,
            updated_at: "2026-01-01T00:00:00Z",
            user: { login: "commenter" },
          }],
          headers: {},
        };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/comments/{comment_id}") {
        return { data: { body: "comment body" }, headers: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    }),
  };
  const reader = new GitHubReader(
    { appId: "1", privateKey: "key" },
    new AesGcmTokenCodec("ef".repeat(32)),
    {
      artifactBaseUrl: "https://worker.example",
      authFactory: () => async (options) => ({ token: options.type === "app" ? "app" : "installation" }),
      octokitFactory: () => octokit,
    },
  );
  return { reader, setBody: (value: string) => { body = value; } };
}

describe("version-bound shared text references", () => {
  it("inlines one body window and supports exact line reads", async () => {
    const { reader } = issueReader(`one\r\ntwo\r\nthree\r\n${"tail\n".repeat(4_000)}`);
    const issue = (await reader.execute("fetch_issue", {
      issue_number: 1,
      repository_full_name: "owner/repo",
    }, 42)).data as { body: { reference_token: string } };

    const result = (await reader.execute("read_text", {
      end_line: 3,
      reference_token: issue.body.reference_token,
      start_line: 2,
    }, 42)).data;
    expect(result).toMatchObject({
      content: "two\r\nthree\r\n",
      end_line: 3,
      start_line: 2,
      state: "complete",
      total_lines: 4_003,
    });
  });

  it("returns stale_reference after mutable body content changes", async () => {
    const { reader, setBody } = issueReader(`${"original\n".repeat(2_000)}tail`);
    const issue = (await reader.execute("fetch_issue", {
      issue_number: 1,
      repository_full_name: "owner/repo",
    }, 42)).data as { body: { reference_token: string } };
    setBody("changed");

    await expect(reader.execute("read_text", {
      reference_token: issue.body.reference_token,
    }, 42)).rejects.toMatchObject({ code: "stale_reference" });
  });

  it("omits a reference token when the complete body is inline", async () => {
    const { reader } = issueReader("complete body");
    const issue = (await reader.execute("fetch_issue", {
      issue_number: 1,
      repository_full_name: "owner/repo",
    }, 42)).data as { body: Record<string, unknown> };

    expect(issue.body).toMatchObject({ content: "complete body", state: "complete", total_lines: 1 });
    expect(issue.body.reference_token).toBeUndefined();
  });

  it("lists comment metadata with a reference token and no inline body", async () => {
    const { reader } = issueReader("issue body");
    const result = (await reader.execute("list_issue_comments", {
      issue_number: 1,
      page: 1,
      per_page: 10,
      repository_full_name: "owner/repo",
    }, 42)).data as { comments: Array<Record<string, unknown>> };

    expect(result.comments[0]).toMatchObject({ author: "commenter", comment_id: 9 });
    expect(result.comments[0]?.body_reference_token).toEqual(expect.any(String));
    expect(result.comments[0]?.body).toBeUndefined();
  });
});
