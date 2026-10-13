import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/config";
import {
  AesGcmTokenCodec,
  argumentHash,
  bodyHash,
  type ReferenceTokenPayload,
} from "../src/security/reference-token";

const key = "01".repeat(32);

function payload(now: number): Omit<ReferenceTokenPayload, "v"> {
  return {
    args_hash: "argument-hash",
    cursor: { byte_offset: 100 },
    exp: now + 60,
    iat: now,
    operation: "fetch_file",
    purpose: "file",
    resource: { path: "secret.txt", repository_full_name: "owner/repo" },
    user_id: 42,
  };
}

describe("AES-GCM reference tokens", () => {
  it("requires exactly 32 hexadecimal key bytes", () => {
    expect(() => new AesGcmTokenCodec("short")).toThrow(ConfigurationError);
    expect(() => new AesGcmTokenCodec("z".repeat(64))).toThrow("64 hexadecimal");
    expect(() => new AesGcmTokenCodec(key)).not.toThrow();
  });

  it("encrypts and authenticates the complete payload", async () => {
    const now = 1_700_000_000;
    const codec = new AesGcmTokenCodec(key, () => now * 1000);
    const token = await codec.seal(payload(now));

    expect(token).toMatch(/^v2\.[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain("secret.txt");
    await expect(codec.open(token, { operation: "fetch_file", purpose: "file", user_id: 42 })).resolves.toMatchObject({
      operation: "fetch_file",
      purpose: "file",
      user_id: 42,
      v: 2,
    });

    const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await expect(codec.open(changed, { operation: "fetch_file", purpose: "file" })).rejects.toThrow("changed");
  });

  it("rejects version 1 tokens", async () => {
    const now = 1_700_000_000;
    const codec = new AesGcmTokenCodec(key, () => now * 1000);
    const token = await codec.seal(payload(now));

    await expect(codec.open(token.replace(/^v2/u, "v1"), {
      operation: "fetch_file",
      purpose: "file",
    })).rejects.toThrow("invalid");
  });

  it("rejects expiry, purpose confusion, operation confusion, and user mismatch", async () => {
    let now = 1_700_000_000;
    const codec = new AesGcmTokenCodec(key, () => now * 1000);
    const token = await codec.seal(payload(now));

    await expect(codec.open(token, { operation: "fetch_file", purpose: "text" })).rejects.toThrow("changed");
    await expect(codec.open(token, { operation: "read_text", purpose: "file" })).rejects.toThrow("changed");
    await expect(codec.open(token, { operation: "fetch_file", purpose: "file", user_id: 7 })).rejects.toThrow("different GitHub user");
    now += 61;
    await expect(codec.open(token, { operation: "fetch_file", purpose: "file" })).rejects.toThrow("expired");
  });

  it("hashes normalized arguments without property-order changes", async () => {
    await expect(argumentHash({ a: 1, nested: { x: 2, y: 3 } })).resolves.toBe(
      await argumentHash({ nested: { y: 3, x: 2 }, a: 1 }),
    );
    await expect(argumentHash({ a: 2 })).resolves.not.toBe(await argumentHash({ a: 1 }));
  });

  it("hashes raw UTF-8 body bytes", async () => {
    await expect(bodyHash("hello")).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    await expect(bodyHash("hello")).resolves.not.toBe(await argumentHash("hello"));
  });
});
