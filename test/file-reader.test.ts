import { describe, expect, it, vi } from "vitest";
import type { RangeRequest } from "../src/github/range-http";
import { handleToolCall } from "../src/mcp/server";
import { run, runData, TEST_USER_ID, testReader } from "./support/reader";

function fileReader(
  bytes: Uint8Array,
  options: { contentRange?: string; encoding?: string; inlineContent?: string | null; status?: number } = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    throw new Error("The file range used fetch instead of the TLS transport");
  });
  const rangeMock = vi.fn<RangeRequest>(async (_url, start, requestedEnd) => {
    const end = Math.min(requestedEnd, bytes.byteLength - 1);
    const body = bytes.slice(start, end + 1);
    return {
      bytes: body,
      headers: new Headers({
        "Content-Range": options.contentRange ?? `bytes ${start}-${end}/${bytes.byteLength}`,
      }),
      status: options.status ?? 206,
    };
  });
  const { reader, request } = testReader({
    fetch: fetchMock,
    rangeRequest: rangeMock,
    request: async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 1 }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { data: { sha: "commit-sha" }, headers: {} };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        return {
          data: {
            content: options.inlineContent === undefined ? null : options.inlineContent,
            download_url: "https://raw.githubusercontent.com/owner/repo/commit-sha/file.txt?token=signed-download",
            encoding: options.encoding ?? "none",
            html_url: "https://github.com/owner/repo/blob/commit-sha/file.txt",
            path: "file.txt",
            sha: "blob-sha",
            size: bytes.byteLength,
            type: "file",
          },
          headers: {},
        };
      }
      throw new Error(`Unexpected route ${route}`);
    },
  });
  return { fetchMock, rangeMock, reader, request };
}

describe("fetch URL arguments", () => {
  it("rejects URL query values outside the operation's limits before any GitHub request", async () => {
    const { reader, request } = fileReader(new TextEncoder().encode("one\n"));

    await expect(
      run(reader, "fetch", { url: "https://github.com/owner/repo/issues?per_page=100" }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(request).not.toHaveBeenCalled();
  });

  it("reads a file through a validated fetch URL", async () => {
    const source = new TextEncoder().encode("one\ntwo\n");
    const { reader } = fileReader(source, {
      encoding: "base64",
      inlineContent: btoa(String.fromCharCode(...source)),
    });
    const result = await runData(reader, "fetch", { url: "https://github.com/owner/repo/blob/main/file.txt" });

    expect(result).toMatchObject({ content: "one\ntwo\n", state: "complete", total_lines: 2 });
  });
});

describe("pinned byte-range file reader", () => {
  it("prefers inline base64 content for a file of 1 MiB or less", async () => {
    const source = new TextEncoder().encode("one\ntwo\nthree\n");
    const { rangeMock, reader } = fileReader(source, {
      encoding: "base64",
      inlineContent: btoa(String.fromCharCode(...source)),
    });
    const result = await runData(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
      start_line: 2,
    });

    expect(result).toMatchObject({
      content: "two\nthree\n",
      end_line: 3,
      start_line: 2,
      state: "complete",
      total_lines: 3,
    });
    expect(rangeMock).not.toHaveBeenCalled();
  });

  it("uses byte ranges for a file larger than 1 MiB", async () => {
    const source = new TextEncoder().encode("x\n".repeat((1024 * 1024 / 2) + 1));
    const { rangeMock, reader } = fileReader(source, {
      encoding: "base64",
      inlineContent: "eAo=",
    });
    const result = await runData(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
    });

    expect(result).toMatchObject({ state: "partial" });
    expect(rangeMock).toHaveBeenCalledOnce();
  });

  it("returns exact lines, preserves CRLF, and observes total lines only at EOF", async () => {
    const source = new TextEncoder().encode("one\r\ntwo\r\nthree");
    const { fetchMock, rangeMock, reader } = fileReader(source);
    const result = await runData(reader, "fetch_file", {
      end_line: 3,
      path: "file.txt",
      repository_full_name: "owner/repo",
      start_line: 2,
    });

    expect(result).toMatchObject({
      binary: false,
      commit_sha: "commit-sha",
      content: "two\r\nthree",
      end_line: 3,
      start_line: 2,
      state: "complete",
      total_lines: 3,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rangeMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/repo/commit-sha/file.txt?token=signed-download",
      0,
      source.byteLength - 1,
    );
  });

  it("returns eof for a start line after the last final-newline line", async () => {
    const { reader } = fileReader(new TextEncoder().encode("one\n"));
    const result = await runData(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
      start_line: 2,
    });
    expect(result).toMatchObject({ state: "eof", total_lines: 1 });
    expect(result.content).toBeUndefined();
  });

  it("returns metadata only for initial binary data", async () => {
    const { reader } = fileReader(new Uint8Array([65, 0, 66, 10]));
    const result = await runData(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
    });
    expect(result).toMatchObject({ binary: true, state: "complete" });
    expect(result.content).toBeUndefined();
  });

  it("returns seeking and an exact opaque continuation without hidden loss", async () => {
    const source = new TextEncoder().encode(`${"x\n".repeat(40_000)}target\n`);
    const { reader } = fileReader(source);
    const first = await runData(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
      start_line: 40_001,
    });
    expect(first).toMatchObject({ state: "seeking" });
    const next = first.next_request as { arguments: { continuation_token: string }; operation: string };
    expect(next.operation).toBe("fetch_file");

    const second = await runData(reader, "fetch_file", next.arguments);
    expect(second).toMatchObject({ content: "target\n", start_line: 40_001, state: "complete", total_lines: 40_001 });
  });

  it("preserves a UTF-8 character split between seeking ranges", async () => {
    const source = new TextEncoder().encode(`${"x".repeat(65_534)}🙂\ntarget\n`);
    const { reader } = fileReader(source);
    const first = await runData(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
      start_line: 2,
    });
    expect(first).toMatchObject({ state: "seeking" });
    const next = first.next_request as { arguments: { continuation_token: string } };
    const second = await runData(reader, "fetch_file", next.arguments);
    expect(second).toMatchObject({ content: "target\n", start_line: 2, state: "complete", total_lines: 2 });
  });

  it("rejects mismatched Content-Range responses", async () => {
    const { reader } = fileReader(new TextEncoder().encode("one\n"), {
      contentRange: "bytes 1-3/4",
    });
    await expect(run(reader, "fetch_file", {
      path: "file.txt",
      repository_full_name: "owner/repo",
    })).rejects.toMatchObject({
      code: "range_not_supported",
      details: {
        content_encoding: null,
        expected: { end_at_most: 3, start: 0, total: 4 },
        received: { end: 3, start: 1, total: 4 },
      },
      message: "GitHub returned a mismatched Content-Range",
    });
  });

  it("returns range_too_large with an exact smaller request", async () => {
    const source = new TextEncoder().encode(`${"1234567890\n".repeat(2_000)}`);
    const { reader } = fileReader(source);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await handleToolCall(reader, TEST_USER_ID, {
      action: "execute",
      arguments: {
        end_line: 2_000,
        path: "file.txt",
        repository_full_name: "owner/repo",
        start_line: 1,
      },
      operation: "fetch_file",
    });
    const content = result.content[0];
    if (!content || content.type !== "text") throw new Error("Expected text result");
    const envelope = JSON.parse(content.text) as {
      error: { code: string; details: { largest_safe_end_line: number; next_request: object } };
    };
    expect(result.isError).toBe(true);
    expect(envelope.error.code).toBe("range_too_large");
    expect(envelope.error.details.largest_safe_end_line).toBeGreaterThan(1);
    expect(envelope.error.details.next_request).toMatchObject({ action: "execute", operation: "fetch_file" });
  });
});
