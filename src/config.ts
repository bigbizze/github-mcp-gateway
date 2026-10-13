import type { GitHubAppConfig, WorkerEnv } from "./types";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function parseAuthorizedLogins(value: string | undefined): Set<string> {
  const logins = new Set(
    (value ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );

  if (logins.size === 0) {
    throw new ConfigurationError("AUTHORIZED_GITHUB_LOGINS must contain at least one GitHub login");
  }

  return logins;
}

export function isAuthorizedLogin(value: string | undefined, login: string): boolean {
  return parseAuthorizedLogins(value).has(login.toLowerCase());
}

function requireValue(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new ConfigurationError(`${name} is required`);
  }

  return value;
}

function requireSecret(name: string, value: string | undefined): string {
  const secret = requireValue(name, value);
  if (secret.length < 32) {
    throw new ConfigurationError(`${name} must contain at least 32 characters`);
  }
  return secret;
}

export function referenceTokenKey(env: WorkerEnv): string {
  const key = requireValue("REFERENCE_TOKEN_KEY", env.REFERENCE_TOKEN_KEY);
  if (!/^[0-9a-f]{64}$/iu.test(key)) {
    throw new ConfigurationError(
      "REFERENCE_TOKEN_KEY must contain 32 random bytes encoded as 64 hexadecimal characters",
    );
  }
  return key;
}

const singleLinePem =
  /^(-----BEGIN [A-Z0-9 ]+-----)\s*([A-Za-z0-9+/=\s]+?)\s*(-----END [A-Z0-9 ]+-----)$/u;

/**
 * Restores PEM line breaks. Accepts the key as downloaded, with line breaks written as
 * "\n" or "\r\n", or flattened onto one line by a form field that dropped the line breaks.
 */
export function normalizePrivateKey(value: string): string {
  const key = value.replace(/(?:\\r)?\\n/gu, "\n");
  const trimmed = key.trim();
  if (trimmed.includes("\n")) return key;

  const [, begin, body, end] = singleLinePem.exec(trimmed) ?? [];
  if (!begin || !body || !end) return key;

  const lines = body.replace(/\s+/gu, "").match(/.{1,64}/gu) ?? [];
  return [begin, ...lines, end, ""].join("\n");
}

const PKCS1_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";
const PKCS1_END = "-----END RSA PRIVATE KEY-----";

// DER bytes that follow the outer SEQUENCE header of an RSA PKCS#8 PrivateKeyInfo:
// version INTEGER 0, then AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }.
const RSA_PKCS8_PREFIX = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub issues App private keys in PKCS#1 form ("BEGIN RSA PRIVATE KEY"). The JWT library that
 * Wrangler bundles for Workers accepts only PKCS#8, so this wraps a PKCS#1 key in a PKCS#8
 * structure. Other keys are returned unchanged.
 */
export function toPkcs8(pem: string): string {
  const begin = pem.indexOf(PKCS1_BEGIN);
  const end = pem.indexOf(PKCS1_END);
  if (begin === -1 || end <= begin) return pem;

  const body = pem.slice(begin + PKCS1_BEGIN.length, end).replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) return pem;

  let pkcs1: Uint8Array;
  try {
    pkcs1 = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  } catch {
    return pem;
  }

  const inner = [...RSA_PKCS8_PREFIX, 0x04, ...derLength(pkcs1.length), ...pkcs1];
  const der = [0x30, ...derLength(inner.length), ...inner];
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/gu) ?? [];
  return ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----", ""].join("\n");
}

export function githubAppConfig(env: WorkerEnv): GitHubAppConfig {
  const privateKey = requireValue("GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY);
  return {
    appId: requireValue("GITHUB_APP_ID", env.GITHUB_APP_ID),
    privateKey: toPkcs8(normalizePrivateKey(privateKey)),
  };
}

export function validateOAuthConfiguration(env: WorkerEnv): void {
  parseAuthorizedLogins(env.AUTHORIZED_GITHUB_LOGINS);
  githubAppConfig(env);
  requireSecret("COOKIE_ENCRYPTION_KEY", env.COOKIE_ENCRYPTION_KEY);
  requireValue("GITHUB_CLIENT_ID", env.GITHUB_CLIENT_ID);
  requireValue("GITHUB_CLIENT_SECRET", env.GITHUB_CLIENT_SECRET);
  referenceTokenKey(env);
}
