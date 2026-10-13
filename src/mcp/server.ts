import { McpServer } from "@modelcontextprotocol/server";
import { githubToolInputSchema } from "../github/catalog";
import { executeGatewayRequest, type GitHubBackend } from "../github/gateway";

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
};

export function createGitHubMcpServer(backend: GitHubBackend, githubUserId = 0): McpServer {
  const server = new McpServer({ name: "github-mcp", version: "0.2.0" });
  server.registerTool(
    "github",
    {
      annotations: readOnlyAnnotations,
      description:
        "Read GitHub through a bounded operation catalog. Call execute directly when you know the operation and arguments. Use search only to discover an operation. Use describe only when a concise signature is insufficient. Do not call search or describe before every execute.",
      inputSchema: githubToolInputSchema,
    },
    async (request) => executeGatewayRequest(backend, githubUserId, request),
  );
  return server;
}
