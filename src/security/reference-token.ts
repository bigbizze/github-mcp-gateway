import { ConfigurationError } from "../config";

const TOKEN_VERSION = 2;
const NONCE_BYTES = 12;
const textEncoder = new TextEncoder();

export type TokenPurpose = "artifact" | "file" | "organization_scan" | "repository_scan" | "text";

export interface ReferenceTokenPayload {
  args_hash: string;
  cursor: Record<string, unknown>;
  exp: number;
  iat: number;
  operation: string;
  purpose: TokenPurpose;
  resource: Record<string, unknown>;
  user_id: number;
  v: 2;
}

export interface OpenTokenOptions {
  operation: string;
  purpose: TokenPurpose;
  user_id?: number;
}

export class ReferenceTokenError extends Error {
  readonly code: "invalid_token" | "stale_reference";

  constructor(message: string, code: "invalid_token" | "stale_reference" = "invalid_token") {
    super(message);
    this.name = "ReferenceTokenError";
    this.code = code;
  }
}

export interface TokenCodec {
  open(token: string, options: OpenTokenOptions): Promise<ReferenceTokenPayload>;
  seal(payload: Omit<ReferenceTokenPayload, "v">): Promise<string>;
}

function decodeHexKey(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    throw new ConfigurationError(
      "REFERENCE_TOKEN_KEY must contain 32 random bytes encoded as 64 hexadecimal characters",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ReferenceTokenError("The reference token is invalid");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let bytes: Uint8Array;
  try {
    const binary = atob(padded);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ReferenceTokenError("The reference token is invalid");
  }
  if (base64UrlEncode(bytes) !== value) {
    throw new ReferenceTokenError("The reference token is invalid or was changed");
  }
  return bytes;
}

function isPayload(value: unknown): value is ReferenceTokenPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ReferenceTokenPayload>;
  return (
    payload.v === TOKEN_VERSION &&
    typeof payload.args_hash === "string" &&
    typeof payload.cursor === "object" &&
    payload.cursor !== null &&
    typeof payload.exp === "number" &&
    typeof payload.iat === "number" &&
    typeof payload.operation === "string" &&
    ["artifact", "file", "organization_scan", "repository_scan", "text"].includes(
      payload.purpose ?? "",
    ) &&
    typeof payload.resource === "object" &&
    payload.resource !== null &&
    Number.isSafeInteger(payload.user_id)
  );
}

function routingAdditionalData(purpose: TokenPurpose, operation: string): ArrayBuffer {
  return textEncoder.encode(`github-mcp.reference-token.v${TOKEN_VERSION}\0${purpose}\0${operation}`).buffer as ArrayBuffer;
}

export class AesGcmTokenCodec implements TokenCodec {
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(
    keyHex: string,
    private readonly now: () => number = Date.now,
  ) {
    const bytes = decodeHexKey(keyHex);
    this.keyPromise = crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
      "decrypt",
      "encrypt",
    ]);
  }

  async seal(payload: Omit<ReferenceTokenPayload, "v">): Promise<string> {
    const key = await this.keyPromise;
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const plaintext = textEncoder.encode(JSON.stringify({ ...payload, v: TOKEN_VERSION }));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          additionalData: routingAdditionalData(payload.purpose, payload.operation),
          iv: nonce,
          name: "AES-GCM",
        },
        key,
        plaintext,
      ),
    );
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);
    return `v${TOKEN_VERSION}.${base64UrlEncode(combined)}`;
  }

  async open(token: string, options: OpenTokenOptions): Promise<ReferenceTokenPayload> {
    const [prefix, encoded, extra] = token.split(".");
    if (prefix !== `v${TOKEN_VERSION}` || !encoded || extra !== undefined) {
      throw new ReferenceTokenError("The reference token is invalid");
    }
    const combined = base64UrlDecode(encoded);
    if (combined.length <= NONCE_BYTES + 16) {
      throw new ReferenceTokenError("The reference token is invalid");
    }
    const key = await this.keyPromise;
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          additionalData: routingAdditionalData(options.purpose, options.operation),
          iv: combined.slice(0, NONCE_BYTES),
          name: "AES-GCM",
        },
        key,
        combined.slice(NONCE_BYTES),
      );
    } catch {
      throw new ReferenceTokenError("The reference token is invalid or was changed");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new ReferenceTokenError("The reference token is invalid");
    }
    if (!isPayload(decoded)) throw new ReferenceTokenError("The reference token is invalid");
    if (decoded.exp <= Math.floor(this.now() / 1000)) {
      throw new ReferenceTokenError("The reference token expired. Start a new request");
    }
    if (decoded.purpose !== options.purpose) {
      throw new ReferenceTokenError("The reference token has the wrong purpose");
    }
    if (decoded.operation !== options.operation) {
      throw new ReferenceTokenError("The reference token is for a different operation");
    }
    if (options.user_id !== undefined && decoded.user_id !== options.user_id) {
      throw new ReferenceTokenError("The reference token belongs to a different GitHub user");
    }
    return decoded;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export async function argumentHash(value: unknown): Promise<string> {
  const data = textEncoder.encode(JSON.stringify(canonicalize(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bodyHash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
