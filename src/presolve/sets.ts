/**
 * The two sets of packs the presolve pipeline writes (scripts/presolve.mjs): the app's packs and the calibration packs,
 * each in its own directory with its own manifest.json (docs/solver-packs.md). Pure helpers, so the routing rules are
 * tested without running the script.
 */
import type { PackSet } from "./scenarios";

export interface SetDirOptions {
  /** --out, resolved to an absolute path. */
  out: string;
  /** --cal-out, resolved, when given. */
  calOut?: string;
  /** The committed directories, resolved: PACK_SET_DIRS under the repository root. */
  committed: Record<PackSet, string>;
}

/**
 * Where each set goes. The calibration packs follow --cal-out when given; otherwise they go to their committed
 * directory only when --out is the app's committed directory too, and to <out>/calibration for any other --out, so a
 * scratch run never writes into a committed directory. The two directories must differ (one manifest each).
 */
export function setDirs(o: SetDirOptions): Record<PackSet, string> {
  const strip = (p: string) => p.replace(/\/+$/, "");
  const app = strip(o.out);
  const calibration = o.calOut !== undefined ? strip(o.calOut) : app === strip(o.committed.app) ? strip(o.committed.calibration) : `${app}/calibration`;
  if (calibration === app) throw new Error("--cal-out must differ from --out: each set of packs has its own manifest.json");
  return { app, calibration };
}

/** Whether a run writes into a committed directory (then --iterations / --target and a dirty solver are refused). */
export function writesCommitted(dirs: Record<PackSet, string>, sets: PackSet[], committed: Record<PackSet, string>): boolean {
  const c = new Set(Object.values(committed).map((p) => p.replace(/\/+$/, "")));
  return sets.some((set) => c.has(dirs[set]));
}

/**
 * Packs a set's manifest lists that belong to the other set (by the scenarios' `set`). A calibration pack in the
 * app's manifest would be listed by the app, so the script refuses to run while this is not empty.
 */
export function misplacedPacks(manifestIds: string[], set: PackSet, scenarios: { id: string; set: PackSet }[]): string[] {
  const owner = new Map(scenarios.map((s) => [s.id, s.set]));
  return manifestIds.filter((id) => owner.has(id) && owner.get(id) !== set);
}

/**
 * The manifest format each set is written in: the app's packs as a v2 catalog with per-pack indexes (they live on the
 * data branch and the app downloads only the lists of the packs it opens), the calibration packs as the v1 manifest
 * they have always had (src/presolve/store.ts).
 */
export const SET_FORMAT: Record<PackSet, 1 | 2> = { app: 2, calibration: 1 };
