/**
 * Splitting the presolve work across parallel jobs (`scripts/presolve.mjs --shard <i>/<n>`).
 *
 * Flop k of the priority order (its index in the full FLOPS_BY_PRIORITY list, not in a job's todo list)
 * belongs to shard k % n. The assignment depends only on the order, never on which files exist, so shards
 * started from the same commit solve disjoint flops whatever each one finds on disk, and every shard works
 * through its flops in priority order (the first flops of each shard together are the first flops overall).
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
