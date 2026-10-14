import { describe, expect, it } from "vitest";
import { run, runData, testReader } from "./support/reader";

function issueReader(initialBody: string) {
  let body = initialBody;
  const { reader } = testReader({
    request: async (route) => {
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
    },
  });
  return { reader, setBody: (value: string) => { body = value; } };
}

describe("version-bound shared text references", () => {
  it("inlines one body window and supports exact line reads", async () => {
    const { reader } = issueReader(`one\r\ntwo\r\nthree\r\n${"tail\n".repeat(4_000)}`);
    const issue = await runData<{ body: { reference_token: string } }>(reader, "fetch_issue", {
      issue_number: 1,
      repository_full_name: "owner/repo",
    });

    const result = await runData(reader, "read_text", {
      end_line: 3,
      reference_token: issue.body.reference_token,
      start_line: 2,
    });
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
    const issue = await runData<{ body: { reference_token: string } }>(reader, "fetch_issue", {
      issue_number: 1,
      repository_full_name: "owner/repo",
    });
    setBody("changed");

    await expect(run(reader, "read_text", {
      reference_token: issue.body.reference_token,
    })).rejects.toMatchObject({ code: "stale_reference" });
  });

  it("omits a reference token when the complete body is inline", async () => {
    const { reader } = issueReader("complete body");
    const issue = await runData<{ body: Record<string, unknown> }>(reader, "fetch_issue", {
      issue_number: 1,
      repository_full_name: "owner/repo",
    });

    expect(issue.body).toMatchObject({ content: "complete body", state: "complete", total_lines: 1 });
    expect(issue.body.reference_token).toBeUndefined();
  });

  it("lists comment metadata with a reference token and no inline body", async () => {
    const { reader } = issueReader("issue body");
    const result = await runData<{ comments: Array<Record<string, unknown>> }>(reader, "list_issue_comments", {
      issue_number: 1,
      page: 1,
      per_page: 10,
      repository_full_name: "owner/repo",
    });

    expect(result.comments[0]).toMatchObject({ author: "commenter", comment_id: 9 });
    expect(result.comments[0]?.body_reference_token).toEqual(expect.any(String));
    expect(result.comments[0]?.body).toBeUndefined();
  });
});
