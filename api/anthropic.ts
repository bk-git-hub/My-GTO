/**
 * Vercel Function: relays the app's Claude API calls using a server-side key.
 *
 * Env vars (Vercel → Project → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY  Claude API key (mark as Sensitive)
 *   APP_PASSCODE       optional; when set, the app must send it in `x-app-passcode`.
 *                      Without it anyone who knows the URL can spend the key's credits.
 *
 * vercel.json rewrites /api/anthropic/<path> to /api/anthropic?path=<path>,
 * so the SDK can use `${origin}/api/anthropic` as its base URL.
 * Only the two endpoints the app needs are allowed, and only the app's models.
 */

declare const process: { env: Record<string, string | undefined> };

export interface ProxyEnv {
  ANTHROPIC_API_KEY?: string;
  APP_PASSCODE?: string;
}

const UPSTREAM = "https://api.anthropic.com";
const ALLOWED_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];
const RESPONSE_HEADERS = ["content-type", "request-id", "retry-after"];

function proxyError(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: "proxy_error", message } }, { status });
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Upstream path from the rewrite's `path` param (or the raw pathname), if allowed. */
export function upstreamPath(url: URL): string | null {
  const raw = url.searchParams.get("path") ?? url.pathname.replace(/^\/api\/anthropic\/?/, "");
  const path = raw.replace(/^\/+/, "");
  if (path === "v1/messages") return path;
  if (/^v1\/models\/[a-z0-9.-]+$/.test(path)) return path;
  return null;
}

export async function handleAnthropicProxy(
  request: Request,
  env: ProxyEnv,
  upstreamFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return proxyError(503, "서버에 ANTHROPIC_API_KEY 환경 변수가 없어요. Vercel에 등록한 뒤 다시 배포해 주세요.");
  }
  if (env.APP_PASSCODE && !safeEqual(request.headers.get("x-app-passcode") ?? "", env.APP_PASSCODE)) {
    return proxyError(401, "접속 비밀번호가 올바르지 않아요. 설정에서 확인해 주세요.");
  }

  const url = new URL(request.url);
  const path = upstreamPath(url);
  if (!path) return proxyError(404, "허용되지 않은 경로예요.");
  const isMessages = path === "v1/messages";
  if (request.method !== (isMessages ? "POST" : "GET")) return proxyError(405, "허용되지 않은 메서드예요.");

  let body: string | undefined;
  if (isMessages) {
    body = await request.text();
    let model: unknown;
    try {
      model = JSON.parse(body).model;
    } catch {
      return proxyError(400, "요청 본문이 올바른 JSON이 아니에요.");
    }
    if (typeof model !== "string" || !ALLOWED_MODELS.has(model)) {
      return proxyError(400, `이 서버에서 허용하지 않는 모델이에요: ${String(model)}`);
    }
  }

  const headers = new Headers();
  for (const h of REQUEST_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("x-api-key", env.ANTHROPIC_API_KEY);

  // Keep other query params (the SDK adds ?beta=true for beta endpoints).
  const query = new URLSearchParams(url.searchParams);
  query.delete("path");
  const qs = query.toString();

  const upstream = await upstreamFetch(`${UPSTREAM}/${path}${qs ? `?${qs}` : ""}`, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });

  const out = new Headers({ "cache-control": "no-store" });
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  // Stream the body straight through (SSE for messages).
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  fetch(request: Request) {
    return handleAnthropicProxy(request, process.env);
  },
};
