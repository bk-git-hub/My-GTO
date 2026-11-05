/**
 * Bearer tokens for the /api/v1 server.
 *
 * Format: base64url(JSON {sub, exp, v}) + "." + base64url(HMAC-SHA256(AUTH_SECRET, firstPart))
 * Stateless: the server checks the signature and expiry, then loads the user from the store.
 * Rotating AUTH_SECRET logs everyone out; the app silently re-runs anonymous auth.
 */

export const TOKEN_VERSION = 1;
/** Anonymous tokens live 30 days; the app re-authenticates with its deviceId after that. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Shorter secrets are treated as "not configured" (fail closed). */
export const MIN_SECRET_LENGTH = 32;

export interface TokenPayload {
  /** User id. */
  sub: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Token format version. */
  v: number;
}

export function isUsableSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
  return new Uint8Array(sig);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time byte comparison (length leaks, content does not). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function signToken(sub: string, exp: number, secret: string): Promise<string> {
  const payload: TokenPayload = { sub, exp, v: TOKEN_VERSION };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64UrlEncode(await hmac(secret, body))}`;
}

/** Payload if the token is well-formed, correctly signed, current-version and unexpired; otherwise null. */
export async function verifyToken(token: string, secret: string, now: number): Promise<TokenPayload | null> {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sigText] = parts;
  const sig = base64UrlDecode(sigText);
  if (!sig) return null;
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;

  const raw = base64UrlDecode(body);
  if (!raw) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sub !== "string" || p.sub.length === 0 || p.sub.length > 64) return null;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return null;
  if (p.v !== TOKEN_VERSION) return null;
  if (p.exp <= now) return null;
  return { sub: p.sub, exp: p.exp, v: p.v };
}

/** Token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_.-]+)$/.exec(header.trim());
  return m ? m[1] : null;
}
