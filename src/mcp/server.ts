import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { GatewayError, toGatewayError } from "../errors";
import {
  describeOperation,
  type GitHubToolInput,
  githubToolInputSchema,
  type OperationCall,
  parseOperation,
  parseOperationName,
  searchCatalog,
} from "../github/catalog";
import { byteLength, MAX_RESULT_BYTES, type OperationResult, successEnvelope } from "../github/result";
import packageJson from "../../package.json";

/** What the tool needs from the GitHub layer. Tests replace it with a fake. */
export interface GitHubBackend {
  execute(call: OperationCall, userId: number): Promise<OperationResult>;
}

function log(operation: string, requestId: string, errorCode?: string): void {
  console.info(
    JSON.stringify({
      operation,
      request_id: requestId,
      status: errorCode ? "error" : "ok",
      ...(errorCode ? { error_category: errorCode } : {}),
    }),
  );
}

function errorResult(operation: string, requestId: string, error: unknown): CallToolResult {
  const normalized = toGatewayError(error);
  log(operation, requestId, normalized.code);
  const envelope = {
    error: {
      code: normalized.code,
      ...(normalized.details !== undefined ? { details: normalized.details } : {}),
      message: normalized.message,
      request_id: requestId,
      retryable: normalized.retryable,
    },
    ok: false,
  };
  return { content: [{ text: JSON.stringify(envelope), type: "text" }], isError: true };
}

async function dispatch(backend: GitHubBackend, userId: number, request: GitHubToolInput): Promise<OperationResult> {
  switch (request.action) {
    case "search":
      return { data: searchCatalog(request.query, request.limit, request.offset) };
    case "describe":
      return { data: describeOperation(parseOperationName(request.operation)) };
    case "execute":
      return backend.execute(parseOperation(request.operation, request.arguments), userId);
  }
}

/**
 * Runs one tool call. Every result, success or error, is one JSON text block of at most
 * MAX_RESULT_BYTES. A result that would be larger becomes an `output_limit_exceeded` error.
 */
export async function handleToolCall(backend: GitHubBackend, userId: number, request: GitHubToolInput): Promise<CallToolResult> {
  const requestId = crypto.randomUUID();
  const operation = request.action === "execute" ? request.operation : request.action;
  try {
    const result = await dispatch(backend, userId, request);
    const text = JSON.stringify(successEnvelope(operation, result.data));
    if (byteLength(text) > MAX_RESULT_BYTES) {
      throw new GatewayError(
        "output_limit_exceeded",
        "The connector could not safely fit this result. Use a smaller page or line range",
      );
    }
    log(operation, requestId);
    return {
      content: [
        { text, type: "text" },
        ...(result.resource_link ? [{ ...result.resource_link, type: "resource_link" as const }] : []),
      ],
    };
  } catch (error) {
    return errorResult(operation, requestId, error);
  }
}

export function createGitHubMcpServer(backend: GitHubBackend, userId: number): McpServer {
  const server = new McpServer({ name: "github-mcp", version: packageJson.version });
  server.registerTool(
    "github",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "Read GitHub through a bounded operation catalog. Call execute directly when you know the operation and arguments. Use search only to discover an operation. Use describe only when a concise signature is insufficient. Do not call search or describe before every execute.",
      inputSchema: githubToolInputSchema,
    },
    (request) => handleToolCall(backend, userId, request),
  );
  return server;
}
