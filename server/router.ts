/**
 * /api/v1 router. Pure function of (request, deps) so tests can inject the store and clock.
 *
 *   GET  /api/v1/health          no auth
 *   POST /api/v1/auth/anonymous  no auth   { deviceId } -> AuthResponse
 *   POST /api/v1/sync/push       bearer    SyncPushRequest -> SyncPushResponse
 *   GET  /api/v1/sync/pull       bearer    ?after=&limit= -> SyncPullResponse
 *   GET  /api/v1/me              bearer    MeResponse
 *
 * The path comes from the `path` query param (vercel.json rewrite) or the raw pathname.
 */

import {
  LIMITS,
  SCHEMA_VERSION,
  type AnonymousAuthRequest,
  type Attempt,
  type AuthResponse,
  type MeResponse,
  type SyncPullResponse,
  type SyncPushResponse,
} from "../shared/contracts.js";
import { isId, newId } from "../shared/ids.js";
import { TOKEN_TTL_MS, bearerToken, isUsableSecret, signToken, verifyToken } from "./auth.js";
import { HttpError, apiError, badRequest, corsDecision, json, methodNotAllowed, parseAllowedOrigins, readJsonBody, withHeaders } from "./http.js";
import { getCoachQuota } from "./quota.js";
import { isCursor, type Store } from "./store.js";
import { validateAttempt } from "./validate.js";

export interface ServerEnv {
  /** HMAC secret for bearer tokens, at least 32 chars. Without it the API answers 503. */
  AUTH_SECRET?: string;
  /** Comma-separated extra origins allowed to call the API (same origin is always allowed). */
  ALLOWED_ORIGINS?: string;
}

export interface ApiDeps {
  store: Store;
  env: ServerEnv;
  now: () => number;
}

/** Max request body sizes. A full push batch with maximal strings stays under ~2 MB. */
export const MAX_PUSH_BODY_BYTES = 2_500_000;
export const MAX_SMALL_BODY_BYTES = 4_096;

interface Context {
  request: Request;
  url: URL;
  deps: ApiDeps;
  secret: string;
  now: number;
}

interface AuthedContext extends Context {
  userId: string;
}

type Route =
  | { method: "GET" | "POST"; auth: false; handle: (ctx: Context) => Promise<Response> }
  | { method: "GET" | "POST"; auth: true; handle: (ctx: AuthedContext) => Promise<Response> };

const ROUTES: Record<string, Route> = {
  health: { method: "GET", auth: false, handle: health },
  "auth/anonymous": { method: "POST", auth: false, handle: anonymousAuth },
  "sync/push": { method: "POST", auth: true, handle: syncPush },
  "sync/pull": { method: "GET", auth: true, handle: syncPull },
  me: { method: "GET", auth: true, handle: me },
};

export function routePath(url: URL): string {
  const raw = url.searchParams.get("path") ?? url.pathname.replace(/^\/api\/v1\/?/, "");
  return raw.replace(/^\/+|\/+$/g, "");
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const cors = corsDecision(request, parseAllowedOrigins(deps.env.ALLOWED_ORIGINS));
  if (cors.kind === "denied") return apiError("forbidden", "허용되지 않은 출처예요.");
  const corsHeaders = cors.kind === "allowed" ? cors.headers : {};
  if (request.method === "OPTIONS") return withHeaders(new Response(null, { status: 204 }), corsHeaders);
  return withHeaders(await route(request, deps), corsHeaders);
}

async function route(request: Request, deps: ApiDeps): Promise<Response> {
  const secret = deps.env.AUTH_SECRET;
  if (!isUsableSecret(secret)) return apiError("unavailable", "서버 준비 중");

  const url = new URL(request.url);
  const path = routePath(url);
  if (!Object.hasOwn(ROUTES, path)) return apiError("not_found", "없는 API 경로예요.");
  const r = ROUTES[path];
  try {
    if (request.method !== r.method) throw methodNotAllowed([r.method]);
    const ctx: Context = { request, url, deps, secret, now: deps.now() };
    if (!r.auth) return await r.handle(ctx);
    return await r.handle({ ...ctx, userId: await authenticate(ctx) });
  } catch (e) {
    if (e instanceof HttpError) return apiError(e.code, e.message, e.status, e.headers);
    // Never leak internals (SQL errors, stack traces) to the client.
    console.error("api/v1 internal error", e);
    return apiError("internal", "서버 오류가 났어요. 잠시 후 다시 시도해 주세요.");
  }
}

async function authenticate(ctx: Context): Promise<string> {
  const token = bearerToken(ctx.request);
  if (!token) throw new HttpError(401, "unauthorized", "로그인이 필요해요.");
  const payload = await verifyToken(token, ctx.secret, ctx.now);
  if (!payload) throw new HttpError(401, "unauthorized", "인증 토큰이 올바르지 않거나 만료됐어요.");
  const user = await ctx.deps.store.getUser(payload.sub);
  if (!user) throw new HttpError(401, "unauthorized", "계정을 찾을 수 없어요.");
  return user.id;
}

async function health(ctx: Context): Promise<Response> {
  return json({ ok: true, schemaVersion: SCHEMA_VERSION, serverTime: ctx.now });
}

async function anonymousAuth(ctx: Context): Promise<Response> {
  const body = (await readJsonBody(ctx.request, MAX_SMALL_BODY_BYTES)) as Partial<AnonymousAuthRequest> | null;
  const deviceId = body && typeof body === "object" ? body.deviceId : undefined;
  if (!isId(deviceId)) throw badRequest("deviceId가 올바르지 않아요.");
  const user = await ctx.deps.store.getOrCreateUserForDevice(deviceId, newId(ctx.now), ctx.now);
  const expiresAt = ctx.now + TOKEN_TTL_MS;
  const res: AuthResponse = { userId: user.id, token: await signToken(user.id, expiresAt, ctx.secret), expiresAt };
  return json(res);
}

async function syncPush(ctx: AuthedContext): Promise<Response> {
  const body = await readJsonBody(ctx.request, MAX_PUSH_BODY_BYTES);
  const list = body && typeof body === "object" ? (body as { attempts?: unknown }).attempts : undefined;
  if (!Array.isArray(list)) throw badRequest("attempts 배열이 필요해요.");
  if (list.length > LIMITS.pushBatch) throw badRequest(`한 번에 최대 ${LIMITS.pushBatch}개까지 보낼 수 있어요.`);

  const valid: Attempt[] = [];
  const seen = new Set<string>();
  const inBatchDuplicates: string[] = [];
  const rejected: SyncPushResponse["rejected"] = [];
  for (const item of list) {
    const result = validateAttempt(item, ctx.now);
    if (!result.ok) {
      const rawId = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      rejected.push({ id: typeof rawId === "string" ? rawId.slice(0, 64) : "", reason: result.reason });
      continue;
    }
    if (seen.has(result.attempt.id)) {
      inBatchDuplicates.push(result.attempt.id);
      continue;
    }
    seen.add(result.attempt.id);
    valid.push(result.attempt);
  }

  const { accepted, duplicates } = await ctx.deps.store.insertAttempts(ctx.userId, valid, ctx.now);
  const res: SyncPushResponse = { accepted, duplicates: [...duplicates, ...inBatchDuplicates], rejected, serverTime: ctx.now };
  return json(res);
}

async function syncPull(ctx: AuthedContext): Promise<Response> {
  const after = ctx.url.searchParams.get("after");
  if (after !== null && after !== "" && !isCursor(after)) throw badRequest("after 커서가 올바르지 않아요.");
  const rawLimit = ctx.url.searchParams.get("limit");
  let limit: number = LIMITS.pullPage;
  if (rawLimit !== null) {
    if (!/^[0-9]{1,6}$/.test(rawLimit) || Number(rawLimit) < 1) throw badRequest("limit이 올바르지 않아요.");
    limit = Math.min(Number(rawLimit), LIMITS.pullPage);
  }
  const page = await ctx.deps.store.listAttempts(ctx.userId, after || null, limit);
  const res: SyncPullResponse = { attempts: page.attempts, cursor: page.cursor };
  return json(res);
}

async function me(ctx: AuthedContext): Promise<Response> {
  const plan = await ctx.deps.store.getPlan(ctx.userId, ctx.now);
  const res: MeResponse = { userId: ctx.userId, plan, coach: await getCoachQuota(ctx.deps.store, ctx.userId, plan, ctx.now) };
  return json(res);
}
