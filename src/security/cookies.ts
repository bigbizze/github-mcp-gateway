const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** HMAC-SHA256 of `value`. `purpose` separates signatures made for different uses of one secret. */
export async function sign(purpose: string, value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\0${value}`))));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Returns `value.signature` for a cookie. */
export async function signedValue(purpose: string, value: string, secret: string): Promise<string> {
  return `${value}.${await sign(purpose, value, secret)}`;
}

/** Returns the value of a `value.signature` string if the signature is valid. */
export async function verifySignedValue(purpose: string, signed: string | undefined, secret: string): Promise<string | undefined> {
  const separator = signed?.lastIndexOf(".") ?? -1;
  if (!signed || separator <= 0) return undefined;
  const value = signed.slice(0, separator);
  return constantTimeEqual(signed.slice(separator + 1), await sign(purpose, value, secret)) ? value : undefined;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const cookie of request.headers.get("Cookie")?.split(";") ?? []) {
    const [cookieName, ...value] = cookie.trim().split("=");
    if (cookieName === name) return value.join("=");
  }
  return undefined;
}

/** A `__Host-` cookie: HTTPS only, host-only, path `/`, and not readable by scripts. */
export function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
