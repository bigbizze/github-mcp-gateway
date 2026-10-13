import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  describeOperation,
  type GitHubToolInput,
  isOperationName,
  operationCatalog,
  type OperationName,
  searchCatalog,
} from "./catalog";
import { GatewayError, normalizeGatewayError } from "./gateway-error";
import {
  byteLength,
  type ErrorEnvelope,
  MAX_RESULT_BYTES,
  serializeEnvelope,
  successEnvelope,
} from "./result";

export interface ResourceLinkData {
  description?: string;
  mimeType?: string;
  name: string;
  size?: number;
  uri: string;
}

export interface BackendResult {
  data: unknown;
  resource_link?: ResourceLinkData;
}

export interface GitHubBackend {
  execute(operation: OperationName, argumentsValue: Record<string, unknown>, userId: number): Promise<BackendResult>;
}

export type GatewayToolResult = CallToolResult;

function requestId(): string {
  return crypto.randomUUID();
}

function logResult(operation: string, status: "error" | "ok", id: string, errorCategory?: string): void {
  console.info(
    JSON.stringify({
      operation,
      status,
      request_id: id,
      ...(errorCategory ? { error_category: errorCategory } : {}),
    }),
  );
}

function errorResult(operation: string, error: unknown, id = requestId()): GatewayToolResult {
  const normalized = normalizeGatewayError(error);
  const envelope: ErrorEnvelope = {
    error: {
      code: normalized.code,
      ...(normalized.details !== undefined ? { details: normalized.details } : {}),
      message: normalized.message,
      request_id: id,
      retryable: normalized.retryable,
    },
    ok: false,
  };
  logResult(operation, "error", id, normalized.code);
  return { content: [{ text: serializeEnvelope(envelope), type: "text" }], isError: true };
}

function validationMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "The operation arguments are invalid";
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function executeGatewayRequest(
  backend: GitHubBackend,
  userId: number,
  request: GitHubToolInput,
): Promise<GatewayToolResult> {
  const id = requestId();
  const operation = request.action === "execute" ? request.operation : request.action;
  try {
    let backendResult: BackendResult;
    if (request.action === "search") {
      backendResult = { data: searchCatalog(request.query, request.limit, request.offset) };
    } else if (request.action === "describe") {
      if (!isOperationName(request.operation)) {
        throw new Error(`Unknown operation '${request.operation}'`);
      }
      backendResult = { data: describeOperation(request.operation) };
    } else {
      if (!isOperationName(request.operation)) {
        return errorResult(
          operation,
          new GatewayError("invalid_arguments", `Unknown operation '${request.operation}'`),
          id,
        );
      }
      const parsed = operationCatalog[request.operation].input.safeParse(request.arguments);
      if (!parsed.success) {
        const envelope: ErrorEnvelope = {
          error: {
            code: "invalid_arguments",
            message: validationMessage(parsed.error),
            request_id: id,
            retryable: false,
          },
          ok: false,
        };
        logResult(operation, "error", id, "invalid_arguments");
        return { content: [{ text: serializeEnvelope(envelope), type: "text" }], isError: true };
      }
      backendResult = await backend.execute(
        request.operation,
        parsed.data as Record<string, unknown>,
        userId,
      );
    }

    const envelope = successEnvelope(operation, backendResult.data);
    if (byteLength(envelope) > MAX_RESULT_BYTES) {
      const errorEnvelope: ErrorEnvelope = {
        error: {
          code: "output_limit_exceeded",
          message: "The connector could not safely fit this result. Use a smaller page or line range",
          request_id: id,
          retryable: false,
        },
        ok: false,
      };
      logResult(operation, "error", id, "output_limit_exceeded");
      return { content: [{ text: JSON.stringify(errorEnvelope), type: "text" }], isError: true };
    }
    logResult(operation, "ok", id);
    return {
      content: [
        { text: JSON.stringify(envelope), type: "text" },
        ...(backendResult.resource_link
          ? [{ ...backendResult.resource_link, type: "resource_link" as const }]
          : []),
      ],
    };
  } catch (error) {
    if (request.action === "describe" && !isOperationName(request.operation)) {
      const envelope: ErrorEnvelope = {
        error: {
          code: "invalid_arguments",
          message: `Unknown operation '${request.operation}'`,
          request_id: id,
          retryable: false,
        },
        ok: false,
      };
      logResult(operation, "error", id, "invalid_arguments");
      return { content: [{ text: JSON.stringify(envelope), type: "text" }], isError: true };
    }
    return errorResult(operation, error, id);
  }
}
