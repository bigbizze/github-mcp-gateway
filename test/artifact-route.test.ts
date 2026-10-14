import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_SCOPE } from "../src/github/operations/workflows";
import type { ReferenceTokens } from "../src/security/reference-token";
import { handleArtifactRequest } from "../src/routes";
import { TEST_USER_ID, testReader } from "./support/reader";

const nowSeconds = 1_700_000_000;
const link = { artifact_id: 7, repository_full_name: "owner/repo" };

function artifactReader(fetchMock: typeof fetch, now = nowSeconds) {
  return testReader({
    fetch: fetchMock,
    now: () => now * 1000,
    request: async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 99 }, headers: {} };
      throw new Error(`Unexpected route ${route}`);
    },
  });
}

function artifactToken(tokens: ReferenceTokens): Promise<string> {
  return tokens.seal(ARTIFACT_SCOPE, TEST_USER_ID, 300, link);
}

function artifactRequest(token: string, method = "GET"): Request {
  return new Request(`https://worker.example/artifacts/v1/${token}`, { method });
}

describe("signed artifact route", () => {
  it.each(["GET", "HEAD"])("accepts %s and returns one safe storage redirect", async (method) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        headers: { Location: "https://storage.example/signed-zip?credential=bearer" },
        status: 302,
      }),
    );
    const { reader, tokens } = artifactReader(fetchMock);
    const token = await artifactToken(tokens);
    const response = await handleArtifactRequest(artifactRequest(token, method), reader, token);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://storage.example/signed-zip?credential=bearer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner/repo/actions/artifacts/7/zip");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer installation-99", "X-GitHub-Api-Version": "2026-03-10" },
      redirect: "manual",
    });
  });

  it("rejects other methods before a GitHub request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { reader, tokens } = artifactReader(fetchMock);
    const token = await artifactToken(tokens);
    const response = await handleArtifactRequest(artifactRequest(token, "POST"), reader, token);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects expired and unsafe-redirect tokens", async () => {
    const issued = artifactReader(vi.fn<typeof fetch>());
    const token = await artifactToken(issued.tokens);

    const expiredFetch = vi.fn<typeof fetch>();
    const expired = await handleArtifactRequest(
      artifactRequest(token),
      artifactReader(expiredFetch, nowSeconds + 301).reader,
      token,
    );
    expect(expired.status).toBe(404);
    expect(expiredFetch).not.toHaveBeenCalled();

    const unsafeFetch = vi.fn<typeof fetch>(async () =>
      new Response(null, { headers: { Location: "http://storage.example/file" }, status: 302 }),
    );
    const unsafe = await handleArtifactRequest(artifactRequest(token), artifactReader(unsafeFetch).reader, token);
    expect(unsafe.status).toBe(404);
  });

  it("rejects a valid token that was sealed for another purpose", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { reader, tokens } = artifactReader(fetchMock);
    const token = await tokens.seal({ operation: "fetch_file", purpose: "file" }, TEST_USER_ID, 300, link);
    const response = await handleArtifactRequest(artifactRequest(token), reader, token);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
