/**
 * Loading solver content packs (docs/solver-packs.md). The app's packs live on the `packs-data` branch:
 *   1. `${BASE_URL}packs/data.json` from our own origin (no-cache): the data commit and the catalog's sha256;
 *   2. the catalog from jsDelivr pinned to that commit, raw.githubusercontent.com as the fallback;
 *   3. a pack's index when it is opened (its sha256 from the catalog), then 4. each flop file (sha256 from the index).
 * Every file is checked against the hash the step before gave and kept in Cache Storage by that hash (packCache.ts), so
 * a flop once viewed opens offline, and a new data commit downloads only what changed. Without data.json (a build
 * from before the data branch, or none deployed yet) the client reads `${BASE_URL}packs/manifest.json` (v1) as before.
 * The three packs that were bundled with the app also fall back to their bundled copy for one release, and so does the
 * list itself when the data branch can't be read and the device has no catalog of it.
 */
import {
  cdnUrls,
  decodeFlopFile,
  packFromIndex,
  validateCatalog,
  validateManifest,
  validatePackIndex,
  validatePointer,
  type Catalog,
  type CatalogPack,
  type DataPointer,
  type DecodedFlop,
  type FileEntry,
  type FlopFile,
  type Manifest,
  type PackEntry,
  type PackIndex,
} from "../../presolve/format";
import { NO_PACK_CACHE, openPackCache, PACK_CACHE_MAX, type PackCache } from "./packCache";

export type Integrity = "ok" | "mismatch" | "unavailable";

/** The packs the app can list: from the data branch's catalog, or from the bundled v1 manifest. */
export type CatalogState =
  | {
      status: "ready";
      catalog: Catalog;
      /** "data": the data branch through the CDN; "bundled": the v1 manifest deployed with the app. */
      source: "data" | "bundled";
      /**
       * Read from a fallback: the last pointer or catalog this device saw (data.json or both CDNs unreachable), or the
       * bundled packs because the data branch could not be read and the device had no catalog of it.
       */
      offline: boolean;
      problems: string[];
    }
  | { status: "empty" };

export interface LoadedFlop {
  entry: FileEntry;
  file: FlopFile;
  flop: DecodedFlop;
  /** Downloaded size in bytes. */
  bytes: number;
  /** The sha256 check (done before the file is returned; resolves at once, never rejects). */
  integrity: Promise<Integrity>;
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

/** The packs that were bundled with the app before the data branch: their bundled copy stays a fallback for one release. */
export const LEGACY_PACKS: readonly string[] = ["srp-btn-bb-100", "pub-srp-btn-bb-55", "pub-srp-utg-bb-55"];

/**
 * The packs directory URL on our own origin (data.json, and the bundled v1 packs). In dev builds `?packs=packs-<name>`
 * switches to another directory under public/ (e.g. a synthetic pack in public/packs-dev/).
 */
export function packsBase(
  baseUrl: string = import.meta.env.BASE_URL,
  dev: boolean = import.meta.env.DEV,
  search: string = typeof location !== "undefined" ? location.search : "",
): string {
  let dir = "packs";
  if (dev) {
    const q = new URLSearchParams(search).get("packs");
    if (q && /^packs-[a-z0-9-]+$/.test(q)) dir = q;
  }
  return `${baseUrl}${dir}/`;
}

/**
 * Dev builds only: `?packsData=<url ending in />` reads data.json and every data file from a local mirror of the data
 * branch (`<url>data.json`, `<url><dir><path>`) instead of the CDN.
 */
export function packsMirror(dev: boolean = import.meta.env.DEV, search: string = typeof location !== "undefined" ? location.search : ""): string | undefined {
  if (!dev) return undefined;
  const q = new URLSearchParams(search).get("packsData");
  return q && /^(https?:\/\/[^\s]+|\/[^\s]*)\/$/.test(q) ? q : undefined;
}

/** Lowercase hex sha256, or null when WebCrypto isn't available (e.g. plain http on a LAN address). */
export async function sha256Hex(data: ArrayBuffer, subtle: SubtleCrypto | null | undefined): Promise<string | null> {
  if (!subtle) return null;
  try {
    const d = new Uint8Array(await subtle.digest("SHA-256", data));
    let s = "";
    for (const b of d) s += b.toString(16).padStart(2, "0");
    return s;
  } catch {
    return null;
  }
}

export interface PackClientOptions {
  /** Our own packs directory URL ending in "/", e.g. packsBase(): data.json and the bundled v1 packs. */
  base: string;
  fetch?: typeof fetch;
  subtle?: SubtleCrypto | null;
  cache?: PackCache | null;
  /** Per-request timeout in ms for data files (data.json gets 6 s at most). Default 8000. */
  timeoutMs?: number;
  /** A local mirror of the data branch (packsMirror), used instead of the CDN. */
  mirror?: string;
  warn?: (msg: string) => void;
}

export interface PackClient {
  readonly base: string;
  /** The list of packs (and the planned ones). */
  catalog(): Promise<CatalogState>;
  /** One pack with its file list (downloads its index the first time). */
  pack(id: string): Promise<PackEntry>;
  flop(entry: FileEntry): Promise<LoadedFlop>;
  /** Forget everything held in memory, so the next call fetches again (retry after an error). */
  reset(): void;
}

/** A static host with an SPA fallback answers a missing JSON file with index.html. */
const looksLikeHtml = (text: string) => /^\s*</.test(text);
const enc = new TextEncoder();
const dec = new TextDecoder();
const OFFLINE = "오프라인이에요. 열어 본 플랍만 볼 수 있어요.";
/** Online, but neither CDN answered (or both sent other bytes). */
const SERVER_DOWN = "팩 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.";

/** The browser says it has no network (navigator.onLine false); unknown counts as online. */
export function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

type FetchStatus = number | "network" | "html" | "mismatch";
type Fetched = { ok: true; buf: ArrayBuffer } | { ok: false; status: FetchStatus };

export function createPackClient(opts: PackClientOptions): PackClient {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const subtle = opts.subtle === undefined ? (globalThis.crypto?.subtle ?? null) : opts.subtle;
  const cache = opts.cache ?? NO_PACK_CACHE;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const warn = opts.warn ?? ((msg: string) => console.warn(`[packs] ${msg}`));
  const failures = new Map<string, number>(); // host → failures this session (a host with 2+ is tried last)

  let catalogP: Promise<CatalogState> | null = null;
  let pointer: DataPointer | null = null;
  let bundled: Manifest | null = null; // the v1 manifest when it is the source, or loaded as the legacy fallback
  const packs = new Map<string, Promise<PackEntry>>();
  const flops = new Map<string, Promise<LoadedFlop>>();
  let puts = 0;

  async function get(url: string, init: RequestInit, ms: number): Promise<Fetched> {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      const res = await doFetch(url, { ...init, ...(ctl ? { signal: ctl.signal } : {}) });
      if (!res.ok) return { ok: false, status: res.status };
      const buf = await res.arrayBuffer();
      if (looksLikeHtml(dec.decode(buf.slice(0, 64)))) return { ok: false, status: "html" };
      return { ok: true, buf };
    } catch {
      return { ok: false, status: "network" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const hostOf = (url: string) => {
    try {
      return new URL(url, "https://self.invalid/").host;
    } catch {
      return url;
    }
  };
  /** The sources in order, a host that failed twice this session last. */
  const ordered = (urls: string[]) => [...urls].sort((a, b) => Number((failures.get(hostOf(a)) ?? 0) >= 2) - Number((failures.get(hostOf(b)) ?? 0) >= 2));

  /**
   * A file with a known sha256: from the cache, else from each source in turn until one gives the right bytes (then
   * cached). Without WebCrypto the first readable copy is used and not cached. When every source answered but with
   * other bytes, the last copy comes back flagged ("mismatch") unless `strict`.
   */
  async function fetchVerified(urls: string[], sha256: string, strict: boolean): Promise<{ buf: ArrayBuffer; integrity: Integrity } | { error: FetchStatus[] }> {
    const hit = await cache.get(sha256);
    if (hit) return { buf: hit, integrity: "ok" };
    const errors: FetchStatus[] = [];
    let mismatch: ArrayBuffer | null = null;
    for (const url of ordered(urls)) {
      const r = await get(url, {}, timeoutMs);
      let status: FetchStatus | null = r.ok ? null : r.status;
      if (r.ok) {
        const hex = await sha256Hex(r.buf, subtle);
        if (hex === null) return { buf: r.buf, integrity: "unavailable" };
        if (hex === sha256) {
          await cache.put(sha256, r.buf);
          if (++puts % 50 === 0) void cache.prune(PACK_CACHE_MAX);
          return { buf: r.buf, integrity: "ok" };
        }
        warn(`${url}: sha256 ${hex} does not match ${sha256}`);
        mismatch = r.buf;
        status = "mismatch";
      }
      errors.push(status!);
      failures.set(hostOf(url), (failures.get(hostOf(url)) ?? 0) + 1);
    }
    if (mismatch && !strict) return { buf: mismatch, integrity: "mismatch" };
    return { error: errors };
  }

  const dataUrls = (path: string): string[] => {
    if (!pointer) return [];
    if (opts.mirror) return [`${opts.mirror}${pointer.dir}${path}`];
    return cdnUrls(pointer, path);
  };

  const parseJson = <T>(buf: ArrayBuffer, what: string): T => {
    try {
      return JSON.parse(dec.decode(buf)) as T;
    } catch {
      throw new PackError(`${what} 형식이 올바르지 않아요.`);
    }
  };

  /** The pointer the last catalog this device saw came with (saved together with it), or null. */
  async function lastPointer(): Promise<DataPointer | null> {
    const last = await cache.getAlias("last/pointer");
    if (!last) return null;
    try {
      const p = JSON.parse(dec.decode(last)) as DataPointer;
      return validatePointer(p).length ? null : p;
    } catch {
      return null; // a broken alias: as if there were none
    }
  }

  /**
   * The data pointer: fetched from our origin (`buf` is its bytes, saved as the last pointer once its catalog is
   * verified), else the last one this device saw (offline).
   */
  async function loadPointer(): Promise<{ pointer: DataPointer; buf: ArrayBuffer | null; offline: boolean } | null> {
    const url = opts.mirror ? `${opts.mirror}data.json` : `${opts.base}data.json`;
    const r = await get(url, { cache: "no-cache" }, Math.min(6000, timeoutMs));
    if (r.ok) {
      const p = parseJson<DataPointer>(r.buf, "팩 주소");
      const errs = validatePointer(p);
      if (errs.length) throw new PackError(`팩 주소가 올바르지 않아요 (${errs[0]}).`);
      return { pointer: p, buf: r.buf, offline: false };
    }
    if (r.status === 404 || r.status === "html") return null; // no data branch yet: the bundled v1 manifest
    const last = await lastPointer();
    return last ? { pointer: last, buf: null, offline: true } : null;
  }

  async function loadDataCatalog(p: DataPointer, pointerBuf: ArrayBuffer | null, offline: boolean): Promise<CatalogState> {
    const got = await fetchVerified(dataUrls(p.catalog.path), p.catalog.sha256, true);
    let buf: ArrayBuffer;
    if ("buf" in got) {
      buf = got.buf;
      // The pointer and its catalog are kept as a pair, so an offline start reads files from the catalog's own commit.
      await cache.putAlias("last/catalog", buf);
      if (pointerBuf) await cache.putAlias("last/pointer", pointerBuf);
    } else {
      const last = await cache.getAlias("last/catalog");
      if (!last) throw new PackError(offline || got.error.every((e) => e === "network") ? "팩 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요." : "팩 목록을 받지 못했어요.");
      buf = last;
      offline = true;
      pointer = (await lastPointer()) ?? pointer;
    }
    const catalog = parseJson<Catalog>(buf, "팩 목록");
    const problems = validateCatalog(catalog);
    if (catalog?.v !== 2 || !Array.isArray(catalog.packs)) throw new PackError("지원하지 않는 팩 목록 버전이에요.");
    if (problems.length) warn(`catalog has ${problems.length} problem(s): ${problems.slice(0, 3).join("; ")}`);
    const usable: Catalog = { ...catalog, packs: catalog.packs.filter((x) => x && x.flops > 0 && x.index && x.scenario && Array.isArray(x.summaryNodes)) };
    if (!usable.packs.length && !usable.planned?.length) return { status: "empty" };
    return { status: "ready", catalog: usable, source: "data", offline, problems };
  }

  /** The v1 manifest deployed with the app (`${base}manifest.json`), else the last one this device saw. */
  async function loadBundled(): Promise<{ manifest: Manifest; offline: boolean } | null> {
    const r = await get(`${opts.base}manifest.json`, { cache: "no-cache" }, timeoutMs);
    let buf: ArrayBuffer | null = null;
    let offline = false;
    if (r.ok) {
      buf = r.buf;
      await cache.putAlias("last/manifest-v1", buf);
    } else if (r.status === 404 || r.status === "html") return null;
    else {
      buf = await cache.getAlias("last/manifest-v1");
      offline = true;
      if (!buf) throw new PackError(r.status === "network" ? "팩 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요." : `팩 목록을 불러오지 못했어요 (HTTP ${r.status}).`);
    }
    const m = parseJson<Manifest>(buf, "팩 목록");
    if (!m || m.v !== 1 || !Array.isArray(m.packs)) throw new PackError("지원하지 않는 팩 목록 버전이에요.");
    const list = m.packs.filter((p) => p && Array.isArray(p.files) && Array.isArray(p.summaryNodes) && p.scenario);
    const manifest = { ...m, packs: list };
    const problems = validateManifest(manifest);
    if (problems.length) warn(`manifest has ${problems.length} problem(s): ${problems.slice(0, 3).join("; ")}`);
    return { manifest, offline };
  }

  /** The v1 manifest as a catalog (its packs keep their file lists in `bundled`). */
  function bundledCatalog(m: Manifest, offline: boolean): CatalogState {
    const packs = m.packs
      .filter((p) => p.files.length > 0)
      .map((p): CatalogPack => {
        const out = { id: p.id, title: p.title, version: p.version, tier: p.tier, scenario: p.scenario, summaryNodes: p.summaryNodes } as CatalogPack;
        if (p.solverCommit !== undefined) out.solverCommit = p.solverCommit;
        out.flops = p.files.length;
        out.weight = p.files.reduce((s, f) => s + f.weight, 0);
        out.index = { path: "", sha256: "", bytes: 0 };
        return out;
      });
    if (!packs.length) return { status: "empty" };
    return { status: "ready", catalog: { v: 2, generatedAt: m.generatedAt, packs }, source: "bundled", offline, problems: [] };
  }

  async function loadCatalog(): Promise<CatalogState> {
    try {
      const p = await loadPointer();
      if (p) {
        pointer = p.pointer;
        return await loadDataCatalog(p.pointer, p.buf, p.offline);
      }
    } catch (e) {
      // The data branch can't be read and this device has no catalog of it (a fresh install while both CDNs are down,
      // or a broken data.json): the packs bundled with the app, for as long as they are deployed (R2 removes them).
      let b: Awaited<ReturnType<typeof loadBundled>> = null;
      try {
        b = await loadBundled();
      } catch {
        b = null;
      }
      const st = b && bundledCatalog(b.manifest, true);
      if (b && st?.status === "ready") {
        warn(`data branch unavailable (${(e as Error).message}); listing the bundled packs`);
        bundled = b.manifest;
        return st;
      }
      throw e;
    }
    pointer = null;
    const b = await loadBundled();
    if (!b) return { status: "empty" };
    bundled = b.manifest;
    return bundledCatalog(b.manifest, b.offline);
  }

  async function loadPack(id: string): Promise<PackEntry> {
    const state = await client.catalog();
    if (state.status !== "ready") throw new PackError("이 팩은 지금 목록에 없어요.");
    const cp = state.catalog.packs.find((x) => x.id === id);
    if (!cp) throw new PackError("이 팩은 지금 목록에 없어요.");
    if (state.source === "bundled") return bundled!.packs.find((x) => x.id === id)!;
    const got = await fetchVerified(dataUrls(cp.index.path), cp.index.sha256, true);
    let idx: PackIndex | null = null;
    if ("buf" in got) {
      idx = parseJson<PackIndex>(got.buf, "팩 파일 목록");
      const errs = validatePackIndex(idx, cp);
      if (errs.length) throw new PackError(`팩 파일 목록이 올바르지 않아요 (${errs[0]}).`);
      await cache.putAlias(`last-index/${id}`, got.buf);
      return packFromIndex(cp, idx);
    }
    // Offline (or both CDNs down): the last index of this pack the device saw, if it is of the same version.
    const last = await cache.getAlias(`last-index/${id}`);
    if (last) {
      try {
        const old = JSON.parse(dec.decode(last)) as PackIndex;
        if (old.v === 2 && old.id === id && old.version === cp.version && Array.isArray(old.files)) return packFromIndex(cp, old);
      } catch {
        /* broken alias */
      }
    }
    // The packs that were bundled with the app: their bundled entry (the same files) for one release.
    if (LEGACY_PACKS.includes(id)) {
      try {
        bundled ??= (await loadBundled())?.manifest ?? null;
      } catch {
        bundled = null;
      }
      const e = bundled?.packs.find((x) => x.id === id && x.version === cp.version);
      if (e) return e;
    }
    throw new PackError(got.error.every((e) => e === "network") ? (browserOffline() ? OFFLINE : SERVER_DOWN) : "팩 파일 목록을 받지 못했어요.");
  }

  async function loadFlop(entry: FileEntry): Promise<LoadedFlop> {
    const packId = entry.path.split("/")[0];
    const urls = pointer ? dataUrls(entry.path) : [];
    if (!pointer || LEGACY_PACKS.includes(packId)) urls.push(`${opts.base}${entry.path}`);
    const got = await fetchVerified(urls, entry.sha256, false);
    if (!("buf" in got)) {
      if (got.error.every((e) => e === 404 || e === "html")) throw new PackError("이 플랍 파일이 서버에 없어요.");
      if (got.error.every((e) => e === "network")) throw new PackError(browserOffline() ? OFFLINE : "플랍 파일을 받지 못했어요. 인터넷 연결을 확인해 주세요.");
      const http = got.error.find((e) => typeof e === "number");
      throw new PackError(`플랍 파일을 받지 못했어요${http ? ` (HTTP ${http})` : ""}.`);
    }
    const { buf, integrity } = got;
    let file: FlopFile;
    let flop: DecodedFlop;
    try {
      file = JSON.parse(dec.decode(buf)) as FlopFile;
      flop = decodeFlopFile(file);
    } catch (e) {
      throw new PackError(`플랍 파일을 읽지 못했어요: ${(e as Error).message}`);
    }
    if (buf.byteLength !== entry.bytes) warn(`${entry.path}: ${buf.byteLength} bytes, the list says ${entry.bytes}`);
    if (file.board !== entry.board) warn(`${entry.path}: board ${file.board}, the list says ${entry.board}`);
    return { entry, file, flop, bytes: buf.byteLength, integrity: Promise.resolve(integrity) };
  }

  const memo = <T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    let p = map.get(key);
    if (!p) {
      const q = load();
      p = q;
      map.set(key, q);
      q.catch(() => {
        if (map.get(key) === q) map.delete(key);
      });
    }
    return p;
  };

  const client: PackClient = {
    base: opts.base,
    catalog() {
      if (!catalogP) {
        const p = loadCatalog();
        catalogP = p;
        p.catch(() => {
          if (catalogP === p) catalogP = null;
        });
      }
      return catalogP;
    },
    pack: (id) => memo(packs, id, () => loadPack(id)),
    flop: (entry) => memo(flops, `${entry.path} ${entry.sha256}`, () => loadFlop(entry)),
    reset() {
      catalogP = null;
      packs.clear();
      flops.clear();
    },
  };
  return client;
}

/** UTF-8 bytes of a string as an ArrayBuffer (tests and fixtures). */
export const textBuffer = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

let defaultClient: PackClient | null = null;

/** The app-wide client: our packs directory, the CDN (or the dev mirror), the offline cache. */
export function packClient(): PackClient {
  return (defaultClient ??= createPackClient({ base: packsBase(), mirror: packsMirror(), cache: openPackCache() }));
}
