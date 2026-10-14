import { GatewayError } from "../errors";
import { byteLength, MAX_INLINE_TEXT_BYTES } from "./result";

export interface KnownTextWindow {
  content?: string;
  end_line?: number;
  largest_safe_end_line?: number;
  next_line?: number;
  start_line?: number;
  state: "complete" | "eof" | "partial" | "range_too_large";
  total_lines: number;
}

export function splitLinesPreservingEndings(value: string): string[] {
  if (value.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lines.push(value.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new GatewayError("binary_detected", "The resource contains NUL bytes and is binary");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GatewayError("binary_detected", "The resource is not valid UTF-8 and is binary");
  }
}

export function validateUtf8Chunk(
  bytes: Uint8Array,
  carry: readonly number[] = [],
  eof = false,
): number[] {
  const combined = new Uint8Array(carry.length + bytes.length);
  combined.set(carry);
  combined.set(bytes, carry.length);
  let index = 0;
  while (index < combined.length) {
    const first = combined[index] ?? 0;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    let length: number;
    if (first >= 0xc2 && first <= 0xdf) length = 2;
    else if (first >= 0xe0 && first <= 0xef) length = 3;
    else if (first >= 0xf0 && first <= 0xf4) length = 4;
    else throw new GatewayError("binary_detected", "The resource is not valid UTF-8 and is binary");
    if (index + length > combined.length) {
      if (eof) throw new GatewayError("binary_detected", "The resource is not valid UTF-8 and is binary");
      return Array.from(combined.slice(index));
    }
    for (let continuation = 1; continuation < length; continuation += 1) {
      const value = combined[index + continuation] ?? 0;
      if (value < 0x80 || value > 0xbf) {
        throw new GatewayError("binary_detected", "The resource is not valid UTF-8 and is binary");
      }
    }
    const second = combined[index + 1] ?? 0;
    if (
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second > 0x9f) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second > 0x8f)
    ) {
      throw new GatewayError("binary_detected", "The resource is not valid UTF-8 and is binary");
    }
    index += length;
  }
  return [];
}

export function sliceKnownText(
  value: string,
  startLine = 1,
  endLine?: number,
  maximumBytes = MAX_INLINE_TEXT_BYTES,
): KnownTextWindow {
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new GatewayError("invalid_arguments", "start_line must be a positive integer");
  }
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine)) {
    throw new GatewayError("invalid_arguments", "end_line must be greater than or equal to start_line");
  }
  const lines = splitLinesPreservingEndings(value);
  if (startLine > lines.length) return { state: "eof", total_lines: lines.length };
  const requestedEnd = Math.min(endLine ?? lines.length, lines.length);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let lineNumber = startLine; lineNumber <= requestedEnd; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line === undefined) break;
    const lineBytes = byteLength(line);
    if (selectedBytes + lineBytes > maximumBytes) {
      if (selected.length === 0) {
        throw new GatewayError("line_too_large", `Line ${lineNumber} cannot fit in one result`);
      }
      const largestSafeEnd = startLine + selected.length - 1;
      if (endLine !== undefined) {
        return {
          content: selected.join(""),
          end_line: largestSafeEnd,
          largest_safe_end_line: largestSafeEnd,
          start_line: startLine,
          state: "range_too_large",
          total_lines: lines.length,
        };
      }
      return {
        content: selected.join(""),
        end_line: largestSafeEnd,
        next_line: largestSafeEnd + 1,
        start_line: startLine,
        state: "partial",
        total_lines: lines.length,
      };
    }
    selected.push(line);
    selectedBytes += lineBytes;
  }
  const actualEnd = startLine + selected.length - 1;
  if (endLine === undefined && actualEnd < lines.length) {
    return {
      content: selected.join(""),
      end_line: actualEnd,
      next_line: actualEnd + 1,
      start_line: startLine,
      state: "partial",
      total_lines: lines.length,
    };
  }
  return {
    content: selected.join(""),
    end_line: actualEnd,
    start_line: startLine,
    state: "complete",
    total_lines: lines.length,
  };
}

export interface ScannedFileWindow {
  binary: boolean;
  content?: string;
  consumed_bytes: number;
  end_line?: number;
  next_line: number;
  /** True when the output size limit, not the chunk end or the requested end, stopped the window. */
  size_limited?: boolean;
  start_line?: number;
  state: "complete" | "partial" | "seeking";
  /** The number of lines in the file. Known only when the chunk reached the end of the file. */
  total_lines?: number;
}

/**
 * Scans one exact byte range. It consumes only complete lines unless the range reached EOF.
 * The caller can request the unconsumed suffix again without data loss.
 */
export function scanFileChunk(
  bytes: Uint8Array,
  cursorLine: number,
  requestedStartLine: number,
  requestedEndLine: number | undefined,
  eof: boolean,
): ScannedFileWindow {
  if (bytes.includes(0)) return { binary: true, consumed_bytes: 0, next_line: cursorLine, state: "complete" };
  let completeLength = bytes.length;
  if (!eof) {
    const lastLf = bytes.lastIndexOf(10);
    completeLength = lastLf < 0 ? 0 : lastLf + 1;
  }
  if (completeLength === 0 && bytes.length > 0) {
    if (cursorLine >= requestedStartLine && bytes.length > MAX_INLINE_TEXT_BYTES) {
      throw new GatewayError("line_too_large", `Line ${cursorLine} cannot fit in one result`);
    }
    return { binary: false, consumed_bytes: 0, next_line: cursorLine, state: "seeking" };
  }
  let decoded: string;
  try {
    decoded = decodeText(bytes.slice(0, completeLength));
  } catch (error) {
    if (error instanceof GatewayError) return { binary: true, consumed_bytes: 0, next_line: cursorLine, state: "complete" };
    throw error;
  }
  const lines = splitLinesPreservingEndings(decoded);
  const scanEndLine = cursorLine + lines.length - 1;
  const total = eof ? { total_lines: scanEndLine } : {};
  if (scanEndLine < requestedStartLine) {
    return {
      binary: false,
      consumed_bytes: completeLength,
      next_line: scanEndLine + 1,
      state: eof ? "complete" : "seeking",
      ...total,
    };
  }
  const windowStart = Math.max(requestedStartLine, cursorLine);
  const localStart = windowStart - cursorLine;
  const maximumEnd = requestedEndLine === undefined ? scanEndLine : Math.min(requestedEndLine, scanEndLine);
  const localEndExclusive = maximumEnd - cursorLine + 1;
  const selected = lines.slice(localStart, localEndExclusive);
  let fitCount = 0;
  let fitBytes = 0;
  for (const line of selected) {
    const size = byteLength(line);
    if (fitBytes + size > MAX_INLINE_TEXT_BYTES) break;
    fitBytes += size;
    fitCount += 1;
  }
  if (fitCount === 0 && selected.length > 0) {
    throw new GatewayError("line_too_large", `Line ${windowStart} cannot fit in one result`);
  }
  const returned = selected.slice(0, fitCount);
  const endLine = windowStart + returned.length - 1;
  const consumedLines = localStart + returned.length;
  const consumedText = lines.slice(0, consumedLines).join("");
  const consumedBytes = byteLength(consumedText);
  const requestComplete = requestedEndLine !== undefined && endLine >= requestedEndLine;
  const sourceComplete = eof && consumedLines >= lines.length;
  return {
    binary: false,
    content: returned.join(""),
    consumed_bytes: consumedBytes,
    end_line: endLine,
    next_line: endLine + 1,
    size_limited: fitCount < selected.length,
    start_line: windowStart,
    state: requestComplete || sourceComplete ? "complete" : "partial",
    ...total,
  };
}
