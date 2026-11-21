// Shared by the Nash and preflop scripts: the 169x169 all-in equity table, built in SHARDS seeded shards
// and cached in node_modules/.cache (about 40s to rebuild on 4 cores).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { runnerImport } from "vite";

// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/...", and it keeps %-escapes (spaces, Korean folder
// names) that the file system doesn't know. `load` hands vite a native absolute path, as vite does with its own config.
const root = fileURLToPath(new URL("..", import.meta.url));
export const load = async (p) => (await runnerImport(join(root, p))).module;
export const SAMPLES = 12000;

/**
 * Number of shards the table is built in. Shard k owns rows a % SHARDS === k and draws its boards from
 * mulberry32(1000 + k), so the numbers depend on SHARDS. It used to be the CPU count, which made every chart
 * built from the table depend on the machine; the cached table was built with 4, so 4 it stays. A machine with
 * fewer cores runs the shards in sequence and gets the same table.
 */
export const SHARDS = 4;

if (!isMainThread && workerData?.equityRows) {
  const { buildEquityTable, mulberry32 } = await load("src/poker/pushfold.ts");
  const { k, workers, samples } = workerData;
  const t = buildEquityTable(samples, mulberry32(1000 + k), (a) => a % workers === k);
  parentPort.postMessage(t.eq.buffer, [t.eq.buffer]);
}

/** Builds the table from scratch (no cache involved): SHARDS shards on at most one worker per CPU. */
export async function buildEquityTableSharded(samples = SAMPLES) {
  const pf = await load("src/poker/pushfold.ts");
  const runShard = (k) =>
    new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { equityRows: true, k, workers: SHARDS, samples } });
      w.once("message", (buf) => resolve({ eq: new Float64Array(buf), rows: (a) => a % SHARDS === k }));
      w.once("error", reject);
    });
  const queue = Array.from({ length: SHARDS }, (_, k) => k);
  const parts = [];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(SHARDS, cpus().length)) }, async () => {
      while (queue.length) parts.push(await runShard(queue.shift()));
    }),
  );
  // The rows of the shards are disjoint, so the order in which they finish does not matter.
  const cnt = pf.buildEquityTable(1, pf.mulberry32(1), () => false).cnt;
  return pf.mergeEquityRows(parts, cnt);
}

export async function loadEquityTable() {
  const cacheDir = root + "node_modules/.cache";
  const cacheFile = `${cacheDir}/pubaj-equity-${SAMPLES}.json`;
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    console.log("equity table: cached");
    return { eq: Float64Array.from(c.eq), cnt: Float64Array.from(c.cnt) };
  }
  const t0 = Date.now();
  const table = await buildEquityTableSharded(SAMPLES);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ eq: [...table.eq], cnt: [...table.cnt] }));
  console.log(`equity table: ${((Date.now() - t0) / 1000).toFixed(0)}s, ${SHARDS} shards`);
  return table;
}

/**
 * sha256 (hex) of a table's data: eq then cnt, each value as a little-endian float64. Generated data records
 * it, so a chart can always be traced to the exact table it was solved on.
 */
export function equityTableSha256(table) {
  const { eq, cnt } = table;
  const buf = Buffer.alloc(8 * (eq.length + cnt.length));
  let o = 0;
  for (const v of eq) o = buf.writeDoubleLE(v, o);
  for (const v of cnt) o = buf.writeDoubleLE(v, o);
  return createHash("sha256").update(buf).digest("hex");
}
