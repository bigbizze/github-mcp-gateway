import { createPrivateKey, generateKeyPairSync, verify, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  isAuthorizedLogin,
  loadConfig,
  normalizePrivateKey,
  parseAuthorizedLogins,
  type WorkerEnv,
} from "../src/config";

function oauthEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    AUTHORIZED_GITHUB_LOGINS: "example-user",
    COOKIE_ENCRYPTION_KEY: "a-secure-random-value-at-least-32-characters",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "line-1\\nline-2",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {} as WorkerEnv["OAUTH_PROVIDER"],
    REFERENCE_TOKEN_KEY: "11".repeat(32),
    ...overrides,
  };
}

describe("authorized GitHub login configuration", () => {
  it("normalizes case, whitespace, and duplicate entries", () => {
    expect(parseAuthorizedLogins(" First-User,second-user, FIRST-USER ")).toEqual(
      new Set(["first-user", "second-user"]),
    );
    const config = loadConfig(oauthEnv({ AUTHORIZED_GITHUB_LOGINS: "First-User,second-user" }));
    expect(isAuthorizedLogin(config, "FIRST-USER")).toBe(true);
    expect(isAuthorizedLogin(config, "third-user")).toBe(false);
  });

  it.each([undefined, "", " , "])("fails closed for %j", (value) => {
    expect(() => parseAuthorizedLogins(value)).toThrow(ConfigurationError);
  });
});

describe("operator configuration", () => {
  it("requires every OAuth setting", () => {
    for (const key of [
      "AUTHORIZED_GITHUB_LOGINS",
      "COOKIE_ENCRYPTION_KEY",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "REFERENCE_TOKEN_KEY",
    ] as const) {
      expect(() => loadConfig(oauthEnv({ [key]: "" }))).toThrow(ConfigurationError);
    }
  });

  it("rejects a short cookie-signing secret", () => {
    expect(() => loadConfig(oauthEnv({ COOKIE_ENCRYPTION_KEY: "too-short" }))).toThrow("at least 32 characters");
  });

  it("normalizes escaped newlines in the GitHub App private key", () => {
    expect(loadConfig(oauthEnv()).github).toEqual({
      appId: "123",
      privateKey: "line-1\nline-2",
    });
  });

  it("normalizes escaped Windows line breaks in the GitHub App private key", () => {
    expect(normalizePrivateKey("line-1\\r\\nline-2")).toBe("line-1\nline-2");
  });

  it("restores line breaks in a private key flattened onto one line", () => {
    const [a, b, c] = ["A".repeat(64), "B".repeat(64), "C".repeat(10)];
    const expected = [
      "-----BEGIN RSA PRIVATE KEY-----",
      a,
      b,
      c,
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");

    for (const flattened of [
      `-----BEGIN RSA PRIVATE KEY-----${a}${b}${c}-----END RSA PRIVATE KEY-----`,
      ` -----BEGIN RSA PRIVATE KEY----- ${a} ${b} ${c} -----END RSA PRIVATE KEY----- `,
    ]) {
      expect(normalizePrivateKey(flattened)).toBe(expected);
    }
  });

  it("leaves a private key that already has line breaks unchanged", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n";
    expect(normalizePrivateKey(pem)).toBe(pem);
    expect(loadConfig(oauthEnv({ GITHUB_APP_PRIVATE_KEY: pem })).github.privateKey).toBe(pem);
  });

  it("converts GitHub's PKCS#1 private key to PKCS#8 that WebCrypto can sign with", async () => {
    const { privateKey: pkcs1, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs1" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const pkcs8 = createPrivateKey(pkcs1).export({ format: "pem", type: "pkcs8" }).toString();

    for (const pasted of [
      pkcs1,
      pkcs1.trimEnd().replace(/\n/g, "\\n"),
      pkcs1.replace(/\n/g, ""),
      pkcs1.replace(/\n/g, " "),
    ]) {
      expect(loadConfig(oauthEnv({ GITHUB_APP_PRIVATE_KEY: pasted })).github.privateKey).toBe(pkcs8);
    }

    const der = Buffer.from(pkcs8.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
    const key = await webcrypto.subtle.importKey(
      "pkcs8",
      der,
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["sign"],
    );
    const data = new TextEncoder().encode("github-app-jwt");
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
    expect(verify("sha256", data, publicKey, Buffer.from(signature))).toBe(true);
    expect(loadConfig(oauthEnv({ GITHUB_APP_PRIVATE_KEY: pkcs8 })).github.privateKey).toBe(pkcs8);
  });

  it("requires a 64-character hexadecimal reference-token key", () => {
    expect(() => loadConfig(oauthEnv({ REFERENCE_TOKEN_KEY: "too-short" }))).toThrow("64 hexadecimal");
    expect(() => loadConfig(oauthEnv({ REFERENCE_TOKEN_KEY: "z".repeat(64) }))).toThrow("64 hexadecimal");
  });
});
