// Shared by the Nash scripts: the 169x169 all-in equity table, built on all CPUs
// and cached in node_modules/.cache (about 40s to rebuild on 4 cores).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { runnerImport } from "vite";

const root = new URL("..", import.meta.url).pathname;
export const load = async (p) => (await runnerImport(root + p)).module;
export const SAMPLES = 12000;

if (!isMainThread && workerData?.equityRows) {
  const { buildEquityTable, mulberry32 } = await load("src/poker/pushfold.ts");
  const { k, workers } = workerData;
  const t = buildEquityTable(SAMPLES, mulberry32(1000 + k), (a) => a % workers === k);
  parentPort.postMessage(t.eq.buffer, [t.eq.buffer]);
}

export async function loadEquityTable() {
  const pf = await load("src/poker/pushfold.ts");
  const cacheDir = root + "node_modules/.cache";
  const cacheFile = `${cacheDir}/pubaj-equity-${SAMPLES}.json`;
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    console.log("equity table: cached");
    return { eq: Float64Array.from(c.eq), cnt: Float64Array.from(c.cnt) };
  }
  const workers = Math.max(1, cpus().length);
  const t0 = Date.now();
  const parts = await Promise.all(
    Array.from({ length: workers }, (_, k) =>
      new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { equityRows: true, k, workers } });
        w.once("message", (buf) => resolve({ eq: new Float64Array(buf), rows: (a) => a % workers === k }));
        w.once("error", reject);
      }),
    ),
  );
  const cnt = pf.buildEquityTable(1, pf.mulberry32(1), () => false).cnt;
  const table = pf.mergeEquityRows(parts, cnt);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ eq: [...table.eq], cnt: [...table.cnt] }));
  console.log(`equity table: ${((Date.now() - t0) / 1000).toFixed(0)}s on ${workers} workers`);
  return table;
}
