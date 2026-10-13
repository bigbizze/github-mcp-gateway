import { GatewayError } from "./gateway-error";

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

export interface ErrorEnvelope {
  error: {
    code: string;
    details?: unknown;
    message: string;
    request_id: string;
    retryable: boolean;
  };
  ok: false;
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

export function serializeEnvelope(envelope: SuccessEnvelope | ErrorEnvelope): string {
  const serialized = JSON.stringify(envelope);
  if (byteLength(serialized) <= MAX_RESULT_BYTES) return serialized;
  return JSON.stringify({
    error: {
      code: "output_limit_exceeded",
      message: "The connector could not safely fit this result. Use a smaller page or line range",
      request_id: crypto.randomUUID(),
      retryable: false,
    },
    ok: false,
  } satisfies ErrorEnvelope);
}

export function hasNextLink(link: string | undefined): boolean {
  if (!link) return false;
  return link.split(",").some((part) => /;\s*rel="next"\s*$/u.test(part.trim()));
}

export function fitCollection<T>(
  operation: string,
  data: Record<string, unknown>,
  key: string,
  items: readonly T[],
  nextRequest?: NextRequest,
): { data: Record<string, unknown>; included: number } {
  const selected: T[] = [];
  for (const item of items) {
    const candidate = {
      ...data,
      [key]: [...selected, item],
      ...(nextRequest ? { next_request: nextRequest } : {}),
    };
    if (byteLength(successEnvelope(operation, candidate)) > MAX_RESULT_BYTES) break;
    selected.push(item);
  }
  if (selected.length !== items.length) {
    throw new GatewayError(
      "output_limit_exceeded",
      "A normalized collection item did not fit safely. Retry with a smaller page",
    );
  }
  return {
    data: {
      ...data,
      [key]: selected,
      ...(nextRequest ? { next_request: nextRequest } : {}),
    },
    included: selected.length,
  };
}

export function boundedTextPrefix(value: string, maximum = MAX_INLINE_TEXT_BYTES): string {
  if (byteLength(value) <= maximum) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maximum) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}
