import { z } from "zod";
import { GatewayError, githubStatus, invalidArguments } from "../../errors";
import type { TokenScope } from "../../security/reference-token";
import { type JsonRecord, nested, numberValue, record, records, requiredString, stringValue } from "../json";
import { exactNextRequest, type NextRequest } from "../result";
import type { RepositoryClient } from "../session";
import { decodeText, scanFileChunk, sliceKnownText, validateUtf8Chunk } from "../text-window";
import { type OperationContext, type OperationHandlers, rangeTooLarge, TEXT_TTL_SECONDS, windowFields } from "./context";

const FILE_SCOPE: TokenScope = { operation: "fetch_file", purpose: "file" };
const FILE_SCAN_BYTES = 64 * 1024;
const ONE_MIB = 1024 * 1024;
const MAX_READABLE_BYTES = 100 * ONE_MIB;

/** The file version and line range that a read is pinned to. */
const pinnedFileSchema = z.strictObject({
  blob_sha: z.string().nullable(),
  commit_sha: z.string(),
  end_line: z.number().int().min(1).nullable(),
  path: z.string(),
  repository_full_name: z.string(),
  size: z.number().int().min(0),
  start_line: z.number().int().min(1),
});

type PinnedFile = z.infer<typeof pinnedFileSchema>;

/** Where the next window starts: a line for inline content, or a byte position for ranged reads. */
const cursorSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inline"), next_line: z.number().int().min(1) }),
  z.strictObject({
    byte_offset: z.number().int().min(0),
    line_number: z.number().int().min(1),
    /** True when byte_offset is inside a line that precedes the requested start line. */
    mid_line: z.boolean(),
    mode: z.literal("range"),
    utf8_carry: z.array(z.number().int().min(0).max(255)).max(3),
  }),
]);

type FileCursor = z.infer<typeof cursorSchema>;
type RangeCursor = Extract<FileCursor, { mode: "range" }>;

const fileTokenSchema = z.strictObject({ cursor: cursorSchema, file: pinnedFileSchema });

async function resolveCommitSha(repository: RepositoryClient, ref: string | undefined): Promise<string> {
  let requestedRef = ref;
  if (!requestedRef) {
    const repositoryData = record((await repository.request("GET /repos/{owner}/{repo}")).data);
    requestedRef = stringValue(repositoryData.default_branch) ?? undefined;
    if (!requestedRef) throw new GatewayError("not_found", "The repository has no default branch");
  }
  const commit = await repository.request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: requestedRef });
  return requiredString(record(commit.data).sha);
}

/**
 * Reads file metadata at a commit. GitHub's Contents API refuses files over 100 MiB with 403,
 * so for those the tree entry supplies the blob SHA and size.
 */
async function fileMetadata(repository: RepositoryClient, path: string, commitSha: string): Promise<JsonRecord> {
  let data: unknown;
  try {
    data = (await repository.request("GET /repos/{owner}/{repo}/contents/{path}", { path, ref: commitSha })).data;
  } catch (error) {
    if (githubStatus(error) !== 403) throw error;
    const commit = await repository.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { commit_sha: commitSha });
    const treeSha = stringValue(nested(record(commit.data), "tree").sha);
    if (!treeSha) throw error;
    const tree = await repository.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { recursive: "1", tree_sha: treeSha });
    const entry = records(record(tree.data).tree).find((candidate) => stringValue(candidate.path) === path);
    if (!entry || stringValue(entry.type) !== "blob") throw error;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    data = {
      html_url: `https://github.com/${repository.fullName}/blob/${commitSha}/${encodedPath}`,
      sha: stringValue(entry.sha),
      size: numberValue(entry.size),
      type: "file",
    };
  }
  if (Array.isArray(data)) throw invalidArguments("The requested path is a directory");
  const metadata = record(data);
  if (stringValue(metadata.type) !== "file") throw invalidArguments("The requested path is not a regular file");
  return metadata;
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value.replace(/\s/gu, "")), (character) => character.charCodeAt(0));
  } catch {
    throw new GatewayError("upstream_error", "GitHub returned invalid base64 file content", true);
  }
}

function binaryError(error: unknown): boolean {
  return error instanceof GatewayError && error.code === "binary_detected";
}

/** Validates UTF-8 and returns the carry for the next chunk, or "binary" if the first chunk is not text. */
function utf8Carry(bytes: Uint8Array, carry: readonly number[], eof: boolean, firstChunk: boolean): number[] | "binary" {
  try {
    return validateUtf8Chunk(bytes, carry, eof);
  } catch (error) {
    if (firstChunk && binaryError(error)) return "binary";
    throw error;
  }
}

class FileRead {
  private readonly base;

  constructor(
    private readonly context: OperationContext,
    private readonly file: PinnedFile,
    htmlUrl: string | null,
  ) {
    this.base = {
      blob_sha: file.blob_sha,
      commit_sha: file.commit_sha,
      path: file.path,
      repository_full_name: file.repository_full_name,
      size: file.size,
      url: htmlUrl,
    };
  }

  private async continuation(cursor: FileCursor): Promise<NextRequest> {
    const token = await this.context.seal(FILE_SCOPE, TEXT_TTL_SECONDS, { cursor, file: this.file });
    return exactNextRequest("fetch_file", { continuation_token: token });
  }

  private rangeTooLarge(startLine: number, largestSafeEnd: number): GatewayError {
    return rangeTooLarge(
      largestSafeEnd,
      exactNextRequest("fetch_file", {
        end_line: largestSafeEnd,
        path: this.file.path,
        ref: this.file.commit_sha,
        repository_full_name: this.file.repository_full_name,
        start_line: startLine,
      }),
    );
  }

  binary() {
    return { ...this.base, binary: true, state: "complete" as const };
  }

  empty() {
    return { ...this.base, binary: false, state: this.file.start_line === 1 ? "complete" as const : "eof" as const, total_lines: 0 };
  }

  tooLarge() {
    return { ...this.base, binary: null, content_available: false, reason: "contents_api_size_limit", state: "complete" as const };
  }

  async inline(content: string, cursor: FileCursor | null) {
    const bytes = decodeBase64(content);
    if (bytes.byteLength !== this.file.size) {
      throw new GatewayError("upstream_error", "GitHub returned incomplete inline file content", true);
    }
    let text: string;
    try {
      text = decodeText(bytes);
    } catch (error) {
      if (binaryError(error)) return this.binary();
      throw error;
    }
    const startLine = cursor?.mode === "inline" ? cursor.next_line : this.file.start_line;
    const window = sliceKnownText(text, startLine, this.file.end_line ?? undefined);
    if (window.state === "range_too_large") {
      throw this.rangeTooLarge(startLine, window.largest_safe_end_line ?? startLine);
    }
    const nextRequest = window.next_line ? await this.continuation({ mode: "inline", next_line: window.next_line }) : undefined;
    return { ...this.base, binary: false, ...windowFields(window), ...(nextRequest ? { next_request: nextRequest } : {}) };
  }

  /**
   * Reads one byte range of at most 64 KiB. Lines before the requested start are skipped
   * across calls, and the cursor records any partial line or UTF-8 sequence at the range end.
   */
  async range(downloadUrl: string, cursor: RangeCursor) {
    const { size } = this.file;
    const requestedStart = this.file.start_line;
    const requestedEnd = this.file.end_line ?? undefined;
    const firstChunk = cursor.byte_offset === 0;
    if (cursor.byte_offset >= size) {
      return { ...this.base, binary: false, state: "eof" as const, total_lines: Math.max(0, cursor.line_number - 1) };
    }
    const rangeEnd = Math.min(size - 1, cursor.byte_offset + FILE_SCAN_BYTES - 1);
    this.context.session.spend();
    const response = await this.context.services.rangeRequest(downloadUrl, cursor.byte_offset, rangeEnd);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("Content-Range") ?? "");
    if (response.status !== 206 || !match) {
      throw new GatewayError("range_not_supported", "The GitHub download source did not honor the byte range");
    }
    const [actualStart, actualEnd, actualTotal] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (actualStart !== cursor.byte_offset || actualEnd > rangeEnd || actualTotal !== size) {
      throw new GatewayError("range_not_supported", "GitHub returned a mismatched Content-Range", false, {
        content_encoding: response.headers.get("Content-Encoding"),
        expected: { end_at_most: rangeEnd, start: cursor.byte_offset, total: size },
        received: { end: actualEnd, start: actualStart, total: actualTotal },
      });
    }
    let bytes = response.bytes;
    if (bytes.byteLength !== actualEnd - actualStart + 1) {
      throw new GatewayError("range_not_supported", "GitHub returned a byte count that does not match Content-Range");
    }
    const eof = actualEnd + 1 === size;
    const nextByte = actualEnd + 1;
    if (bytes.includes(0)) {
      if (!firstChunk) throw new GatewayError("binary_detected", "Binary data appeared after earlier text chunks");
      return this.binary();
    }

    let lineNumber = cursor.line_number;
    let midLine = cursor.mid_line;
    let skippedBytes = 0;
    if (midLine && lineNumber < requestedStart) {
      const firstLf = bytes.indexOf(10);
      if (firstLf < 0) {
        const carry = utf8Carry(bytes, cursor.utf8_carry, eof, firstChunk);
        if (carry === "binary") return this.binary();
        if (eof) return { ...this.base, binary: false, state: "eof" as const, total_lines: lineNumber };
        const nextRequest = await this.continuation({ ...cursor, byte_offset: nextByte, utf8_carry: carry });
        return { ...this.base, binary: false, next_request: nextRequest, state: "seeking" as const };
      }
      if (utf8Carry(bytes.slice(0, firstLf + 1), cursor.utf8_carry, true, firstChunk) === "binary") return this.binary();
      skippedBytes = firstLf + 1;
      bytes = bytes.slice(skippedBytes);
      lineNumber += 1;
      midLine = false;
    }

    const scanned = scanFileChunk(bytes, lineNumber, requestedStart, requestedEnd, eof);
    if (scanned.binary) {
      if (!firstChunk) throw new GatewayError("binary_detected", "Binary data appeared after earlier text chunks");
      return this.binary();
    }
    if (scanned.state === "seeking" && scanned.consumed_bytes === 0 && !eof) {
      if (lineNumber >= requestedStart) throw new GatewayError("line_too_large", `Line ${lineNumber} cannot fit in one result`);
      const carry = utf8Carry(bytes, [], false, firstChunk);
      if (carry === "binary") return this.binary();
      const nextRequest = await this.continuation({
        byte_offset: nextByte,
        line_number: lineNumber,
        mid_line: true,
        mode: "range",
        utf8_carry: carry,
      });
      return { ...this.base, binary: false, next_request: nextRequest, state: "seeking" as const };
    }
    if (requestedEnd !== undefined && scanned.size_limited) {
      throw this.rangeTooLarge(requestedStart, scanned.end_line ?? requestedStart);
    }
    if (!scanned.content && eof && scanned.state === "complete" && scanned.next_line <= requestedStart) {
      return { ...this.base, binary: false, state: "eof" as const, total_lines: Math.max(0, scanned.next_line - 1) };
    }
    const nextRequest = scanned.state === "partial" || scanned.state === "seeking"
      ? await this.continuation({
          byte_offset: cursor.byte_offset + skippedBytes + scanned.consumed_bytes,
          line_number: scanned.next_line,
          mid_line: midLine,
          mode: "range",
          utf8_carry: [],
        })
      : undefined;
    return {
      ...this.base,
      binary: false,
      ...(scanned.content !== undefined ? { content: scanned.content } : {}),
      ...(scanned.end_line !== undefined ? { end_line: scanned.end_line } : {}),
      ...(nextRequest ? { next_request: nextRequest } : {}),
      ...(scanned.start_line !== undefined ? { start_line: scanned.start_line } : {}),
      state: scanned.state,
      ...(scanned.total_lines !== undefined ? { total_lines: scanned.total_lines } : {}),
    };
  }
}

export const fileOperations: OperationHandlers<"fetch_file"> = {
  async fetch_file(context, input) {
    let file: PinnedFile;
    let cursor: FileCursor | null = null;
    let metadata: JsonRecord;
    let repository: RepositoryClient;
    if ("continuation_token" in input) {
      const token = await context.open(input.continuation_token, FILE_SCOPE, fileTokenSchema);
      file = token.file;
      cursor = token.cursor;
      repository = await context.session.repository(file.repository_full_name);
      metadata = await fileMetadata(repository, file.path, file.commit_sha);
      if (stringValue(metadata.sha) !== file.blob_sha) {
        throw new GatewayError("stale_reference", "The pinned file resource no longer matches its blob SHA");
      }
    } else {
      repository = await context.session.repository(input.repository_full_name);
      const commitSha = await resolveCommitSha(repository, input.ref);
      metadata = await fileMetadata(repository, input.path, commitSha);
      file = {
        blob_sha: stringValue(metadata.sha),
        commit_sha: commitSha,
        end_line: input.end_line ?? null,
        path: input.path,
        repository_full_name: repository.fullName,
        size: numberValue(metadata.size) ?? 0,
        start_line: input.start_line ?? 1,
      };
    }

    const read = new FileRead(context, file, stringValue(metadata.html_url));
    if (file.size === 0) return { data: read.empty() };
    if (file.size > MAX_READABLE_BYTES) return { data: read.tooLarge() };

    const inlineContent = stringValue(metadata.content);
    if (file.size <= ONE_MIB && inlineContent !== null && stringValue(metadata.encoding) === "base64") {
      return { data: await read.inline(inlineContent, cursor) };
    }
    const downloadUrl = stringValue(metadata.download_url);
    if (!downloadUrl) {
      throw new GatewayError("range_not_supported", "GitHub did not provide a range-capable download URL for this file");
    }
    const rangeCursor: RangeCursor = cursor?.mode === "range"
      ? cursor
      : { byte_offset: 0, line_number: 1, mid_line: false, mode: "range", utf8_carry: [] };
    return { data: await read.range(downloadUrl, rangeCursor) };
  },
};
