/**
 * Vercel Function: PubAZ account/sync API (/api/v1/*). NOT CONNECTED YET.
 *
 * Fails closed: every request gets 503 {error:{code:"unavailable"}} unless the server is
 * explicitly configured. Today the only runnable mode is the dev-only in-memory store:
 *
 *   SERVER_MODE=memory   per-instance MemoryStore, data is lost on cold start (DEV ONLY,
 *                        refused when VERCEL_ENV=production)
 *   AUTH_SECRET          token signing secret, 32+ chars (e.g. `openssl rand -base64 48`)
 *   ALLOWED_ORIGINS      optional comma-separated extra origins
 *
 * SERVER_MODE=postgres (DATABASE_URL) is designed but not wired: no driver is installed yet.
 * See docs/server-design.md. vercel.json rewrites /api/v1/<path> to /api/v1?path=<path>.
 */

import { isUsableSecret } from "../server/auth.js";
import { apiError } from "../server/http.js";
import { handleApi } from "../server/router.js";
import { MemoryStore } from "../server/store.memory.js";

declare const process: { env: Record<string, string | undefined> };

export interface V1Env {
  SERVER_MODE?: string;
  AUTH_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  VERCEL_ENV?: string;
  DATABASE_URL?: string;
}

let memoryStore: MemoryStore | null = null;

export function handleV1(request: Request, env: V1Env, now: () => number = Date.now): Promise<Response> | Response {
  const devMemory = env.SERVER_MODE === "memory" && env.VERCEL_ENV !== "production";
  if (!devMemory || !isUsableSecret(env.AUTH_SECRET)) return apiError("unavailable", "서버 준비 중");
  memoryStore ??= new MemoryStore();
  return handleApi(request, { store: memoryStore, env, now });
}

export default {
  fetch(request: Request) {
    return handleV1(request, process.env);
  },
};
