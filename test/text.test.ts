import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors";
import {
  decodeText,
  scanFileChunk,
  sliceKnownText,
  splitLinesPreservingEndings,
  validateUtf8Chunk,
} from "../src/github/text-window";

describe("bounded text windows", () => {
  it("uses the required empty-file and final-newline line semantics", () => {
    expect(splitLinesPreservingEndings("")).toEqual([]);
    expect(splitLinesPreservingEndings("a\n")).toEqual(["a\n"]);
    expect(splitLinesPreservingEndings("a\n\n")).toEqual(["a\n", "\n"]);
    expect(sliceKnownText("", 1)).toEqual({ state: "eof", total_lines: 0 });
    expect(sliceKnownText("a\n", 1)).toMatchObject({ content: "a\n", state: "complete", total_lines: 1 });
    expect(sliceKnownText("a\n", 2)).toEqual({ state: "eof", total_lines: 1 });
  });

  it("preserves CRLF endings and inclusive exact ranges", () => {
    expect(sliceKnownText("one\r\ntwo\r\nthree", 2, 3)).toEqual({
      content: "two\r\nthree",
      end_line: 3,
      start_line: 2,
      state: "complete",
      total_lines: 3,
    });
  });

  it("counts UTF-8 bytes and never splits a line", () => {
    const result = sliceKnownText("🙂\nnext\n", 1, undefined, 6);
    expect(result).toMatchObject({ content: "🙂\n", end_line: 1, next_line: 2, state: "partial" });
    expect(() => sliceKnownText(`${"x".repeat(20)}\n`, 1, undefined, 10)).toThrow(GatewayError);
  });

  it("reports the largest safe end for an explicit oversized range", () => {
    expect(sliceKnownText("1234\n5678\nlast\n", 1, 3, 11)).toMatchObject({
      content: "1234\n5678\n",
      largest_safe_end_line: 2,
      state: "range_too_large",
    });
  });

  it("detects NUL bytes and invalid UTF-8", () => {
    expect(() => decodeText(new Uint8Array([65, 0, 66]))).toThrow("NUL");
    expect(() => decodeText(new Uint8Array([0xc3, 0x28]))).toThrow("valid UTF-8");
  });

  it("carries a split UTF-8 sequence across scan chunks", () => {
    const encoded = new TextEncoder().encode("🙂");
    const carry = validateUtf8Chunk(encoded.slice(0, 2), [], false);
    expect(carry).toEqual(Array.from(encoded.slice(0, 2)));
    expect(validateUtf8Chunk(encoded.slice(2), carry, true)).toEqual([]);
    expect(() => validateUtf8Chunk(new Uint8Array([0xf0, 0x28]), [], true)).toThrow("valid UTF-8");
  });

  it("returns seeking before the requested start and detects late binary bytes", () => {
    const encoder = new TextEncoder();
    expect(scanFileChunk(encoder.encode("one\ntwo\n"), 1, 5, undefined, false)).toMatchObject({
      consumed_bytes: 8,
      next_line: 3,
      state: "seeking",
    });
    expect(scanFileChunk(new Uint8Array([65, 0, 10]), 1, 1, undefined, true)).toMatchObject({ binary: true });
  });
});
