import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, type AuthResponse, type MeResponse, type SyncPullResponse, type SyncPushResponse } from "../../shared/contracts";
import { newId } from "../../shared/ids";
import { signToken } from "../../server/auth";
import { COACH_DAILY_LIMIT_FREE, COACH_DAILY_LIMIT_PRO, consumeCoachQuota, kstDateKey, nextKstMidnight } from "../../server/quota";
import { handleApi, type ApiDeps } from "../../server/router";
import { MemoryStore } from "../../server/store.memory";
import { DEVICE, NOW, SECRET, makeAttempt } from "./helpers";

const ORIGIN = "https://pubaz.vercel.app";
let store: MemoryStore;
let deps: ApiDeps;

function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return handleApi(new Request(`${ORIGIN}${path}`, { ...init, headers, body }), deps);
}

async function login(deviceId = DEVICE): Promise<AuthResponse> {
  const res = await call("/api/v1?path=auth/anonymous", { method: "POST", json: { deviceId } });
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  store = new MemoryStore();
  deps = { store, env: { AUTH_SECRET: SECRET }, now: () => NOW };
});

describe("/api/v1 router", () => {
  it("answers health without auth, from the rewrite param or the pathname", async () => {
    for (const path of ["/api/v1?path=health", "/api/v1/health"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, schemaVersion: 1, serverTime: NOW });
    }
  });

  it("is unavailable without a usable AUTH_SECRET", async () => {
    deps.env = { AUTH_SECRET: "short" };
    const res = await call("/api/v1?path=health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: "서버 준비 중" } });
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const r404 = await call("/api/v1?path=admin/users");
    expect(r404.status).toBe(404);
    expect((await r404.json()).error.code).toBe("not_found");
    expect((await call("/api/v1?path=constructor")).status).toBe(404);
    const r405 = await call("/api/v1?path=sync/push");
    expect(r405.status).toBe(405);
    expect(r405.headers.get("allow")).toBe("POST");
    expect((await call("/api/v1?path=me", { method: "POST" })).status).toBe(405);
  });

  it("returns 401 for missing, invalid, expired or unknown-user tokens", async () => {
    expect((await call("/api/v1?path=me")).status).toBe(401);
    expect((await call("/api/v1?path=me", { token: "abc.def" })).status).toBe(401);
    const { userId } = await login();
    const expired = await signToken(userId, NOW - 1, SECRET);
    expect((await call("/api/v1?path=me", { token: expired })).status).toBe(401);
    const ghost = await signToken(newId(NOW), NOW + 60_000, SECRET);
    const res = await call("/api/v1?path=sync/pull", { token: ghost });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("anonymous auth is stable per device and validates the deviceId", async () => {
    const a = await login();
    const b = await login();
    expect(b.userId).toBe(a.userId);
    expect(a.expiresAt).toBeGreaterThan(NOW);
    const other = await login(newId(NOW));
    expect(other.userId).not.toBe(a.userId);
    expect((await call("/api/v1?path=auth/anonymous", { method: "POST", json: { deviceId: "x" } })).status).toBe(400);
    expect((await call("/api/v1?path=auth/anonymous", { method: "POST", body: "{}" })).status).toBe(415);
    expect(
      (await call("/api/v1?path=auth/anonymous", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" })).status,
    ).toBe(400);
  });

  it("push is idempotent: the same batch twice gives duplicates", async () => {
    const { token } = await login();
    const batch = [makeAttempt(), makeAttempt(), makeAttempt()];
    const first: SyncPushResponse = await (await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: batch } })).json();
    expect(first.accepted.sort()).toEqual(batch.map((a) => a.id).sort());
    expect(first.duplicates).toEqual([]);
    expect(first.serverTime).toBe(NOW);
    const second: SyncPushResponse = await (await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: batch } })).json();
    expect(second.accepted).toEqual([]);
    expect(second.duplicates.sort()).toEqual(batch.map((a) => a.id).sort());
  });

  it("push handles a mixed valid/invalid batch and in-batch repeats", async () => {
    const { token } = await login();
    const good = makeAttempt();
    const bad = { ...makeAttempt(), grade: "great" };
    const res = await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: [good, bad, good, 42] } });
    expect(res.status).toBe(200);
    const body: SyncPushResponse = await res.json();
    expect(body.accepted).toEqual([good.id]);
    expect(body.duplicates).toEqual([good.id]);
    expect(body.rejected).toEqual([
      { id: bad.id, reason: "bad_grade" },
      { id: "", reason: "not_object" },
    ]);
  });

  it("push rejects oversized batches and bad bodies with 400", async () => {
    const { token } = await login();
    const tooMany = Array.from({ length: LIMITS.pushBatch + 1 }, () => makeAttempt());
    const res = await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: tooMany } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect((await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: "x" } })).status).toBe(400);
    expect((await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: [] } })).status).toBe(200);
    const huge = await call("/api/v1?path=sync/push", { method: "POST", token, json: { pad: "x".repeat(3_000_000) } });
    expect(huge.status).toBe(413);
  });

  it("pull pages by cursor and isolates users", async () => {
    const { token } = await login();
    const all = Array.from({ length: 5 }, () => makeAttempt());
    await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: all } });

    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q: string = after ? `&after=${after}` : "";
      const page: SyncPullResponse = await (await call(`/api/v1?path=sync/pull&limit=2${q}`, { token })).json();
      if (page.cursor === null) {
        expect(page.attempts).toEqual([]);
        break;
      }
      expect(page.attempts.length).toBeLessThanOrEqual(2);
      seen.push(...page.attempts.map((a) => a.id));
      after = page.cursor;
    }
    expect(seen).toEqual(all.map((a) => a.id));

    // A late upload with an *older* id still shows up after the saved cursor.
    const late = makeAttempt({ id: newId(NOW - 86_400_000), at: NOW - 86_400_000 });
    await call("/api/v1?path=sync/push", { method: "POST", token, json: { attempts: [late] } });
    const next: SyncPullResponse = await (await call(`/api/v1?path=sync/pull&after=${after}`, { token })).json();
    expect(next.attempts.map((a) => a.id)).toEqual([late.id]);

    const other = await login(newId(NOW));
    const empty: SyncPullResponse = await (await call("/api/v1?path=sync/pull", { token: other.token })).json();
    expect(empty).toEqual({ attempts: [], cursor: null });

    expect((await call("/api/v1?path=sync/pull&after=abc", { token })).status).toBe(400);
    expect((await call("/api/v1?path=sync/pull&limit=0", { token })).status).toBe(400);
    expect((await call("/api/v1?path=sync/pull&limit=99999", { token })).status).toBe(200);
  });

  it("/me reports plan and coach quota for the KST day", async () => {
    const { token, userId } = await login();
    let me: MeResponse = await (await call("/api/v1?path=me", { token })).json();
    expect(me).toEqual({ userId, plan: "free", coach: { used: 0, limit: COACH_DAILY_LIMIT_FREE, resetsAt: nextKstMidnight(NOW) } });
    expect(new Date(me.coach.resetsAt).toISOString()).toBe("2026-11-05T15:00:00.000Z"); // 2026-11-06 00:00 KST

    await consumeCoachQuota(store, userId, "free", NOW);
    await consumeCoachQuota(store, userId, "free", NOW);
    me = await (await call("/api/v1?path=me", { token })).json();
    expect(me.coach.used).toBe(2);

    store.grantPro(userId, NOW + 1000);
    me = await (await call("/api/v1?path=me", { token })).json();
    expect(me.plan).toBe("pro");
    expect(me.coach.limit).toBe(COACH_DAILY_LIMIT_PRO);
    store.grantPro(userId, NOW - 1);
    me = await (await call("/api/v1?path=me", { token })).json();
    expect(me.plan).toBe("free");
  });

  it("CORS: same origin by default, allowlist for others", async () => {
    const denied = await call("/api/v1?path=health", { headers: { origin: "https://evil.example" } });
    expect(denied.status).toBe(403);
    expect((await call("/api/v1?path=health", { headers: { origin: ORIGIN } })).status).toBe(200);

    deps.env = { AUTH_SECRET: SECRET, ALLOWED_ORIGINS: "https://app.pubaz.kr, capacitor://bad" };
    const pre = await call("/api/v1?path=sync/push", { method: "OPTIONS", headers: { origin: "https://app.pubaz.kr" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.pubaz.kr");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const ok = await call("/api/v1?path=health", { headers: { origin: "https://app.pubaz.kr" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.pubaz.kr");
  });
});

describe("coach quota", () => {
  it("uses the KST date as the period and stops at the limit", async () => {
    expect(kstDateKey(Date.UTC(2026, 10, 5, 14, 59))).toBe("2026-11-05");
    expect(kstDateKey(Date.UTC(2026, 10, 5, 15, 0))).toBe("2026-11-06");
    const s = new MemoryStore();
    for (let i = 1; i <= COACH_DAILY_LIMIT_FREE; i++) {
      const r = await consumeCoachQuota(s, "U", "free", NOW);
      expect(r).toMatchObject({ ok: true, quota: { used: i, limit: COACH_DAILY_LIMIT_FREE } });
    }
    expect((await consumeCoachQuota(s, "U", "free", NOW)).ok).toBe(false);
    // Next KST day starts fresh.
    expect((await consumeCoachQuota(s, "U", "free", nextKstMidnight(NOW))).quota.used).toBe(1);
  });
});
