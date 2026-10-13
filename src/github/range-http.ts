import { GatewayError } from "./gateway-error";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_RANGE_BYTES = 64 * 1024;
const MAX_REQUEST_TARGET_BYTES = 16 * 1024;
const RAW_GITHUB_HOST = "raw.githubusercontent.com";

export interface RangeHttpResponse {
  bytes: Uint8Array;
  headers: Headers;
  status: number;
}

export type RangeRequest = (url: string, start: number, end: number) => Promise<RangeHttpResponse>;

interface SocketLike {
  readonly opened: Promise<unknown>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

interface SocketAddress {
  hostname: string;
  port: number;
}

interface SocketOptions {
  allowHalfOpen: boolean;
  secureTransport: "on";
}

export type SocketConnector = (address: SocketAddress, options: SocketOptions) => SocketLike;

interface ParsedHeaders {
  headers: Headers;
  status: number;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(new ArrayBuffer(left.byteLength + right.byteLength));
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function hasInvalidHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 10 && code <= 31) || code === 127) return true;
  }
  return false;
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let index = 3; index < bytes.byteLength; index += 1) {
    if (bytes[index - 3] === 13 && bytes[index - 2] === 10 && bytes[index - 1] === 13 && bytes[index] === 10) {
      return index + 1;
    }
  }
  return -1;
}

function parseHeaders(bytes: Uint8Array): ParsedHeaders {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GatewayError("range_not_supported", "The GitHub range source returned invalid HTTP headers");
  }
  const lines = text.split("\r\n");
  const statusLine = lines.shift();
  const statusMatch = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/u.exec(statusLine ?? "");
  if (!statusMatch) {
    throw new GatewayError("range_not_supported", "The GitHub range source returned an invalid HTTP status line");
  }
  const status = Number(statusMatch[1]);
  const headers = new Headers();
  const singleValueHeaders = new Set(["content-encoding", "content-length", "content-range", "location", "transfer-encoding"]);
  for (const line of lines) {
    if (line.length === 0 || /^[ \t]/u.test(line)) {
      throw new GatewayError("range_not_supported", "The GitHub range source returned invalid HTTP headers");
    }
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (separator <= 0 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || hasInvalidHeaderValue(value)) {
      throw new GatewayError("range_not_supported", "The GitHub range source returned invalid HTTP headers");
    }
    if (singleValueHeaders.has(name) && headers.has(name)) {
      throw new GatewayError("range_not_supported", "The GitHub range source returned duplicate control headers");
    }
    headers.append(name, value);
  }
  return { headers, status };
}

function contentLength(headers: Headers, maximum: number): number {
  if (headers.has("Transfer-Encoding")) {
    throw new GatewayError("range_not_supported", "The GitHub range source returned a streamed HTTP body");
  }
  const encoding = headers.get("Content-Encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new GatewayError("range_not_supported", "The GitHub range source compressed the byte range");
  }
  const value = headers.get("Content-Length");
  if (!value || !/^[0-9]+$/u.test(value)) {
    throw new GatewayError("range_not_supported", "The GitHub range source omitted the HTTP body length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum) {
    throw new GatewayError("range_not_supported", "The GitHub range source returned an invalid HTTP body length");
  }
  return length;
}

async function readResponse(socket: SocketLike, maximumBodyBytes: number): Promise<RangeHttpResponse> {
  const reader = socket.readable.getReader();
  let buffered = new Uint8Array();
  let parsed: ParsedHeaders | undefined;
  let headerEnd = -1;
  let expectedBodyBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength === 0) continue;
      buffered = appendBytes(buffered, result.value);
      if (!parsed) {
        headerEnd = findHeaderEnd(buffered);
        if (headerEnd < 0) {
          if (buffered.byteLength > MAX_HEADER_BYTES) {
            throw new GatewayError("range_not_supported", "The GitHub range source returned oversized HTTP headers");
          }
          continue;
        }
        if (headerEnd > MAX_HEADER_BYTES) {
          throw new GatewayError("range_not_supported", "The GitHub range source returned oversized HTTP headers");
        }
        parsed = parseHeaders(buffered.slice(0, headerEnd - 4));
        if (parsed.status !== 206) {
          return { bytes: new Uint8Array(), headers: parsed.headers, status: parsed.status };
        }
        expectedBodyBytes = contentLength(parsed.headers, maximumBodyBytes);
      }
      const receivedBodyBytes = buffered.byteLength - headerEnd;
      if (receivedBodyBytes > expectedBodyBytes) {
        throw new GatewayError("range_not_supported", "The GitHub range source exceeded the HTTP body length");
      }
      if (receivedBodyBytes === expectedBodyBytes) {
        return {
          bytes: buffered.slice(headerEnd),
          headers: parsed.headers,
          status: parsed.status,
        };
      }
      if (buffered.byteLength > MAX_HEADER_BYTES + maximumBodyBytes) {
        throw new GatewayError("range_not_supported", "The GitHub range source exceeded the byte-range limit");
      }
    }
    throw new GatewayError("upstream_error", "The GitHub range connection ended before the response was complete", true);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function requestTarget(url: URL): string {
  if (
    url.protocol !== "https:"
    || url.hostname !== RAW_GITHUB_HOST
    || url.port
    || url.username
    || url.password
    || url.hash
  ) {
    throw new GatewayError("range_not_supported", "GitHub returned an unsafe file download URL");
  }
  const target = `${url.pathname}${url.search}`;
  if (new TextEncoder().encode(target).byteLength > MAX_REQUEST_TARGET_BYTES) {
    throw new GatewayError("range_not_supported", "GitHub returned an oversized file download URL");
  }
  return target;
}

export function createTlsRangeRequest(connectSocket: SocketConnector): RangeRequest {
  return async (urlValue, start, end) => {
    const rangeLength = end - start + 1;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || !Number.isSafeInteger(rangeLength)
      || start < 0
      || end < start
      || rangeLength > MAX_RANGE_BYTES
    ) {
      throw new GatewayError("invalid_arguments", "The internal byte range is invalid");
    }
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      throw new GatewayError("range_not_supported", "GitHub returned an unsafe file download URL");
    }
    const target = requestTarget(url);
    const socket = connectSocket(
      { hostname: RAW_GITHUB_HOST, port: 443 },
      { allowHalfOpen: false, secureTransport: "on" },
    );
    try {
      await socket.opened;
      const writer = socket.writable.getWriter();
      try {
        const request = [
          `GET ${target} HTTP/1.1`,
          `Host: ${RAW_GITHUB_HOST}`,
          "Accept: application/octet-stream",
          "Accept-Encoding: identity",
          `Range: bytes=${start}-${end}`,
          "User-Agent: github-mcp/0.2.0",
          "Connection: close",
          "",
          "",
        ].join("\r\n");
        await writer.write(new TextEncoder().encode(request));
      } finally {
        writer.releaseLock();
      }
      return await readResponse(socket, rangeLength);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("upstream_error", "The GitHub range connection failed", true);
    } finally {
      await socket.close().catch(() => undefined);
    }
  };
}
