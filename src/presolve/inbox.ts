/**
 * The `packs-inbox` branch: where machines outside the presolve workflow leave the flops they solved, for the workflow's
 * merge job to take in with exactly the checks a shard's files get (scripts/presolve-worker.mjs, run by anyone with push
 * access on their own computer; docs/worker-setup.md). The worker solves the workflow's queue from the back (shard.ts
 * `--order reverse`), so nobody assigns or claims flops. Pure helpers shared by the worker, the workflow's
 * scripts/packs-inbox.mjs and the tests; git and the file system stay in the scripts.
 *
 * Layout of the orphan branch (data only and never merged, like packs-data):
 *   <solver>/files/<pack>/v<k>/flop-<board>.json      app packs (packs-data's packs/<pack>/v<k>/...)
 *   <solver>/cal-files/<pack>/v<k>/flop-<board>.json  calibration packs (master's calibration/packs/...)
 *   <solver>/summaries/<worker>-<time>.json           exact summaries of one batch (presolve.mjs --summaries-out)
 *   workers/<worker>.json                             each worker's heartbeat (the split between workers)
 *   README.md, vercel.json                            what the branch is; no Vercel builds
 * <solver> is the full SHA of the last commit that changed src/solver (the commit presolve.mjs names, with all 40
 * digits: an abbreviation can differ in length between clones). The merge takes only the files of its own solver commit
 * and of each pack's current version, and removes the files of an older solver commit or version, which nobody takes.
 */
import type { Shard } from "./shard";

export type PackSet = "app" | "calibration";

export const INBOX_BRANCH = "packs-inbox";

/** Each set's directory under a solver commit (the same names as a shard artifact's, scripts/packs-ingest.mjs). */
export const INBOX_SET_DIRS: Record<PackSet, string> = { app: "files", calibration: "cal-files" };

const FLOP = /^([a-z0-9-]+)\/v([0-9]+)\/flop-([2-9TJQKAshdc]{6})\.json$/;
const SOLVER = /^[0-9a-f]{40}$/;
/** A worker's id: random hex, made once per machine (nothing about the machine or its owner). */
export const WORKER_ID = /^[0-9a-f]{8,32}$/;

export const isSolverCommit = (s: string): boolean => SOLVER.test(s);
/** A pack file's path inside its set's directory (format.ts packFilePath): `<pack>/v<k>/flop-<board>.json`. */
export const isPackFlopPath = (p: string): boolean => FLOP.test(p);

/** One flop file on the branch. */
export interface InboxFlop {
  /** Path on the branch. */
  inboxPath: string;
  solver: string;
  set: PackSet;
  /** Path inside the set's directory: `<pack>/v<k>/flop-<board>.json`. */
  path: string;
  pack: string;
  version: number;
  board: string;
}

export function inboxPath(solver: string, set: PackSet, path: string): string {
  return `${solver}/${INBOX_SET_DIRS[set]}/${path}`;
}

/** A path on the branch as a flop file, or null (summaries, heartbeats, anything else). */
export function parseInboxFlop(p: string): InboxFlop | null {
  const m = /^([0-9a-f]{40})\/(files|cal-files)\/(.+)$/.exec(p);
  if (!m) return null;
  const f = FLOP.exec(m[3]);
  if (!f) return null;
  return { inboxPath: p, solver: m[1], set: m[2] === "files" ? "app" : "calibration", path: m[3], pack: f[1], version: Number(f[2]), board: f[3] };
}

/** The flop files of one solver commit among the branch's paths. */
export function inboxFlops(paths: Iterable<string>, solver: string): InboxFlop[] {
  const out: InboxFlop[] = [];
  for (const p of paths) {
    const f = parseInboxFlop(p);
    if (f && f.solver === solver) out.push(f);
  }
  return out;
}

/** The solver commits other than `solver` that have anything on the branch. */
export function otherSolvers(paths: Iterable<string>, solver: string): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const s = p.slice(0, p.indexOf("/"));
    if (SOLVER.test(s) && s !== solver) out.add(s);
  }
  return [...out].sort();
}

/**
 * A skip list for `presolve.mjs --skip-from`: pack paths, one per line, sorted. App and calibration paths share one list
 * (pack ids are unique across the two sets).
 */
export function skipList(paths: Iterable<string>): string {
  const lines = [...new Set([...paths].filter(isPackFlopPath))].sort();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Reads a skip list: one pack path per line; blank lines, `#` comments and anything else that is not a pack path are ignored. */
export function parseSkipList(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim();
    if (isPackFlopPath(p)) out.add(p);
  }
  return out;
}

export interface InboxPlan {
  /** Files the merge copies in: a pack the run covers, at the code's version, in the pack's own set. */
  take: InboxFlop[];
  /** Files nobody will take (a version older than the code's, or the wrong set's directory): removed. */
  stale: InboxFlop[];
  /** Files left for a later run: a newer version or a pack this code doesn't define (a worker on a newer master), or a pack the run doesn't cover. */
  later: InboxFlop[];
}

/** Sorts a solver commit's flops for the merge (`packs`: every pack the code defines; `covered`: the ids the run covers). */
export function planInbox(flops: readonly InboxFlop[], packs: readonly { id: string; set: PackSet; version: number }[], covered: ReadonlySet<string>): InboxPlan {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const plan: InboxPlan = { take: [], stale: [], later: [] };
  for (const f of flops) {
    const p = byId.get(f.pack);
    if (!p || f.version > p.version) plan.later.push(f);
    else if (f.version < p.version || f.set !== p.set) plan.stale.push(f);
    else if (!covered.has(f.pack)) plan.later.push(f);
    else plan.take.push(f);
  }
  return plan;
}

/** A batch's summaries file: `<solver>/summaries/<worker>-<UTC time>.json`. */
export function summariesPath(solver: string, worker: string, at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `${solver}/summaries/${worker}-${stamp}.json`;
}

export function isSummariesPath(p: string, solver: string): boolean {
  return p.startsWith(`${solver}/summaries/`) && p.endsWith(".json") && !p.slice(solver.length + 11).includes("/");
}

/** One summaries file on the branch, with the files it lists (`{ set, path }` as presolve.mjs --summaries-out writes them). */
export interface InboxSummaries {
  inboxPath: string;
  files: readonly { set?: string; path?: string }[];
}

export interface RemovalInput {
  /** Every path on the branch at the head the merge read. */
  paths: readonly string[];
  /** The merge's solver commit. */
  solver: string;
  /** planInbox's `take` and `stale` at that head. */
  taken: readonly InboxFlop[];
  stale: readonly InboxFlop[];
  /** Whether a taken flop is now published (listed in the pushed catalog or calibration manifest). */
  published: (f: InboxFlop) => boolean;
  /** The taken files failed the merge's checks: all of them are removed, so the flops get solved again. */
  rejected: boolean;
  /** Solver commits on the branch that are ancestors of `solver`: nothing will ever take their files. */
  olderSolvers: ReadonlySet<string>;
  /** The solver commit's summaries files at that head. */
  summaries: readonly InboxSummaries[];
}

/**
 * What the merge removes from the branch once its pushes went through: the taken files that are published now (or all
 * the taken files, when they failed the checks), the stale ones, everything under an older solver commit, and every
 * summaries file whose flops are all gone. Only paths of the head the merge read: whatever a worker pushed later stays.
 */
export function inboxRemovals(o: RemovalInput): string[] {
  const remove = new Set<string>();
  for (const f of o.taken) if (o.rejected || o.published(f)) remove.add(f.inboxPath);
  for (const f of o.stale) remove.add(f.inboxPath);
  for (const p of o.paths) if (o.olderSolvers.has(p.slice(0, p.indexOf("/")))) remove.add(p);
  const present = new Set(o.paths);
  for (const s of o.summaries) {
    const listed = s.files
      .filter((f) => (f.set === "app" || f.set === "calibration") && typeof f.path === "string" && isPackFlopPath(f.path))
      .map((f) => inboxPath(o.solver, f.set as PackSet, f.path as string));
    if (listed.every((p) => remove.has(p) || !present.has(p))) remove.add(s.inboxPath);
  }
  return [...remove].filter((p) => present.has(p)).sort();
}

// ───────────────────────── the split between workers ─────────────────────────

/** Each worker's heartbeat, `workers/<id>.json`, pushed with every batch (and when it starts and stops). */
export interface Heartbeat {
  v: 1;
  id: string;
  /** Solves it runs at once (shown in the log of the others; the split itself is even). */
  slots: number;
  /** ISO time of the push. */
  updatedAt: string;
  /** Set by a clean stop: the others take its share at their next batch instead of waiting for it to expire. */
  stopped?: boolean;
}

export const HEARTBEAT_DIR = "workers";
/** A worker without a heartbeat for this long (4 missed batches: asleep, off, offline) no longer gets a share. */
export const ACTIVE_MS = 2 * 3600_000;

export const heartbeatPath = (id: string): string => `${HEARTBEAT_DIR}/${id}.json`;

export function parseHeartbeat(text: string): Heartbeat | null {
  try {
    const h = JSON.parse(text) as Partial<Heartbeat>;
    if (h?.v !== 1 || typeof h.id !== "string" || !WORKER_ID.test(h.id) || typeof h.updatedAt !== "string" || !Number.isFinite(Date.parse(h.updatedAt))) return null;
    return { v: 1, id: h.id, slots: Number.isSafeInteger(h.slots) && (h.slots as number) > 0 ? (h.slots as number) : 1, updatedAt: h.updatedAt, ...(h.stopped ? { stopped: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * The workers that share the back of the queue, sorted by id: every live heartbeat (pushed less than ACTIVE_MS ago, not
 * stopped) and `me`. A heartbeat from the future by more than that (a machine with a wrong clock) does not count, or it
 * would hold a share forever.
 */
export function activeWorkers(beats: readonly Heartbeat[], me: string, now: number): string[] {
  const ids = new Set([me]);
  for (const b of beats) {
    const t = Date.parse(b.updatedAt);
    if (!b.stopped && Math.abs(now - t) < ACTIVE_MS) ids.add(b.id);
  }
  return [...ids].sort();
}

/**
 * This worker's share, as a presolve.mjs shard: worker i of n (sorted by id) takes the flops whose priority index k has
 * k % n == i, so two workers never solve the same flop. A worker that hasn't seen another's heartbeat yet solves the
 * whole back for one batch at most (heartbeats go out at the start and with every batch).
 */
export function workerShard(active: readonly string[], me: string): Shard {
  const index = active.indexOf(me);
  return index < 0 ? { index: 0, count: 1 } : { index, count: active.length };
}

// ───────────────────────── how many solves at once ─────────────────────────

/** RAM a worker leaves to the rest of the machine (the browser, the OS). */
export const HEADROOM_BYTES = 3 * 2 ** 30;
/** presolve.mjs counts each running solve at its estimateMemory × this. */
export const MEMORY_MARGIN = 1.25;

/**
 * Solves a worker runs at once: one per physical core (hyperthreads add little to the solver and take the machine's
 * slack away), and only as many as fit in the RAM left after the headroom at `perFlopBytes` each; at least one.
 */
export function solveSlots(o: { physicalCores: number; totalBytes: number; perFlopBytes: number; headroomBytes?: number }): number {
  const cores = Math.max(1, Math.floor(o.physicalCores));
  if (!(o.perFlopBytes > 0)) return cores;
  const fit = Math.floor((o.totalBytes - (o.headroomBytes ?? HEADROOM_BYTES)) / o.perFlopBytes);
  return Math.max(1, Math.min(cores, fit));
}

/**
 * Physical cores from Linux's CPU topology: the distinct `thread_siblings_list` (or `core_cpus_list`) values, one per
 * core whatever the SMT; null when there is nothing to count.
 */
export function physicalCoresFromSiblings(lists: readonly string[]): number | null {
  const set = new Set(lists.map((l) => l.trim()).filter(Boolean));
  return set.size || null;
}

// ───────────────────────── the workflow's selection ─────────────────────────

/**
 * The packs the workflow's runs cover when nobody dispatches one with other inputs: the fallbacks of `inputs.scenario`
 * and `inputs.count` in presolve.yml (scheduled runs use them, and every chained run passes them on). Every occurrence
 * must agree, so the worker never guesses between two.
 */
export function workflowSelection(yaml: string): { scenario: string; count: number } {
  const one = (name: string) => {
    const vals = [...yaml.matchAll(new RegExp(`inputs\\.${name}\\s*\\|\\|\\s*'([^']*)'`, "g"))].map((m) => m[1]);
    if (!vals.length) throw new Error(`presolve.yml has no "inputs.${name} || '...'" fallback`);
    if (new Set(vals).size > 1) throw new Error(`presolve.yml's fallbacks of inputs.${name} disagree: ${[...new Set(vals)].join(", ")}`);
    return vals[0];
  };
  const scenario = one("scenario").trim();
  const count = Number(one("count"));
  if (!scenario || !/^[a-z0-9,-]+$/.test(scenario)) throw new Error(`presolve.yml's scenario fallback "${scenario}" is not a pack list`);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`presolve.yml's count fallback is not a whole number ≥ 1`);
  return { scenario, count };
}
