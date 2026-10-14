import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AuthProps } from "./auth/github-oauth";
import { type Config, isAuthorizedLogin, loadConfig, type WorkerEnv } from "./config";
import { createTlsRangeRequest } from "./github/range-http";
import { GitHubReader } from "./github/reader";
import { createGitHubClients } from "./github/session";
import { createGitHubMcpServer } from "./mcp/server";
import { createPublicRoutes } from "./routes";
import { ReferenceTokens } from "./security/reference-token";

const rangeRequest = createTlsRangeRequest(connect);

function createReader(config: Config, origin: string): GitHubReader {
  return new GitHubReader({
    artifactBaseUrl: origin,
    clients: createGitHubClients(config.github),
    rangeRequest,
    tokens: new ReferenceTokens(config.referenceTokenKey),
  });
}

/** Serves `/mcp` for requests that carry a valid MCP access token. */
class McpApiHandler extends WorkerEntrypoint<WorkerEnv, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    const config = loadConfig(this.env);
    // Checked on every request, so removing a login takes effect without waiting for its tokens to expire.
    if (!isAuthorizedLogin(config, this.ctx.props.githubLogin)) {
      return new Response("This GitHub account is not authorized for this connector", { status: 403 });
    }
    const reader = createReader(config, new URL(request.url).origin);
    const handler = createMcpHandler(() => createGitHubMcpServer(reader, this.ctx.props.githubUserId), {
      authContext: { props: this.ctx.props },
      route: "/mcp",
    });
    return handler.fetch(request);
  }
}

export default new OAuthProvider<WorkerEnv>({
  apiHandler: McpApiHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/register",
  defaultHandler: createPublicRoutes(createReader),
  resourceMetadata: {
    bearer_methods_supported: ["header"],
    resource_name: "GitHub MCP",
    scopes_supported: ["github:read"],
  },
  scopesSupported: ["github:read"],
  tokenEndpoint: "/token",
});
