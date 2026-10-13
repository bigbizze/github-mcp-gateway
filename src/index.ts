import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { GitHubOAuthHandler } from "./auth/github-oauth";
import { githubAppConfig, isAuthorizedLogin, referenceTokenKey } from "./config";
import { requestRangeOverTls } from "./github/cloudflare-range";
import { GitHubReader } from "./github/reader";
import { createGitHubMcpServer } from "./mcp/server";
import { AesGcmTokenCodec } from "./security/reference-token";
import type { AuthProps, WorkerEnv } from "./types";

class McpApiHandler extends WorkerEntrypoint<WorkerEnv, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    // Checked on every request, so removing a login takes effect without waiting for its tokens to expire.
    if (!isAuthorizedLogin(this.env.AUTHORIZED_GITHUB_LOGINS, this.ctx.props.githubLogin)) {
      return new Response("This GitHub account is not authorized for this connector", { status: 403 });
    }
    const reader = new GitHubReader(
      githubAppConfig(this.env),
      new AesGcmTokenCodec(referenceTokenKey(this.env)),
      { artifactBaseUrl: new URL(request.url).origin, rangeRequest: requestRangeOverTls },
    );
    const handler = createMcpHandler(
      () => createGitHubMcpServer(reader, this.ctx.props.githubUserId),
      {
      authContext: { props: this.ctx.props },
      route: "/mcp",
      },
    );
    return handler.fetch(request);
  }
}

export default new OAuthProvider<WorkerEnv>({
  apiHandler: McpApiHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubOAuthHandler,
  resourceMetadata: {
    bearer_methods_supported: ["header"],
    resource_name: "GitHub MCP",
    scopes_supported: ["github:read"],
  },
  scopesSupported: ["github:read"],
  tokenEndpoint: "/token",
});
