import { describe, expect, it, vi } from "vitest";
import { LIMITS, type Attempt, type AttemptOutbox } from "../../shared/contracts";
import { newId } from "../../shared/ids";
import { handleApi, type ApiDeps } from "../../server/router";
import { MemoryStore } from "../../server/store.memory";
import { createSyncApi, SyncApiError, type FetchLike } from "../../src/sync/api";
import { isRetryable, nextBackoffMs, pullAll, syncOnce } from "../../src/sync/engine";
import { DEVICE, NOW, SECRET, makeAttempt } from "./helpers";

/** Outbox over an array, like src/state's attempt log. */
function memoryOutbox(attempts: Attempt[]) {
  const synced = new Map<string, number>();
  const rejected = new Set<string>();
  const outbox: AttemptOutbox = {
    unsynced: (limit) => attempts.filter((a) => !synced.has(a.id) && !rejected.has(a.id)).slice(0, limit),
    markSynced: (ids, at) => ids.forEach((id) => synced.set(id, at)),
    markRejected: (ids) => ids.forEach((id) => rejected.add(id)),
  };
  return { outbox, synced, rejected };
}

/** fetch that calls handleApi in-process (no network). */
function inProcess(deps: ApiDeps): FetchLike {
  return async (input, init) => handleApi(new Request(new URL(input, "https://pubaz.vercel.app"), init), deps);
}

function setup() {
  const deps: ApiDeps = { store: new MemoryStore(), env: { AUTH_SECRET: SECRET }, now: () => NOW };
  const api = createSyncApi({ baseUrl: "/api/v1/", fetch: inProcess(deps) });
  let token: string | null = null;
  const getToken = vi.fn(async (refresh: boolean) => {
    if (!token || refresh) token = (await api.anonymousAuth({ deviceId: DEVICE })).token;
    return token;
  });
  return { deps, api, getToken };
}

describe("sync engine", () => {
  it("pushes the outbox in batches end-to-end and pulls it back", async () => {
    const { api, getToken } = setup();
    const attempts = Array.from({ length: LIMITS.pushBatch * 2 + 5 }, () => makeAttempt());
    const bad = { ...makeAttempt(), kind: "river" } as unknown as Attempt;
    attempts.push(bad);
    const { outbox, synced, rejected } = memoryOutbox(attempts);

    const summary = await syncOnce({ api, outbox, getToken, now: () => NOW + 5 });
    expect(summary).toEqual({ pushed: LIMITS.pushBatch * 2 + 5, duplicates: 0, rejected: 1, batches: 3 });
    expect(synced.size).toBe(LIMITS.pushBatch * 2 + 5);
    expect(synced.get(attempts[0].id)).toBe(NOW + 5);
    expect([...rejected]).toEqual([bad.id]);
    expect(outbox.unsynced(10)).toEqual([]);
    expect(getToken).toHaveBeenCalledTimes(1);

    // Nothing left: a second run is a no-op.
    expect(await syncOnce({ api, outbox, getToken, now: () => NOW })).toEqual({ pushed: 0, duplicates: 0, rejected: 0, batches: 0 });

    // A fresh outbox with the same records (e.g. reinstall + restore) only gets duplicates.
    const again = memoryOutbox(attempts.slice(0, 3));
    expect(await syncOnce({ api, outbox: again.outbox, getToken, now: () => NOW })).toMatchObject({ pushed: 0, duplicates: 3 });

    const pages: string[] = [];
    const pulled = await pullAll({ api, getToken, after: null, onPage: (_a, cursor) => void pages.push(cursor) });
    expect(pulled.error).toBeUndefined();
    expect(pulled.pulled).toBe(LIMITS.pushBatch * 2 + 5);
    expect(pages.length).toBe(1);
    expect(pulled.cursor).toBe(pages[0]);
  });

  it("re-authenticates once on 401", async () => {
    const { api, getToken, deps } = setup();
    const { outbox } = memoryOutbox([makeAttempt()]);
    await getToken(false);
    deps.env = { AUTH_SECRET: SECRET.replace("test", "rot8") }; // secret rotated: old token is invalid
    const summary = await syncOnce({ api, outbox, getToken, now: () => NOW });
    expect(summary).toMatchObject({ pushed: 1, batches: 1 });
    expect(getToken).toHaveBeenLastCalledWith(true);
  });

  it("stops on network and server errors, keeping the outbox", async () => {
    const offline = createSyncApi({ baseUrl: "/api/v1", fetch: async () => { throw new TypeError("Failed to fetch"); } });
    const { outbox } = memoryOutbox([makeAttempt()]);
    const s1 = await syncOnce({ api: offline, outbox, getToken: async () => "t", now: () => NOW });
    expect(s1.error).toMatchObject({ status: 0, code: "network" });
    expect(outbox.unsynced(10)).toHaveLength(1);
    expect(isRetryable(s1.error!)).toBe(true);

    const down = createSyncApi({
      baseUrl: "/api/v1",
      fetch: async () => Response.json({ error: { code: "unavailable", message: "서버 준비 중" } }, { status: 503, headers: { "retry-after": "120" } }),
    });
    const s2 = await syncOnce({ api: down, outbox, getToken: async () => "t", now: () => NOW });
    expect(s2.error).toMatchObject({ status: 503, code: "unavailable", retryAfterMs: 120_000 });
    expect(outbox.unsynced(10)).toHaveLength(1);
    expect(nextBackoffMs(1, s2.error, { random: () => 0 })).toBe(120_000);
  });

  it("stops when the server settles nothing instead of looping", async () => {
    const weird = createSyncApi({
      baseUrl: "/api/v1",
      fetch: async () => Response.json({ accepted: [newId(NOW)], duplicates: [], rejected: [], serverTime: NOW }),
    });
    const { outbox, synced } = memoryOutbox([makeAttempt()]);
    const s = await syncOnce({ api: weird, outbox, getToken: async () => "t", now: () => NOW });
    expect(s.error?.code).toBe("no_progress");
    expect(s.batches).toBe(1);
    expect(synced.size).toBe(0);
  });

  it("backoff grows exponentially with jitter and caps", () => {
    expect(nextBackoffMs(0)).toBe(0);
    expect(nextBackoffMs(1, undefined, { random: () => 1 })).toBe(5_000);
    expect(nextBackoffMs(3, undefined, { random: () => 1 })).toBe(20_000);
    expect(nextBackoffMs(3, undefined, { random: () => 0 })).toBe(10_000);
    expect(nextBackoffMs(50, undefined, { random: () => 1 })).toBe(15 * 60_000);
    expect(isRetryable({ status: 400, code: "bad_request", message: "" })).toBe(false);
    expect(isRetryable({ status: 429, code: "rate_limited", message: "" })).toBe(true);
  });

  it("api client surfaces ApiError bodies", async () => {
    const api = createSyncApi({ baseUrl: "https://x/api/v1", fetch: async () => Response.json({ error: { code: "forbidden", message: "no" } }, { status: 403 }) });
    await expect(api.me("t")).rejects.toMatchObject({ status: 403, code: "forbidden", message: "no" });
    await expect(api.me("t")).rejects.toBeInstanceOf(SyncApiError);
  });
});
