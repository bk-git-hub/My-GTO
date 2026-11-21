import { beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticCatalog, buildSyntheticPacks, type SyntheticCatalog, type SyntheticPacks } from "../../../tests/fixtures/solverPack";
import { cdnUrls } from "../../presolve/format";
import { askPersist, openPackCache, PACK_CACHE_NAME, type PackCache } from "./packCache";
import { createPackClient, LEGACY_PACKS, packsMirror } from "./packs";

/** An in-memory CacheStorage with the parts packCache.ts uses (insertion-ordered keys, like the real one). */
function fakeCaches() {
  const buckets = new Map<string, Map<string, ArrayBuffer>>();
  const bucket = (name: string) => buckets.get(name) ?? buckets.set(name, new Map()).get(name)!;
  const caches = {
    async open(name: string) {
      const b = bucket(name);
      return {
        async match(key: string) {
          const v = b.get(String(key));
          return v ? new Response(v.slice(0)) : undefined;
        },
        async put(key: string, res: Response) {
          b.delete(String(key));
          b.set(String(key), await res.arrayBuffer());
        },
        async keys() {
          return [...b.keys()].map((url) => ({ url }) as Request);
        },
        async delete(req: Request | string) {
          return b.delete(typeof req === "string" ? req : req.url);
        },
      } as unknown as Cache;
    },
  } as unknown as CacheStorage;
  return { caches, buckets };
}

const enc = new TextEncoder();
const body = (text: string) => enc.encode(text).buffer as ArrayBuffer;
const ok = (text: string) => Promise.resolve(new Response(body(text), { status: 200, headers: { "content-type": "application/json" } }));
const status = (code: number) => Promise.resolve(new Response("nope", { status: code }));

interface Net {
  urls: string[];
  /** Per host: "ok", "down" (network error), "500", "html" or "bad" (other bytes). */
  hosts: Record<string, "ok" | "down" | "500" | "html" | "bad">;
  dataJson: "ok" | "404" | "down";
  /** The bundled v1 manifest is still deployed (false: after R2). */
  bundled: boolean;
  fetch: typeof fetch;
}

let packs: SyntheticPacks;
let data: SyntheticCatalog;
const LEGACY_ID = "srp-btn-bb-100"; // one of the synthetic packs is a legacy id: it falls back to its bundled copy

beforeAll(async () => {
  packs = await buildSyntheticPacks();
  data = await buildSyntheticCatalog(packs, {
    spots: { "pub-srp-btn-bb-40": { chart: "solver", stage: "55bb-2.2", stack: 55, pot: "srp", raiser: "BTN", caller: "BB" } },
    planned: [{ id: "sv-srp-hj-bb-55", title: "HJ 오픈 vs BB 콜 · 55bb", pot: 5.9, stack: 51.8 }],
  });
});

/** A network serving data.json on our origin, the data branch on both CDNs and the bundled v1 packs under /p/. */
function net(over: Partial<Pick<Net, "hosts" | "dataJson" | "bundled">> = {}): Net {
  const n: Net = { urls: [], hosts: { "cdn.jsdelivr.net": "ok", "raw.githubusercontent.com": "ok", ...over.hosts }, dataJson: over.dataJson ?? "ok", bundled: over.bundled ?? true, fetch: null! };
  const branch = new Map<string, string>();
  for (const [path, text] of data.files) for (const url of cdnUrls(data.pointer, path)) branch.set(url, text);
  const bundled = new Map(packs.files.map((f) => [`/p/${f.path}`, f.json]));
  n.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    n.urls.push(url);
    if (url === "/p/data.json") return n.dataJson === "ok" ? ok(JSON.stringify(data.pointer)) : n.dataJson === "404" ? status(404) : Promise.reject(new TypeError("offline"));
    if (url === "/p/manifest.json") return n.bundled ? ok(JSON.stringify(packs.manifest)) : status(404);
    if (url.startsWith("/p/")) return n.bundled && bundled.has(url) ? ok(bundled.get(url)!) : status(404);
    const host = new URL(url).host;
    const mode = n.hosts[host] ?? "down";
    if (mode === "down") return Promise.reject(new TypeError("failed to fetch"));
    if (mode === "500") return status(500);
    if (mode === "html") return ok("<!doctype html><title>x</title>");
    const text = branch.get(url);
    if (text === undefined) return status(404);
    return mode === "bad" ? ok(text.replace(/"/, ' "')) : ok(text);
  }) as typeof fetch;
  return n;
}

const client = (n: Net, cache: PackCache | null = null) => createPackClient({ base: "/p/", fetch: n.fetch, cache, warn: () => {}, timeoutMs: 2000 });
const cdn = (n: Net) => n.urls.filter((u) => u.startsWith("https://"));

describe("pack client, data branch", () => {
  it("reads data.json, then the catalog, a pack's index and a flop from jsDelivr pinned to the commit", async () => {
    const n = net();
    const c = client(n);
    const state = await c.catalog();
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.source).toBe("data");
    expect(state.offline).toBe(false);
    expect(state.catalog.packs.map((p) => p.id)).toEqual(packs.manifest.packs.map((p) => p.id));
    expect(state.catalog.planned?.map((p) => p.id)).toEqual(["sv-srp-hj-bb-55"]);
    expect(state.catalog.packs[1].spot?.chart).toBe("solver");
    const pack = await c.pack("pub-srp-btn-bb-40");
    expect(pack).toEqual(packs.manifest.packs[1]);
    const lf = await c.flop(pack.files[0]);
    expect(lf.flop.boardKey).toBe(pack.files[0].board);
    expect(await lf.integrity).toBe("ok");
    // Pinned to the full commit, never a branch or short SHA; nothing from the bundled copy.
    expect(cdn(n).every((u) => u.startsWith(`https://cdn.jsdelivr.net/gh/bk-git-hub/My-GTO@${data.pointer.commit}/packs/`))).toBe(true);
    expect(cdn(n)).toHaveLength(3); // catalog, index, flop
    expect(n.urls.filter((u) => u.startsWith("/p/") && u !== "/p/data.json")).toEqual([]);
    // data.json is revalidated, the CDN files are plain GETs (no headers, so no CORS preflight).
  });

  it("falls back to raw.githubusercontent.com when jsDelivr is down, answers 5xx, HTML or other bytes", async () => {
    for (const mode of ["down", "500", "html", "bad"] as const) {
      const n = net({ hosts: { "cdn.jsdelivr.net": mode } });
      const c = client(n);
      const pack = await c.pack("pub-srp-btn-bb-40");
      const lf = await c.flop(pack.files[0]);
      expect(await lf.integrity, mode).toBe("ok");
      expect(cdn(n).some((u) => u.startsWith("https://raw.githubusercontent.com/bk-git-hub/My-GTO/" + data.pointer.commit + "/packs/")), mode).toBe(true);
    }
  });

  it("tries a host that failed twice last for the rest of the session", async () => {
    const n = net({ hosts: { "cdn.jsdelivr.net": "down" } });
    const c = client(n);
    const pack = await c.pack("pub-srp-btn-bb-40");
    n.urls.length = 0;
    await c.flop(pack.files[1]);
    expect(cdn(n)[0]).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
  });

  it("uses the bundled copy for the legacy packs only when both CDNs fail", async () => {
    expect(LEGACY_PACKS).toContain(LEGACY_ID);
    const n = net();
    const c = client(n);
    await c.catalog();
    n.hosts["cdn.jsdelivr.net"] = "down";
    n.hosts["raw.githubusercontent.com"] = "500";
    const legacy = await c.pack(LEGACY_ID);
    expect(legacy.files).toEqual(packs.manifest.packs[0].files);
    const lf = await c.flop(legacy.files[0]);
    expect(await lf.integrity).toBe("ok");
    expect(n.urls).toContain(`/p/${legacy.files[0].path}`);
    // A new pack has no bundled copy.
    await expect(c.pack("pub-srp-btn-bb-40")).rejects.toThrow("팩 파일 목록");
  });

  it("never caches a file whose sha256 does not match, and a cache hit makes no request", async () => {
    const { caches, buckets } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    const bad = net({ hosts: { "cdn.jsdelivr.net": "bad", "raw.githubusercontent.com": "bad" }, bundled: false });
    await expect(client(bad, cache).catalog()).rejects.toThrow("팩 목록");
    const stored = () => [...(buckets.get(PACK_CACHE_NAME)?.keys() ?? [])].filter((k) => k.includes("/sha256/"));
    expect(stored()).toEqual([]);
    // Nor its pointer: the last pointer is only kept with a verified catalog.
    expect(await cache.getAlias("last/pointer")).toBeNull();

    const n = net();
    const c = client(n, cache);
    const pack = await c.pack("pub-srp-btn-bb-40");
    await c.flop(pack.files[0]);
    expect(stored()).toHaveLength(3);
    // A new client (a reload): data.json is fetched again, every other file comes from the cache.
    const m = net();
    const d = client(m, cache);
    await d.catalog();
    const again = await d.pack("pub-srp-btn-bb-40");
    expect(await (await d.flop(again.files[0])).integrity).toBe("ok");
    expect(m.urls).toEqual(["/p/data.json"]);
  });

  it("does not download a file again when the pointer moves to a commit with the same file", async () => {
    const { caches } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    const n = net();
    const c = client(n, cache);
    const pack = await c.pack("pub-srp-btn-bb-40");
    await c.flop(pack.files[2]);
    const moved = await buildSyntheticCatalog(packs, { commit: "f".repeat(40), spots: { "pub-srp-btn-bb-40": data.catalog.packs[1].spot! }, planned: data.catalog.planned });
    const m = net();
    const fetch2 = m.fetch;
    m.fetch = ((u: RequestInfo | URL) => (String(u) === "/p/data.json" ? ok(JSON.stringify(moved.pointer)) : fetch2(u))) as typeof fetch;
    const d = client(m, cache);
    const p2 = await d.pack("pub-srp-btn-bb-40");
    await d.flop(p2.files[2]);
    // Same catalog bytes, same index, same flop: all from the cache by sha256.
    expect(cdn(m)).toEqual([]);
  });

  it("opens viewed flops offline from the last pointer, catalog and index", async () => {
    const { caches } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    const c = client(net(), cache);
    const pack = await c.pack("pub-srp-btn-bb-40");
    await c.flop(pack.files[0]);
    const off = net({ dataJson: "down", hosts: { "cdn.jsdelivr.net": "down", "raw.githubusercontent.com": "down" } });
    const d = client(off, cache);
    const state = await d.catalog();
    expect(state.status === "ready" && state.offline).toBe(true);
    const again = await d.pack("pub-srp-btn-bb-40");
    expect(await (await d.flop(again.files[0])).integrity).toBe("ok");
    // A flop never viewed is not there offline.
    await expect(d.flop(again.files[1])).rejects.toThrow();
    // A pack never opened has no index offline (no bundled copy for a new pack).
    await expect(d.pack("pub-srp-btn-bb-40-other")).rejects.toThrow("목록에 없어요");
  });

  it("reads the bundled v1 manifest when there is no data.json, and caches it for offline", async () => {
    const { caches } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    const n = net({ dataJson: "404" });
    const s = await client(n, cache).catalog();
    expect(s.status === "ready" && s.source).toBe("bundled");
    expect(cdn(n)).toEqual([]);
    const offline = createPackClient({ base: "/p/", fetch: () => Promise.reject(new TypeError("offline")), cache, warn: () => {} });
    const t = await offline.catalog();
    expect(t.status === "ready" && t.source === "bundled" && t.offline).toBe(true);
  });

  it("lists the bundled packs on a fresh device when data.json loads but neither CDN does", async () => {
    const { caches } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    const n = net({ hosts: { "cdn.jsdelivr.net": "down", "raw.githubusercontent.com": "500" } });
    const c = client(n, cache);
    const state = await c.catalog();
    expect(state.status === "ready" && [state.source, state.offline]).toEqual(["bundled", true]);
    if (state.status !== "ready") return;
    expect(state.catalog.packs.map((p) => p.id)).toEqual(packs.manifest.packs.map((p) => p.id));
    const pack = await c.pack(LEGACY_ID);
    const lf = await c.flop(pack.files[0]);
    expect(await lf.integrity).toBe("ok");
    expect(n.urls).toContain(`/p/${pack.files[0].path}`);
    // Once the bundled copy is gone (R2), the same device gets the error.
    await expect(client(net({ hosts: { "cdn.jsdelivr.net": "down", "raw.githubusercontent.com": "down" }, bundled: false })).catalog()).rejects.toThrow("팩 목록을 불러오지 못했어요");
  });

  it("keeps the pointer and its catalog as a pair: a new pointer whose catalog can't be fetched is not kept", async () => {
    const { caches } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    await client(net(), cache).catalog();
    const moved = await buildSyntheticCatalog(packs, { commit: "e".repeat(40), spots: { "pub-srp-btn-bb-40": data.catalog.packs[1].spot! } });
    const m = net({ hosts: { "cdn.jsdelivr.net": "down", "raw.githubusercontent.com": "down" } });
    const f = m.fetch;
    m.fetch = ((u: RequestInfo | URL) => (String(u) === "/p/data.json" ? ok(JSON.stringify(moved.pointer)) : f(u))) as typeof fetch;
    const d = client(m, cache);
    const state = await d.catalog();
    // The last catalog (the old commit's), flagged; the files are then read from that catalog's own commit.
    expect(state.status === "ready" && [state.source, state.offline, state.catalog.planned?.length]).toEqual(["data", true, 1]);
    m.hosts["cdn.jsdelivr.net"] = "ok";
    m.urls.length = 0;
    await d.pack("pub-srp-btn-bb-40");
    expect(cdn(m)[0]).toContain(`@${data.pointer.commit}/`);
    const kept = JSON.parse(new TextDecoder().decode((await cache.getAlias("last/pointer"))!)) as { commit: string };
    expect(kept.commit).toBe(data.pointer.commit);
  });

  it("says the pack server is unreachable, not offline, while the browser is online", async () => {
    const n = net();
    const c = client(n);
    await c.catalog();
    n.hosts["cdn.jsdelivr.net"] = "down";
    n.hosts["raw.githubusercontent.com"] = "down";
    const nav = globalThis.navigator as { onLine?: boolean } | undefined;
    const had = nav ? Object.getOwnPropertyDescriptor(nav, "onLine") : undefined;
    try {
      if (nav) Object.defineProperty(nav, "onLine", { value: true, configurable: true });
      await expect(c.pack("pub-srp-btn-bb-40")).rejects.toThrow("팩 서버에 연결하지 못했어요");
      if (nav) {
        Object.defineProperty(nav, "onLine", { value: false, configurable: true });
        await expect(c.pack("pub-srp-btn-bb-40")).rejects.toThrow("오프라인이에요");
      }
    } finally {
      if (nav) {
        if (had) Object.defineProperty(nav, "onLine", had);
        else delete (nav as { onLine?: boolean }).onLine;
      }
    }
  });

  it("rejects a data.json with a short SHA or an unsafe path", async () => {
    for (const bad of [{ ...data.pointer, commit: data.pointer.commit.slice(0, 7) }, { ...data.pointer, catalog: { ...data.pointer.catalog, path: "../x.json" } }]) {
      const n = net({ bundled: false });
      const f = n.fetch;
      n.fetch = ((u: RequestInfo | URL) => (String(u) === "/p/data.json" ? ok(JSON.stringify(bad)) : f(u))) as typeof fetch;
      await expect(client(n).catalog()).rejects.toThrow("팩 주소");
      expect(cdn(n)).toEqual([]);
    }
    // While the bundled packs are deployed, a broken data.json lists them instead.
    const n = net();
    const f = n.fetch;
    n.fetch = ((u: RequestInfo | URL) => (String(u) === "/p/data.json" ? ok(JSON.stringify({ ...data.pointer, commit: "abc" })) : f(u))) as typeof fetch;
    const st = await client(n).catalog();
    expect(st.status === "ready" && [st.source, st.offline]).toEqual(["bundled", true]);
  });

  it("honours ?packsData= only in dev builds", () => {
    expect(packsMirror(false, "?packsData=http://localhost:5000/")).toBeUndefined();
    expect(packsMirror(true, "?packsData=http://localhost:5000/")).toBe("http://localhost:5000/");
    expect(packsMirror(true, "?packsData=javascript:alert(1)/")).toBeUndefined();
  });

  it("reads everything from a dev mirror when one is given", async () => {
    const files = new Map<string, string>([["/m/data.json", JSON.stringify(data.pointer)]]);
    for (const [path, text] of data.files) files.set(`/m/packs/${path}`, text);
    const urls: string[] = [];
    const c = createPackClient({
      base: "/p/",
      mirror: "/m/",
      warn: () => {},
      fetch: ((u: RequestInfo | URL) => {
        urls.push(String(u));
        return files.has(String(u)) ? ok(files.get(String(u))!) : status(404);
      }) as typeof fetch,
    });
    const pack = await c.pack("pub-srp-btn-bb-40");
    await c.flop(pack.files[0]);
    expect(urls.every((u) => u.startsWith("/m/"))).toBe(true);
  });
});

describe("pack cache", () => {
  it("asks to keep the storage only where no prompt shows", async () => {
    const calls: string[] = [];
    const nav = (state: PermissionState | "unknown", persisted = false) =>
      ({
        storage: { persisted: async () => persisted, persist: async () => (calls.push(state), true) },
        permissions: {
          query: async () => {
            if (state === "unknown") throw new TypeError("not a permission");
            return { state } as PermissionStatus;
          },
        },
      }) as unknown as Pick<Navigator, "storage" | "permissions">;
    for (const s of ["granted", "prompt", "denied", "unknown"] as const) await askPersist(nav(s));
    await askPersist(nav("granted", true));
    expect(calls).toEqual(["granted", "unknown"]);
  });

  it("keeps files by sha256 and aliases by name, drops the oldest files first and never the aliases", async () => {
    const { caches } = fakeCaches();
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => {} });
    const sha = (i: number) => i.toString(16).padStart(64, "0");
    for (let i = 0; i < 5; i++) await cache.put(sha(i), body(`f${i}`));
    await cache.putAlias("last/catalog", body("cat"));
    expect(await cache.prune(3)).toBe(2);
    expect(await cache.get(sha(0))).toBeNull();
    expect(new TextDecoder().decode((await cache.get(sha(4)))!)).toBe("f4");
    expect(new TextDecoder().decode((await cache.getAlias("last/catalog"))!)).toBe("cat");
    // Bad keys are ignored.
    await cache.put("nothex", body("x"));
    expect(await cache.get("nothex")).toBeNull();
    expect(await cache.getAlias("../etc")).toBeNull();
  });

  it("asks for persistent storage once, on the first write", async () => {
    const { caches } = fakeCaches();
    let asked = 0;
    const cache = openPackCache({ caches, origin: "https://app.test", persist: () => asked++ });
    await cache.put("a".repeat(64), body("1"));
    await cache.put("b".repeat(64), body("2"));
    expect(asked).toBe(1);
  });

  it("is a no-op without the Cache API, or when it throws", async () => {
    const none = openPackCache({ caches: null });
    await none.put("a".repeat(64), body("1"));
    expect(await none.get("a".repeat(64))).toBeNull();
    const broken = openPackCache({ caches: { open: () => Promise.reject(new Error("SecurityError")) } as unknown as CacheStorage, origin: "https://x" });
    await broken.put("a".repeat(64), body("1"));
    expect(await broken.get("a".repeat(64))).toBeNull();
    expect(await broken.prune()).toBe(0);
  });
});
