/**
 * Typed client for the future /api/v1 server (docs/server-design.md).
 * Nothing in the app calls this yet; the server is not connected.
 */

import type {
  AnonymousAuthRequest,
  ApiError,
  AuthResponse,
  MeResponse,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from "../../shared/contracts";

/** status 0 + code "network" = the request never got an HTTP response (offline, DNS, CORS). */
export class SyncApiError extends Error {
  readonly status: number;
  readonly code: ApiError["error"]["code"] | "network" | "bad_response";
  /** From a Retry-After header, when the server sent one. */
  readonly retryAfterMs?: number;

  constructor(status: number, code: SyncApiError["code"], message: string, retryAfterMs?: number) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface HealthResponse {
  ok: true;
  schemaVersion: number;
  serverTime: number;
}

export interface SyncApi {
  health(): Promise<HealthResponse>;
  anonymousAuth(req: AnonymousAuthRequest): Promise<AuthResponse>;
  push(token: string, req: SyncPushRequest): Promise<SyncPushResponse>;
  pull(token: string, after: string | null, limit?: number): Promise<SyncPullResponse>;
  me(token: string): Promise<MeResponse>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SyncApiOptions {
  /** e.g. "/api/v1" or "https://pubaz.example/api/v1". */
  baseUrl: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
}

export function createSyncApi(options: SyncApiOptions): SyncApi {
  const base = options.baseUrl.replace(/\/+$/, "");
  // Wrapped so the browser's fetch is never called with a foreign `this` ("Illegal invocation").
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(method: "GET" | "POST", path: string, token: string | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new SyncApiError(0, "network", e instanceof Error ? e.message : "network error");
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // handled below
    }
    if (!res.ok) {
      const err = (data as Partial<ApiError> | null)?.error;
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new SyncApiError(
        res.status,
        err && typeof err.code === "string" ? err.code : "bad_response",
        err && typeof err.message === "string" ? err.message : `HTTP ${res.status}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    if (data === null || typeof data !== "object") throw new SyncApiError(res.status, "bad_response", "응답이 JSON이 아니에요.");
    return data as T;
  }

  return {
    health: () => call<HealthResponse>("GET", "health", null),
    anonymousAuth: (req) => call<AuthResponse>("POST", "auth/anonymous", null, req),
    push: (token, req) => call<SyncPushResponse>("POST", "sync/push", token, req),
    pull: (token, after, limit) => {
      const q = new URLSearchParams();
      if (after) q.set("after", after);
      if (limit !== undefined) q.set("limit", String(limit));
      const qs = q.toString();
      return call<SyncPullResponse>("GET", `sync/pull${qs ? `?${qs}` : ""}`, token);
    },
    me: (token) => call<MeResponse>("GET", "me", token),
  };
}
