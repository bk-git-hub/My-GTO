import type { DecodedFlop, FileEntry } from "../../presolve/format";
import { createOracle } from "../../play/packOracle";
import { catalogIndex, type PackInfo } from "../../play/packMatch";
import type { LoadKey, PostflopOracle } from "../../play/table";
import { packClient, type PackClient } from "../solver/packs";

/**
 * The AI table's solver pack source: the catalog (as the registry), the file lists and the flop files a hand needs,
 * loaded through the solver page's pack client (the data branch through the CDN, its offline cache, the bundled packs)
 * and kept in synchronous caches the oracle reads (play/ stays free of fetch). The catalog lists every pack without its
 * files; a pack's file list (its index, up to about 0.55 MB) loads only when a flop could use the pack, so opening the
 * table costs the catalog alone. A load never blocks a hand: it gives up after `timeoutMs` and the hand goes on with the
 * approximate rules.
 */

export interface PackSource {
  oracle: PostflopOracle;
  /** Load what a hand needs; true when it is now at hand. */
  load(key: LoadKey, timeoutMs?: number): Promise<boolean>;
  /** Start loading the catalog in idle time. */
  prefetchManifest(): void;
  /** The registry, or null until the catalog loads. */
  packs(): readonly PackInfo[] | null;
}

const FLOP_CACHE = 20;

export function createPackSource(client: PackClient = packClient()): PackSource {
  let packs: PackInfo[] | null = null;
  const byPath = new Map<string, FileEntry>();
  let manifestP: Promise<boolean> | null = null;
  const packJobs = new Map<string, Promise<boolean>>();
  const flops = new Map<string, DecodedFlop>();

  const getFlop = (path: string): DecodedFlop | null => {
    const f = flops.get(path);
    if (!f) return null;
    flops.delete(path);
    flops.set(path, f);
    return f;
  };

  function loadManifest(): Promise<boolean> {
    if (packs) return Promise.resolve(true);
    if (!manifestP) {
      // Any failure (the fetch, or reading the catalog) leaves nothing cached, so the next hand asks again.
      manifestP = client
        .catalog()
        .then((st) => {
          packs = st.status === "ready" ? catalogIndex(st.catalog.packs) : [];
          return true;
        })
        .catch(() => {
          manifestP = null;
          return false;
        });
    }
    return manifestP;
  }

  /**
   * One pack's file list into the registry. The registry is replaced, not changed in place, so a reader holding the old
   * array is not changed under it. A failure leaves the pack pending, so a later hand asks again.
   */
  function loadPack(id: string): Promise<boolean> {
    let job = packJobs.get(id);
    if (!job) {
      const q = (async () => {
        if (!(await loadManifest())) return false;
        const info = packs!.find((p) => p.id === id);
        if (!info) return false;
        if (!info.pending) return true;
        const entry = await client.pack(id);
        if (entry.version !== info.version) return false;
        const files = new Map(entry.files.filter((f) => f && typeof f.board === "string").map((f) => [f.board, f] as const));
        for (const f of files.values()) byPath.set(f.path, f);
        packs = packs!.map((p) => (p.id === id ? { ...p, files, pending: false } : p));
        return true;
      })().catch(() => false);
      job = q;
      packJobs.set(id, q);
      void q.then((ok) => {
        if (!ok && packJobs.get(id) === q) packJobs.delete(id);
      });
    }
    return job;
  }

  /** The file lists of the packs that could match a flop: all of them, or the hand goes on with the approximate rules. */
  async function loadPacks(ids: readonly string[]): Promise<boolean> {
    const ok = await Promise.all(ids.map(loadPack));
    return ok.every(Boolean);
  }

  async function loadFlop(path: string): Promise<boolean> {
    if (flops.has(path)) return true;
    if (!(await loadManifest())) return false;
    const entry = byPath.get(path);
    if (!entry) return false;
    try {
      const lf = await client.flop(entry);
      flops.set(path, lf.flop);
      while (flops.size > FLOP_CACHE) flops.delete(flops.keys().next().value!);
      return true;
    } catch {
      return false;
    }
  }

  return {
    oracle: createOracle({ packs: () => packs, flop: getFlop }),
    load(key, timeoutMs = 5000) {
      const job = (key.kind === "manifest" ? loadManifest() : key.kind === "packs" ? loadPacks(key.ids) : loadFlop(key.path)).catch(() => false);
      return Promise.race([job, new Promise<boolean>((res) => setTimeout(() => res(false), timeoutMs))]);
    },
    prefetchManifest() {
      const go = () => void loadManifest();
      const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(go, { timeout: 3000 });
      else setTimeout(go, 500);
    },
    packs: () => packs,
  };
}

let shared: PackSource | null = null;
/** The app-wide source, so the caches outlive a visit to the page. */
export const packSource = (): PackSource => (shared ??= createPackSource());
