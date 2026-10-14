import { z } from "zod";
import { GatewayError } from "../errors";

const TOKEN_VERSION = 3;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const textEncoder = new TextEncoder();

export type TokenPurpose = "artifact" | "file" | "organization_scan" | "repository_scan" | "text";

/** What a token may be used for. Both values are bound to the ciphertext as additional data. */
export interface TokenScope {
  operation: string;
  purpose: TokenPurpose;
}

/** A user ID that the token must belong to, or "any" for a bearer link that works without sign-in. */
export type TokenHolder = number | "any";

const envelopeSchema = z.object({
  body: z.unknown(),
  exp: z.number().int(),
  iat: z.number().int(),
  user_id: z.number().int(),
  v: z.literal(TOKEN_VERSION),
});

function invalidToken(message = "The reference token is invalid"): GatewayError {
  return new GatewayError("invalid_token", message);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidToken();
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw invalidToken();
  }
  if (base64UrlEncode(bytes) !== value) throw invalidToken("The reference token is invalid or was changed");
  return bytes;
}

function decodeHexKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    throw new Error("REFERENCE_TOKEN_KEY must contain 32 random bytes encoded as 64 hexadecimal characters");
  }
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function additionalData(scope: TokenScope): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(`github-mcp.reference-token.v${TOKEN_VERSION}\0${scope.purpose}\0${scope.operation}`);
}

/**
 * Encrypts continuation tokens and artifact links with AES-256-GCM. A token carries one JSON
 * body. `open` returns the body only after it passes the caller's schema.
 */
export class ReferenceTokens {
  private readonly key: Promise<CryptoKey>;

  constructor(
    keyHex: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = crypto.subtle.importKey("raw", decodeHexKey(keyHex), { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
  }

  async seal(scope: TokenScope, userId: number, ttlSeconds: number, body: unknown): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const envelope: z.infer<typeof envelopeSchema> = {
      body,
      exp: issuedAt + ttlSeconds,
      iat: issuedAt,
      user_id: userId,
      v: TOKEN_VERSION,
    };
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { additionalData: additionalData(scope), iv: nonce, name: "AES-GCM" },
        await this.key,
        textEncoder.encode(JSON.stringify(envelope)),
      ),
    );
    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);
    return `v${TOKEN_VERSION}.${base64UrlEncode(combined)}`;
  }

  async open<S extends z.ZodType>(
    token: string,
    scope: TokenScope,
    holder: TokenHolder,
    bodySchema: S,
  ): Promise<{ body: z.output<S>; userId: number }> {
    const [prefix, encoded, extra] = token.split(".");
    if (prefix !== `v${TOKEN_VERSION}` || !encoded || extra !== undefined) throw invalidToken();
    const combined = base64UrlDecode(encoded);
    if (combined.length <= NONCE_BYTES + TAG_BYTES) throw invalidToken();

    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { additionalData: additionalData(scope), iv: combined.slice(0, NONCE_BYTES), name: "AES-GCM" },
        await this.key,
        combined.slice(NONCE_BYTES),
      );
    } catch {
      throw invalidToken("The reference token is invalid or was changed");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw invalidToken();
    }
    const envelope = envelopeSchema.safeParse(decoded);
    if (!envelope.success) throw invalidToken();
    if (envelope.data.exp <= Math.floor(this.now() / 1000)) {
      throw invalidToken("The reference token expired. Start a new request");
    }
    if (holder !== "any" && envelope.data.user_id !== holder) {
      throw invalidToken("The reference token belongs to a different GitHub user");
    }
    const body = bodySchema.safeParse(envelope.data.body);
    if (!body.success) throw invalidToken();
    return { body: body.data, userId: envelope.data.user_id };
  }
}
