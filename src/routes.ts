import { handleOAuthRoute } from "./auth/github-oauth";
import { type Config, loadConfig, type WorkerEnv } from "./config";
import type { GitHubReader } from "./github/reader";

const artifactHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/** Redirects a valid, unexpired artifact link to GitHub's signed ZIP URL. Every failure is a 404. */
export async function handleArtifactRequest(request: Request, reader: GitHubReader, token: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { headers: { ...artifactHeaders, Allow: "GET, HEAD" }, status: 405 });
  }
  try {
    const location = await reader.artifactRedirect(token);
    return new Response(null, { headers: { ...artifactHeaders, Location: location }, status: 302 });
  } catch {
    return new Response("Artifact link is invalid or expired", { headers: artifactHeaders, status: 404 });
  }
}

/** Routes that do not need an MCP access token. */
export function createPublicRoutes(
  createReader: (config: Config, origin: string) => GitHubReader,
): ExportedHandler<WorkerEnv> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok" });

      const artifactToken = /^\/artifacts\/v1\/([^/]+)$/u.exec(url.pathname)?.[1];
      if (artifactToken) {
        let reader: GitHubReader;
        try {
          reader = createReader(loadConfig(env), url.origin);
        } catch {
          return new Response("Artifact link is invalid or expired", { headers: artifactHeaders, status: 404 });
        }
        return handleArtifactRequest(request as unknown as Request, reader, artifactToken);
      }

      return (await handleOAuthRoute(request as unknown as Request, env)) ?? new Response("Not found", { status: 404 });
    },
  };
}
