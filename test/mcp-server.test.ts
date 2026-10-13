import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubBackend } from "../src/github/gateway";
import { GatewayError } from "../src/github/gateway-error";
import { createGitHubMcpServer } from "../src/mcp/server";

function fakeBackend(): GitHubBackend {
  return { execute: vi.fn(async (operation, argumentsValue, userId) => ({ data: { arguments: argumentsValue, operation, user_id: userId } })) };
}

const closeCallbacks: Array<() => Promise<void>> = [];

async function connect(backend: GitHubBackend): Promise<Client> {
  const server = createGitHubMcpServer(backend, 42);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  return client;
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected a text tool result");
  return content.text;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map(async (close) => close()));
  vi.restoreAllMocks();
});

describe("GitHub MCP gateway", () => {
  it("exposes exactly one annotated tool", async () => {
    const client = await connect(fakeBackend());
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["github"]);
    expect(tools[0]?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain("search");
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain("describe");
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain("execute");
    expect(tools[0]?.description).toContain("Call execute directly");
    expect(tools[0]?.description).toContain("Do not call search or describe before every execute");
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain("No prior search or describe call is required");
  });

  it("searches concise catalog signatures with the default limit", async () => {
    const client = await connect(fakeBackend());
    const result = await client.callTool({
      arguments: { action: "search", query: "workflow artifact" },
      name: "github",
    });
    const envelope = JSON.parse(textResult(result)) as { data: { matches: Array<{ signature: string }> }; ok: boolean };

    expect(envelope.ok).toBe(true);
    expect(envelope.data.matches.length).toBeLessThanOrEqual(8);
    expect(envelope.data.matches.some((match) => match.signature.includes("artifact"))).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("describes the complete nested input and result schemas", async () => {
    const client = await connect(fakeBackend());
    const result = await client.callTool({
      arguments: { action: "describe", operation: "fetch_file" },
      name: "github",
    });
    const envelope = JSON.parse(textResult(result)) as {
      data: { description: string; input_schema: object; result_schema: object; signature: string };
      ok: boolean;
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.data.signature).toBe("fetch_file(initial_request | continuation_token)");
    expect(envelope.data.description).toContain("16,000 UTF-8 bytes");
    expect(envelope.data.description).toContain("state=partial");
    expect(envelope.data.description).toContain("range_too_large");
    expect(envelope.data.description).toContain("line_too_large");
    expect(JSON.stringify(envelope.data.input_schema)).toContain("repository_full_name");
    expect(JSON.stringify(envelope.data.result_schema)).toContain("next_request");
  });

  it("validates nested operation arguments and applies defaults", async () => {
    const backend = fakeBackend();
    const client = await connect(backend);
    const result = await client.callTool({
      arguments: {
        action: "execute",
        arguments: { repository_full_name: "owner/repo" },
        operation: "list_directory",
      },
      name: "github",
    });

    expect(result.isError).not.toBe(true);
    expect(backend.execute).toHaveBeenCalledWith(
      "list_directory",
      { limit: 20, offset: 0, path: "", repository_full_name: "owner/repo" },
      42,
    );

    const invalid = await client.callTool({
      arguments: {
        action: "execute",
        arguments: { per_page: 21, repository_full_name: "owner/repo" },
        operation: "search_issues",
      },
      name: "github",
    });
    const error = JSON.parse(textResult(invalid)) as { error: { code: string }; ok: boolean };
    expect(invalid.isError).toBe(true);
    expect(error).toMatchObject({ error: { code: "invalid_arguments" }, ok: false });
  });

  it("executes a known operation without a prior describe request", async () => {
    const backend = fakeBackend();
    const client = await connect(backend);
    const result = await client.callTool({
      arguments: {
        action: "execute",
        arguments: { repository_full_name: "owner/repo" },
        operation: "get_repository",
      },
      name: "github",
    });
    const envelope = JSON.parse(textResult(result)) as { data: { operation: string; user_id: number }; ok: boolean };

    expect(envelope).toMatchObject({ data: { operation: "get_repository", user_id: 42 }, ok: true });
  });

  it("returns safe error envelopes and sets isError", async () => {
    const backend = fakeBackend();
    vi.mocked(backend.execute).mockRejectedValueOnce(new GatewayError("not_found", "The resource was not found"));
    const client = await connect(backend);
    const result = await client.callTool({
      arguments: {
        action: "execute",
        arguments: { repository_full_name: "owner/repo" },
        operation: "get_repository",
      },
      name: "github",
    });
    const envelope = JSON.parse(textResult(result)) as { error: { code: string; request_id: string; retryable: boolean }; ok: boolean };

    expect(result.isError).toBe(true);
    expect(envelope).toMatchObject({ error: { code: "not_found", retryable: false }, ok: false });
    expect(envelope.error.request_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("replaces an implementation-fault overflow without a preview", async () => {
    const backend = fakeBackend();
    vi.mocked(backend.execute).mockResolvedValueOnce({ data: { unsafe: "x".repeat(25_000) } });
    const client = await connect(backend);
    const result = await client.callTool({
      arguments: {
        action: "execute",
        arguments: { repository_full_name: "owner/repo" },
        operation: "get_repository",
      },
      name: "github",
    });
    const envelope = JSON.parse(textResult(result)) as { error: { code: string }; ok: boolean; preview?: string };

    expect(result.isError).toBe(true);
    expect(envelope).toMatchObject({ error: { code: "output_limit_exceeded" }, ok: false });
    expect(envelope.preview).toBeUndefined();
    expect(new TextEncoder().encode(textResult(result)).byteLength).toBeLessThanOrEqual(20_000);
  });

  it("adds one MCP resource_link only for artifact downloads", async () => {
    const backend = fakeBackend();
    vi.mocked(backend.execute).mockResolvedValueOnce({
      data: { artifact_id: 7 },
      resource_link: {
        mimeType: "application/zip",
        name: "logs.zip",
        size: 12,
        uri: "https://worker.example/artifacts/v1/token",
      },
    });
    const client = await connect(backend);
    const result = await client.callTool({
      arguments: {
        action: "execute",
        arguments: { artifact_id: 7, repository_full_name: "owner/repo" },
        operation: "download_workflow_artifact",
      },
      name: "github",
    });

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[1]).toMatchObject({
      mimeType: "application/zip",
      name: "logs.zip",
      type: "resource_link",
      uri: "https://worker.example/artifacts/v1/token",
    });
  });
});
