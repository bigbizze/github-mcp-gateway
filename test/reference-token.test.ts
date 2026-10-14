import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ReferenceTokens, type TokenScope } from "../src/security/reference-token";

const key = "01".repeat(32);
const scope: TokenScope = { operation: "fetch_file", purpose: "file" };
const bodySchema = z.strictObject({ path: z.string(), repository_full_name: z.string() });
const body = { path: "secret.txt", repository_full_name: "owner/repo" };

function tokens(start = 1_700_000_000) {
  let now = start;
  return { advance: (seconds: number) => { now += seconds; }, tokens: new ReferenceTokens(key, () => now * 1000) };
}

describe("AES-GCM reference tokens", () => {
  it("requires exactly 32 hexadecimal key bytes", () => {
    expect(() => new ReferenceTokens("short")).toThrow("64 hexadecimal");
    expect(() => new ReferenceTokens("z".repeat(64))).toThrow("64 hexadecimal");
  });

  it("encrypts the body and returns it after schema validation", async () => {
    const { tokens: codec } = tokens();
    const token = await codec.seal(scope, 42, 60, body);

    expect(token).toMatch(/^v3\.[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain("secret.txt");
    await expect(codec.open(token, scope, 42, bodySchema)).resolves.toEqual({ body, userId: 42 });
    await expect(codec.open(token, scope, "any", bodySchema)).resolves.toEqual({ body, userId: 42 });
  });

  it("rejects a changed token and an older token version", async () => {
    const { tokens: codec } = tokens();
    const token = await codec.seal(scope, 42, 60, body);
    const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expect(codec.open(changed, scope, 42, bodySchema)).rejects.toMatchObject({ code: "invalid_token" });
    await expect(codec.open(token.replace(/^v3/u, "v2"), scope, 42, bodySchema)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects purpose confusion, operation confusion, user mismatch, a wrong body, and expiry", async () => {
    const { advance, tokens: codec } = tokens();
    const token = await codec.seal(scope, 42, 60, body);

    await expect(codec.open(token, { ...scope, purpose: "text" }, 42, bodySchema)).rejects.toThrow("changed");
    await expect(codec.open(token, { ...scope, operation: "read_text" }, 42, bodySchema)).rejects.toThrow("changed");
    await expect(codec.open(token, scope, 7, bodySchema)).rejects.toThrow("different GitHub user");
    await expect(codec.open(token, scope, 42, z.strictObject({ path: z.number() }))).rejects.toMatchObject({
      code: "invalid_token",
    });
    advance(61);
    await expect(codec.open(token, scope, 42, bodySchema)).rejects.toThrow("expired");
  });
});
