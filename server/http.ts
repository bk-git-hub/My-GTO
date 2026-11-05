/**
 * Small HTTP helpers for the /api/v1 server (Web-standard Request/Response only).
 *
 * Imports use explicit `.js` extensions because Vercel runs these files as Node ESM
 * ("type": "module"), where extensionless relative imports fail at runtime.
 */

import type { ApiError } from "../shared/contracts.js";

export type ErrorCode = ApiError["error"]["code"];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  quota_exceeded: 429,
  unavailable: 503,
  internal: 500,
};

/** Thrown inside handlers; the router turns it into an ApiError response. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;

  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** ApiError body (shared/contracts.ts). Status defaults to the code's usual status. */
export function apiError(code: ErrorCode, message: string, status = STATUS_BY_CODE[code], headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status, headers);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

/** 405 with an Allow header. ApiError has no dedicated code, so it uses bad_request. */
export function methodNotAllowed(allowed: string[]): HttpError {
  return new HttpError(405, "bad_request", "허용되지 않은 메서드예요.", { allow: allowed.join(", ") });
}

/**
 * Reads a JSON body with a hard byte limit (checked while streaming, not only via
 * content-length) and requires `content-type: application/json`. The content-type
 * rule also means a cross-origin page cannot send it without a CORS preflight.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "bad_request", "content-type은 application/json이어야 해요.");
  }
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) throw badRequest("요청 본문이 비어 있어요.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badRequest("요청 본문이 올바른 UTF-8이 아니에요.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("요청 본문이 올바른 JSON이 아니에요.");
  }
}

function tooLarge(): HttpError {
  return new HttpError(413, "bad_request", "요청 본문이 너무 커요.");
}

// ───────────────────────── CORS ─────────────────────────

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^/\s]+$/.test(s));
}

export type CorsDecision =
  /** No Origin header, or same origin: no CORS headers needed. */
  | { kind: "same-origin" }
  /** Allowed cross-origin caller: add these headers to the response. */
  | { kind: "allowed"; headers: Record<string, string> }
  /** Cross-origin caller not on the allowlist. */
  | { kind: "denied" };

/** Same-origin by default; other origins only via the ALLOWED_ORIGINS allowlist. */
export function corsDecision(request: Request, allowedOrigins: string[]): CorsDecision {
  const origin = request.headers.get("origin");
  if (!origin) return { kind: "same-origin" };
  if (origin === new URL(request.url).origin) return { kind: "same-origin" };
  if (!allowedOrigins.includes(origin)) return { kind: "denied" };
  return {
    kind: "allowed",
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  };
}

/** Copies a response with extra headers (CORS) added. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const keys = Object.keys(headers);
  if (keys.length === 0) return response;
  const out = new Headers(response.headers);
  for (const k of keys) out.set(k, headers[k]);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
