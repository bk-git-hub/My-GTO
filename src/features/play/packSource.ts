import type { DecodedFlop, FileEntry } from "../../presolve/format";
import { createOracle } from "../../play/packOracle";
import { packIndex, type PackInfo } from "../../play/packMatch";
import type { LoadKey, PostflopOracle } from "../../play/table";
import { packClient, type PackClient } from "../solver/packs";

/**
 * The AI table's solver pack source: the manifest (as the registry) and the flop files a hand needs, loaded through the
 * solver page's pack client and kept in synchronous caches the oracle reads (play/ stays free of fetch). A load never
 * blocks a hand: it gives up after `timeoutMs` and the hand goes on with the approximate rules.
 */

export interface PackSource {
  oracle: PostflopOracle;
  /** Load what a hand needs; true when it is now at hand. */
  load(key: LoadKey, timeoutMs?: number): Promise<boolean>;
  /** Start loading the manifest in idle time. */
  prefetchManifest(): void;
  /** The registry, or null until the manifest loads. */
  packs(): readonly PackInfo[] | null;
}

const FLOP_CACHE = 20;

export function createPackSource(client: PackClient = packClient()): PackSource {
  let packs: PackInfo[] | null = null;
  let byPath = new Map<string, FileEntry>();
  let manifestP: Promise<boolean> | null = null;
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
      // Any failure (the fetch, or reading the manifest) leaves nothing cached, so the next hand asks again.
      manifestP = client
        .manifest()
        .then((st) => {
          const list = st.status === "ready" ? packIndex(st.manifest) : [];
          byPath = new Map(list.flatMap((p) => [...p.files.values()].map((f) => [f.path, f] as const)));
          packs = list;
          return true;
        })
        .catch(() => {
          manifestP = null;
          return false;
        });
    }
    return manifestP;
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
      const job = (key.kind === "manifest" ? loadManifest() : loadFlop(key.path)).catch(() => false);
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
