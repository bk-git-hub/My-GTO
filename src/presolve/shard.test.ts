import { describe, expect, it } from "vitest";
import { FLOPS_BY_PRIORITY } from "./flops";
import { parseShard, shardFlops, shardOf, WHOLE } from "./shard";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("presolve shards", () => {
  it("parses <i>/<n> and rejects anything else", () => {
    expect(parseShard("0/1")).toEqual({ index: 0, count: 1 });
    expect(parseShard("3/8")).toEqual({ index: 3, count: 8 });
    expect(parseShard(" 7 / 8 ")).toEqual({ index: 7, count: 8 });
    for (const bad of ["", "8/8", "9/8", "0/0", "-1/4", "1.5/4", "1/2.5", "a/b", "3", "1/2/3", "1 2"])
      expect(() => parseShard(bad), bad).toThrow(/--shard/);
  });

  it("without a shard covers the first --count flops in order", () => {
    expect(shardFlops(FLOPS_BY_PRIORITY, 100)).toEqual(FLOPS_BY_PRIORITY.slice(0, 100));
    expect(shardFlops(FLOPS_BY_PRIORITY, 100, WHOLE)).toEqual(FLOPS_BY_PRIORITY.slice(0, 100));
    expect(shardFlops(FLOPS_BY_PRIORITY, 5000)).toEqual([...FLOPS_BY_PRIORITY]);
    expect(shardFlops(FLOPS_BY_PRIORITY, 0)).toEqual([]);
  });

  it("puts every flop in exactly one shard, by its index in the full priority order, keeping the order", () => {
    const keys = FLOPS_BY_PRIORITY.map((f) => f.key);
    for (const n of [1, 2, 3, 7, 8, 20]) {
      const seen = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        const part = shardFlops(keys, keys.length, { index: i, count: n });
        // In priority order, and each flop's shard is its full-list index mod n.
        const idx = part.map((k) => keys.indexOf(k));
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
        for (const k of idx) expect(shardOf(k, n)).toBe(i);
        for (const k of part) {
          expect(seen.has(k), `${k} in two shards`).toBe(false);
          seen.set(k, i);
        }
      }
      expect(seen.size).toBe(keys.length);
    }
  });

  it("splits the first --count flops, also when --count is smaller than the shard count", () => {
    const order = range(1755);
    const n = 8;
    expect(shardFlops(order, 20, { index: 0, count: n })).toEqual([0, 8, 16]);
    expect(shardFlops(order, 20, { index: 3, count: n })).toEqual([3, 11, 19]);
    expect(shardFlops(order, 20, { index: 7, count: n })).toEqual([7, 15]);
    const four = range(n).map((i) => shardFlops(order, 4, { index: i, count: n }));
    expect(four).toEqual([[0], [1], [2], [3], [], [], [], []]);
    expect(four.flat().sort((a, b) => a - b)).toEqual(range(4));
    // The union over all shards is exactly the unsharded --count prefix.
    for (const count of [1, 4, 8, 9, 100, 1755]) {
      const all = range(n).flatMap((i) => shardFlops(order, count, { index: i, count: n }));
      expect(all.sort((a, b) => a - b)).toEqual(order.slice(0, count));
    }
  });

  it("does not depend on which flops are already solved", () => {
    // The script filters the files on disk out after sharding, so a flop never moves to another shard.
    const order = range(40);
    const onDisk = new Set([0, 1, 2, 5, 13, 21]);
    const todo = shardFlops(order, 40, { index: 1, count: 4 }).filter((k) => !onDisk.has(k));
    expect(todo).toEqual([9, 17, 25, 29, 33, 37]);
  });
});
