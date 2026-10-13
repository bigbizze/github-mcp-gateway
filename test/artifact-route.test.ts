import { describe, expect, it, vi } from "vitest";
import { GitHubReader, type OctokitLike } from "../src/github/reader";
import { AesGcmTokenCodec, argumentHash } from "../src/security/reference-token";

const key = "ab".repeat(32);
const nowSeconds = 1_700_000_000;

async function artifactToken(codec: AesGcmTokenCodec): Promise<string> {
  const resource = {
    artifact_id: 7,
    name: "logs",
    repository_full_name: "owner/repo",
    size_in_bytes: 123,
  };
  return codec.seal({
    args_hash: await argumentHash(resource),
    cursor: {},
    exp: nowSeconds + 300,
    iat: nowSeconds,
    operation: "download_workflow_artifact",
    purpose: "artifact",
    resource,
    user_id: 42,
  });
}

function reader(fetchMock: typeof fetch, codec: AesGcmTokenCodec): GitHubReader {
  const octokit: OctokitLike = {
    request: vi.fn(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") {
        return { data: { id: 99 }, headers: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    }),
  };
  return new GitHubReader(
    { appId: "1", privateKey: "test-key" },
    codec,
    {
      artifactBaseUrl: "https://worker.example",
      authFactory: () => async (options) => ({
        token: options.type === "app" ? "app-token" : "installation-token",
      }),
      fetch: fetchMock,
      now: () => nowSeconds * 1000,
      octokitFactory: () => octokit,
    },
  );
}

describe("signed artifact route", () => {
  it.each(["GET", "HEAD"])("accepts %s and returns one safe storage redirect", async (method) => {
    const codec = new AesGcmTokenCodec(key, () => nowSeconds * 1000);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        headers: { Location: "https://storage.example/signed-zip?credential=bearer" },
        status: 302,
      }),
    );
    const service = reader(fetchMock, codec);
    const token = await artifactToken(codec);
    const response = await service.handleArtifactRequest(
      new Request(`https://worker.example/artifacts/v1/${token}`, { method }),
      token,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://storage.example/signed-zip?credential=bearer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner/repo/actions/artifacts/7/zip");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer installation-token", "X-GitHub-Api-Version": "2026-03-10" },
      redirect: "manual",
    });
  });

  it("rejects other methods before a GitHub request", async () => {
    const codec = new AesGcmTokenCodec(key, () => nowSeconds * 1000);
    const fetchMock = vi.fn<typeof fetch>();
    const service = reader(fetchMock, codec);
    const token = await artifactToken(codec);
    const response = await service.handleArtifactRequest(
      new Request(`https://worker.example/artifacts/v1/${token}`, { method: "POST" }),
      token,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects expired, changed, and unsafe-redirect tokens", async () => {
    const codec = new AesGcmTokenCodec(key, () => nowSeconds * 1000);
    const token = await artifactToken(codec);
    const expiredCodec = new AesGcmTokenCodec(key, () => (nowSeconds + 301) * 1000);
    const safeFetch = vi.fn<typeof fetch>();
    const expired = await reader(safeFetch, expiredCodec).handleArtifactRequest(
      new Request(`https://worker.example/artifacts/v1/${token}`),
      token,
    );
    expect(expired.status).toBe(404);
    expect(safeFetch).not.toHaveBeenCalled();

    const unsafeFetch = vi.fn<typeof fetch>(async () =>
      new Response(null, { headers: { Location: "http://storage.example/file" }, status: 302 }),
    );
    const unsafe = await reader(unsafeFetch, codec).handleArtifactRequest(
      new Request(`https://worker.example/artifacts/v1/${token}`),
      token,
    );
    expect(unsafe.status).toBe(404);
  });

  it("rejects a valid token whose resource hash does not match", async () => {
    const codec = new AesGcmTokenCodec(key, () => nowSeconds * 1000);
    const token = await codec.seal({
      args_hash: "wrong-resource-hash",
      cursor: {},
      exp: nowSeconds + 300,
      iat: nowSeconds,
      operation: "download_workflow_artifact",
      purpose: "artifact",
      resource: { artifact_id: 7, repository_full_name: "owner/repo" },
      user_id: 42,
    });
    const fetchMock = vi.fn<typeof fetch>();
    const response = await reader(fetchMock, codec).handleArtifactRequest(
      new Request(`https://worker.example/artifacts/v1/${token}`),
      token,
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
