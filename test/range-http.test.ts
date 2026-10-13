import { describe, expect, it, vi } from "vitest";
import { createTlsRangeRequest, type SocketConnector } from "../src/github/range-http";

const encoder = new TextEncoder();

function joinBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const joined = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function httpResponse(headers: string[], body = new Uint8Array()): Uint8Array<ArrayBuffer> {
  return joinBytes(encoder.encode([...headers, "", ""].join("\r\n")), body);
}

function fakeConnector(chunks: Uint8Array[], closeStream = false) {
  const writes: Uint8Array[] = [];
  const cancel = vi.fn();
  const close = vi.fn(async () => undefined);
  const connect = vi.fn<SocketConnector>(() => ({
    close,
    opened: Promise.resolve({}),
    readable: new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (closeStream) controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk.slice());
      },
    }),
  }));
  return { cancel, close, connect, writes };
}

describe("direct TLS byte ranges", () => {
  it("sends an uncompressed range request and stops after the exact body", async () => {
    const raw = httpResponse(
      [
        "HTTP/1.1 206 Partial Content",
        "Content-Length: 4",
        "Content-Range: bytes 5-8/20",
        "Connection: close",
      ],
      encoder.encode("data"),
    );
    const transport = fakeConnector([raw.slice(0, 19), raw.slice(19, 61), raw.slice(61)]);
    const requestRange = createTlsRangeRequest(transport.connect);

    const result = await requestRange(
      "https://raw.githubusercontent.com/owner/repo/sha/file.txt?token=signed",
      5,
      8,
    );

    expect(result.status).toBe(206);
    expect(result.headers.get("Content-Range")).toBe("bytes 5-8/20");
    expect(new TextDecoder().decode(result.bytes)).toBe("data");
    expect(transport.connect).toHaveBeenCalledWith(
      { hostname: "raw.githubusercontent.com", port: 443 },
      { allowHalfOpen: false, secureTransport: "on" },
    );
    const request = new TextDecoder().decode(joinBytes(...transport.writes));
    expect(request).toContain("GET /owner/repo/sha/file.txt?token=signed HTTP/1.1\r\n");
    expect(request).toContain("Accept-Encoding: identity\r\n");
    expect(request).toContain("Range: bytes=5-8\r\n");
    expect(request).not.toContain("Authorization:");
    expect(transport.cancel).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("rejects a compressed range before it reads the body", async () => {
    const headers = httpResponse([
      "HTTP/1.1 206 Partial Content",
      "Content-Encoding: gzip",
      "Content-Length: 4",
      "Content-Range: bytes 0-3/4",
    ]);
    const transport = fakeConnector([headers, encoder.encode("gzip")]);

    await expect(createTlsRangeRequest(transport.connect)(
      "https://raw.githubusercontent.com/owner/repo/sha/file.txt",
      0,
      3,
    )).rejects.toMatchObject({
      code: "range_not_supported",
      message: "The GitHub range source compressed the byte range",
    });
    expect(transport.cancel).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("rejects chunked range bodies", async () => {
    const response = httpResponse([
      "HTTP/1.1 206 Partial Content",
      "Content-Range: bytes 0-3/4",
      "Transfer-Encoding: chunked",
    ]);
    const transport = fakeConnector([response]);

    await expect(createTlsRangeRequest(transport.connect)(
      "https://raw.githubusercontent.com/owner/repo/sha/file.txt",
      0,
      3,
    )).rejects.toMatchObject({ code: "range_not_supported" });
  });

  it("rejects a response that ends before its declared body length", async () => {
    const response = httpResponse(
      [
        "HTTP/1.1 206 Partial Content",
        "Content-Length: 4",
        "Content-Range: bytes 0-3/4",
      ],
      encoder.encode("no"),
    );
    const transport = fakeConnector([response], true);

    await expect(createTlsRangeRequest(transport.connect)(
      "https://raw.githubusercontent.com/owner/repo/sha/file.txt",
      0,
      3,
    )).rejects.toMatchObject({
      code: "upstream_error",
      retryable: true,
    });
  });

  it.each([
    "http://raw.githubusercontent.com/owner/repo/file.txt",
    "https://github.com/owner/repo/file.txt",
    "https://raw.githubusercontent.com:444/owner/repo/file.txt",
    "https://user:password@raw.githubusercontent.com/owner/repo/file.txt",
    "https://raw.githubusercontent.com/owner/repo/file.txt#fragment",
    "not a URL",
  ])("rejects an unsafe download URL: %s", async (url) => {
    const transport = fakeConnector([]);

    await expect(createTlsRangeRequest(transport.connect)(url, 0, 3)).rejects.toMatchObject({
      code: "range_not_supported",
      message: "GitHub returned an unsafe file download URL",
    });
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it("rejects a byte range larger than one scan window", async () => {
    const transport = fakeConnector([]);

    await expect(createTlsRangeRequest(transport.connect)(
      "https://raw.githubusercontent.com/owner/repo/sha/file.txt",
      0,
      65_536,
    )).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it("rejects oversized HTTP headers", async () => {
    const transport = fakeConnector([encoder.encode(`HTTP/1.1 206 Partial Content\r\nX-Fill: ${"x".repeat(17_000)}`)]);

    await expect(createTlsRangeRequest(transport.connect)(
      "https://raw.githubusercontent.com/owner/repo/sha/file.txt",
      0,
      3,
    )).rejects.toMatchObject({
      code: "range_not_supported",
      message: "The GitHub range source returned oversized HTTP headers",
    });
  });
});
