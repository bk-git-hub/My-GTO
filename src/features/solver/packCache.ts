/**
 * Offline copies of solver pack files (docs/solver-packs.md "Offline"): the app's own Cache Storage, not the service
 * worker's, so it works on a first visit and on iOS before a worker controls the page. Files are kept by their sha256
 * (content-addressed: a new data commit never downloads a file again) and only after the hash matched; a few aliases
 * remember the last pointer, catalog and each pack's last index for offline starts. Every call is wrapped: without the
 * Cache API (plain http on a LAN address, some private modes) the cache is a no-op and the app just downloads.
 */

/** One Cache Storage bucket for every pack file. */
export const PACK_CACHE_NAME = "pubaj-packs-v1";
/** Above this many files the oldest are dropped (about 100 MB of flop files). The aliases are never dropped. */
export const PACK_CACHE_MAX = 3000;

export interface PackCache {
  get(sha256: string): Promise<ArrayBuffer | null>;
  put(sha256: string, buf: ArrayBuffer): Promise<void>;
  /** Aliases: "last/pointer", "last/catalog", "last/manifest-v1", "last-index/<pack id>". */
  getAlias(name: string): Promise<ArrayBuffer | null>;
  putAlias(name: string, buf: ArrayBuffer): Promise<void>;
  /** Drops the oldest files above `maxEntries`; returns how many were dropped. */
  prune(maxEntries?: number): Promise<number>;
}

const SHA = /^[0-9a-f]{64}$/;
const ALIAS = /^(last\/(pointer|catalog|manifest-v1)|last-index\/[a-z0-9-]+)$/;

/** A cache that keeps nothing (no Cache API). */
export const NO_PACK_CACHE: PackCache = {
  get: async () => null,
  put: async () => {},
  getAlias: async () => null,
  putAlias: async () => {},
  prune: async () => 0,
};

export interface PackCacheOptions {
  /** Cache Storage (default: globalThis.caches). */
  caches?: CacheStorage | null;
  /** The origin the keys live under (default: location.origin). */
  origin?: string;
  /** Asks the browser to keep the storage (default: askPersist); called once, on the first write. */
  persist?: () => unknown;
}

/**
 * Asks to keep the storage only where that shows no prompt: Firefox asks the user when the permission is still "prompt",
 * while Chrome decides by itself and reports the same state as "granted" when it would grant. Without the Permissions API
 * for it (Safari), persist() decides silently.
 */
export async function askPersist(nav: Pick<Navigator, "storage" | "permissions"> | undefined = typeof navigator !== "undefined" ? navigator : undefined): Promise<void> {
  try {
    if (!nav?.storage?.persist) return;
    if (await nav.storage.persisted?.()) return;
    let state: PermissionState | null = null;
    try {
      state = (await nav.permissions?.query({ name: "persistent-storage" as PermissionName }))?.state ?? null;
    } catch {
      state = null; // the browser does not know this permission
    }
    if (state === "prompt" || state === "denied") return;
    await nav.storage.persist();
  } catch {
    /* no storage API */
  }
}

export function openPackCache(opts: PackCacheOptions = {}): PackCache {
  const storage = opts.caches === undefined ? (typeof caches !== "undefined" ? caches : null) : opts.caches;
  if (!storage) return NO_PACK_CACHE;
  const origin = opts.origin ?? (typeof location !== "undefined" ? location.origin : "https://pubaj.local");
  const fileKey = (sha: string) => `${origin}/__pack-cache/sha256/${sha}`;
  const aliasKey = (name: string) => `${origin}/__pack-cache/${name}`;
  const persist = opts.persist ?? askPersist;
  let persisted = false;
  let bucket: Promise<Cache | null> | null = null;
  const open = () => (bucket ??= storage.open(PACK_CACHE_NAME).catch(() => null));

  async function read(key: string): Promise<ArrayBuffer | null> {
    try {
      const c = await open();
      const res = c && (await c.match(key));
      return res ? await res.arrayBuffer() : null;
    } catch {
      return null;
    }
  }
  async function write(key: string, buf: ArrayBuffer): Promise<void> {
    try {
      const c = await open();
      if (!c) return;
      await c.put(key, new Response(buf.slice(0), { headers: { "content-type": "application/json" } }));
      if (!persisted) {
        persisted = true;
        void persist();
      }
    } catch {
      /* quota or no Cache API: the file is simply downloaded again next time */
    }
  }

  return {
    get: (sha) => (SHA.test(sha) ? read(fileKey(sha)) : Promise.resolve(null)),
    put: (sha, buf) => (SHA.test(sha) ? write(fileKey(sha), buf) : Promise.resolve()),
    getAlias: (name) => (ALIAS.test(name) ? read(aliasKey(name)) : Promise.resolve(null)),
    putAlias: (name, buf) => (ALIAS.test(name) ? write(aliasKey(name), buf) : Promise.resolve()),
    async prune(maxEntries = PACK_CACHE_MAX) {
      try {
        const c = await open();
        if (!c) return 0;
        // keys() lists the entries in the order they were added: the oldest first.
        const files = (await c.keys()).filter((r) => r.url.includes("/__pack-cache/sha256/"));
        const drop = files.slice(0, Math.max(0, files.length - maxEntries));
        for (const r of drop) await c.delete(r);
        return drop.length;
      } catch {
        return 0;
      }
    },
  };
}
