import { GatewayError } from "../errors";

/** Readers for GitHub REST response bodies. A missing or mistyped optional field becomes null. */
export type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedShape(): GatewayError {
  return new GatewayError("upstream_error", "GitHub returned an unexpected response shape", true);
}

export function record(value: unknown): JsonRecord {
  if (!isRecord(value)) throw unexpectedShape();
  return value;
}

export function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw unexpectedShape();
  return value.map(record);
}

export function optionalRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? records(value) : [];
}

export function nested(value: JsonRecord, key: string): JsonRecord {
  return record(value[key]);
}

export function optionalNested(value: JsonRecord, key: string): JsonRecord | null {
  const item = value[key];
  return isRecord(item) ? item : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function requiredString(value: unknown): string {
  const result = stringValue(value);
  if (result === null) throw unexpectedShape();
  return result;
}

export function requiredNumber(value: unknown): number {
  const result = numberValue(value);
  if (result === null) throw unexpectedShape();
  return result;
}

export function userLogin(value: unknown): string | null {
  return isRecord(value) ? stringValue(value.login) : null;
}

export function labelNames(value: unknown): Array<string | null> {
  if (!Array.isArray(value)) return [];
  return value.map((label) => (typeof label === "string" ? label : stringValue(record(label).name)));
}
