/**
 * Splitting the presolve work across parallel jobs (`scripts/presolve.mjs --shard <i>/<n>`).
 *
 * Flop k of the priority order (its index in the full FLOPS_BY_PRIORITY list, not in a job's todo list)
 * belongs to shard k % n. The assignment depends only on the order, never on which files exist, so shards
 * started from the same commit solve disjoint flops whatever each one finds on disk, and every shard works
 * through its flops in priority order (the first flops of each shard together are the first flops overall).
 *
 * A machine outside the workflow (scripts/presolve-worker.mjs) takes the same queue from the other end (`--order
 * reverse`): the shards work front to back, the worker back to front, both skipping what is already solved, so neither
 * needs to claim a flop and the two meet once the queue is done.
 */

export interface Shard {
  /** 0-based shard number, below `count`. */
  index: number;
  /** Number of shards (≥ 1). */
  count: number;
}

/** The whole priority order in one shard: what a run without `--shard` does. */
export const WHOLE: Shard = { index: 0, count: 1 };

/** Parses `"<i>/<n>"` (e.g. `"3/8"`); throws on anything else, including i ≥ n. */
export function parseShard(text: string): Shard {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!m || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index >= count)
    throw new Error(`--shard must be <i>/<n> with 0 ≤ i < n, e.g. 0/8 (got "${text}")`);
  return { index, count };
}

/** The shard that flop `k` of the priority order belongs to. */
export function shardOf(k: number, count: number): number {
  return k % count;
}

/**
 * The flops of `shard` among the first `limit` of `order`, in order: the flops a shard covers with
 * `--count <limit>`. With fewer flops than shards some shards get none.
 */
export function shardFlops<T>(order: readonly T[], limit: number, shard: Shard = WHOLE): T[] {
  const out: T[] = [];
  const end = Math.min(order.length, Math.max(0, Math.floor(limit)));
  for (let k = shard.index; k < end; k += shard.count) out.push(order[k]);
  return out;
}

/**
 * Which end of the queue a run starts from: "priority" (front to back: the workflow's shards, and the default) or
 * "reverse" (back to front: the presolve worker on someone's own machine).
 */
export type JobOrder = "priority" | "reverse";

/** Parses `--order`; throws on anything but the two orders. */
export function parseOrder(text: string): JobOrder {
  if (text === "priority" || text === "reverse") return text;
  throw new Error(`--order must be priority or reverse (got "${text}")`);
}

/**
 * The order a run solves its flops in: the packs' lists of missing flops (each in priority order) grouped by the packs'
 * `queue` value, lower first; within a group the lists are interleaved, one flop of each pack in turn, in the order
 * given. With every pack at the same value this is the plain interleave the job has always used, so the app's packs and
 * the first calibration packs (all 0) keep their order, and a queue of packs (1, 2, ...) is solved one pack after the
 * other, each shard working through its share of a pack before it starts the next. `"reverse"` gives exactly the same
 * jobs back to front (the last flop of the last pack first), so a run in each order over the same lists only meets the
 * other at the end.
 */
export function jobQueue<T>(lists: readonly { queue: number; jobs: readonly T[] }[], order: JobOrder = "priority"): T[] {
  const ranks = [...new Set(lists.map((l) => l.queue))].sort((a, b) => a - b);
  const out: T[] = [];
  for (const r of ranks) {
    const group = lists.filter((l) => l.queue === r).map((l) => l.jobs);
    for (let i = 0; group.some((l) => i < l.length); i++) for (const l of group) if (i < l.length) out.push(l[i]);
  }
  return order === "reverse" ? out.reverse() : out;
}
