export const MAX_RESULT_BYTES = 20_000;
export const MAX_INLINE_TEXT_BYTES = 16_000;

const encoder = new TextEncoder();

export interface NextRequest {
  action: "execute";
  arguments: Record<string, unknown>;
  operation: string;
}

export interface SuccessEnvelope {
  data: unknown;
  ok: true;
  operation: string;
}

export interface ResourceLink {
  description?: string;
  mimeType?: string;
  name: string;
  size?: number;
  uri: string;
}

/** What an operation returns. The MCP gateway wraps `data` in a success envelope. */
export interface OperationResult {
  data: unknown;
  resource_link?: ResourceLink;
}

export function byteLength(value: unknown): number {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

export function exactNextRequest(operation: string, argumentsValue: Record<string, unknown>): NextRequest {
  return { action: "execute", arguments: argumentsValue, operation };
}

export function successEnvelope(operation: string, data: unknown): SuccessEnvelope {
  return { data, ok: true, operation };
}

export function hasNextLink(link: string | undefined): boolean {
  if (!link) return false;
  return link.split(",").some((part) => /;\s*rel="next"\s*$/u.test(part.trim()));
}

/** Assembles a collection result. The MCP gateway enforces the overall size limit. */
export function collection(
  metadata: Record<string, unknown>,
  key: string,
  items: readonly unknown[],
  nextRequest?: NextRequest,
): Record<string, unknown> {
  return { ...metadata, [key]: items, ...(nextRequest ? { next_request: nextRequest } : {}) };
}
