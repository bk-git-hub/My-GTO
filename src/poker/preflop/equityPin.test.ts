import { describe, expect, it } from "vitest";
import { buildEquityTable, mergeEquityRows, mulberry32, type EquityTable } from "../pushfold";

// PR-0 (design §4.10): the equity table is built in SHARDS = 4 shards, shard k drawing its boards from
// mulberry32(1000 + k) for the rows a % 4 === k, whatever the machine's core count. The cached 12000-sample table
// (absent in a fresh clone, so not tested here) was built that way; this pins the scheme on the coarse sample count,
// so a change to SHARDS, the seeds, the row split or the sampler shows up before anyone regenerates a chart.

/** scripts/equity-cache.mjs is a plain Node script without type declarations. */
interface EquityCacheScript {
  SHARDS: number;
  buildEquityTableSharded(samples: number): Promise<EquityTable>;
  equityTableSha256(table: EquityTable): string;
}
// A non-literal specifier keeps tsc from resolving the script (vite.config.ts does the same for node:fs).
const SCRIPT: string = "../../../scripts/equity-cache.mjs";

/** The 150-sample table under the pinned scheme: sha256 of eq then cnt, little-endian float64. */
const PINNED_150 = "e2d2b90f9aad4bdc73abf19574094a4e33f258a48d68afc59092ee3c5cee6284";

/** equityTableSha256's definition, written out with WebCrypto. */
async function tableSha256(t: EquityTable): Promise<string> {
  const view = new DataView(new ArrayBuffer(8 * (t.eq.length + t.cnt.length)));
  let o = 0;
  for (const part of [t.eq, t.cnt])
    for (const v of part) {
      view.setFloat64(o, v, true);
      o += 8;
    }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view.buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("equity table shard pin (PR-0)", { timeout: 60_000 }, () => {
  it("the shard scheme replayed in process gives the pinned table", async () => {
    const shard = (k: number) => (a: number) => a % 4 === k;
    const parts = [0, 1, 2, 3].map((k) => ({ eq: buildEquityTable(150, mulberry32(1000 + k), shard(k)).eq, rows: shard(k) }));
    const table = mergeEquityRows(parts, buildEquityTable(1, mulberry32(1), () => false).cnt);
    expect(await tableSha256(table)).toBe(PINNED_150);
  });

  it(
    "scripts/equity-cache.mjs builds that table with 4 shards and hashes it the same way",
    async () => {
      const script = (await import(/* @vite-ignore */ SCRIPT)) as EquityCacheScript;
      expect(script.SHARDS).toBe(4);
      const table = await script.buildEquityTableSharded(150);
      expect(script.equityTableSha256(table)).toBe(PINNED_150);
      expect(await tableSha256(table)).toBe(PINNED_150);
    },
    60_000,
  );
});
