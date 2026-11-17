// Fits the postflop realization model of the preflop solver to our own flop packs and writes
// src/poker/preflop/eqrFit.ts (design: model B, §3.4 and §3.7 of the preflop solver design, docs/preflop-solver.md).
//
// Usage: node scripts/fit-realization.mjs [--check] [--workers <n>] [--packs <id,id,...>] [--limit <n>]
//   --check        compute everything and compare with the committed eqrFit.ts; write nothing, exit 1 if it differs
//   --workers <n>  flop files decoded and enumerated in parallel (default: one per CPU); the result does not depend on it
//   --packs <ids>  fit on these packs of the manifest only, comma-separated ids, or "all" for every pack in the manifest.
//                  Default: the packs the committed eqrFit.ts was fitted on (every pack in the manifest if it names none
//                  or names one the manifest lacks), so a new pack in the manifest, such as pub-srp-utg-bb-55, kept out
//                  of the fit on purpose (docs/preflop-solver.md §3.7), does not silently enter a bare run or --check.
//                  The rest of the run is unchanged: the pack records, metrics and fit hash name only the packs used,
//                  and --check compares that fit with the committed file. An unknown id is an error.
//   --limit <n>    development only: use the first n files of each pack, print the fit and write nothing
//
// What it does:
// 1. For every flop file of every pack fitted (the --packs ones of public/packs/manifest.json, or the default above):
//    decode it with the app's decoder, read each combo's EV at OOP's root (node []) and at IP's first decision after
//    OOP checks (node [check]), and compute each combo's flop equity against the opponent's stored range by full turn
//    and river enumeration. The packs give OOP no flop bet, so IP's node after the check is IP's root; the script
//    asserts OOP checks at least MIN_CHECK of its reach-weighted range, since IP's root EV is not stored otherwise.
// 2. Per pack, side and hand class, with w = node weight × file weight: share = Σ w·EV / Σ w / pot (a pack's EV is
//    what the combo gets out of the flop pot) and e = Σ w·equity / Σ w. Every class with Σ w > 0 is a row.
// 3. Fits four forms by weighted least squares with ridge RIDGE on every fitted parameter, rows of all packs jointly;
//    a row's weight is its Σ w normalized so each side of each pack sums to 1, times the pack's flop count:
//    - model B, all 9 features, α held at ALPHA_PRIOR (shipped):
//                                       OOP row h: share − e = α(e − ½) + c + θ_O·F(h) − θ_I·E_x[F(x)]
//                                       IP row x:  share − e = α(e − ½) − c + θ_I·F(x) − θ_O·E_h[F(h)]
//      with α(e − ½) moved into the offset, so only c, θ_O and θ_I are fitted;
//    - model B on the first 3 features (pair, suited, hi2f5), α held (sensitivity solve c);
//    - model B, all 9 features, α fitted too (alphaFree: a diagnostic, recorded for provenance);
//    - the equity-scaled surplus form, all 9 features (sensitivity solve d), R(h) = r0 + θ·F(h):
//                                       OOP row h: share = R_O(h)·e − E_x[(R_I(x) − 1)(1 − eq[h,x])], IP mirrored.
//    E is over the opponent's pack range (its manifest range string) with card removal through the equity table's
//    cnt, the same pairwise model the preflop engine uses; F is src/poker/preflop/features.ts (rank features and the
//    ace, wheel and suited-connectivity indicators, centered on the combo-weighted means).
// 4. Metrics per fit: R² and RMS of the per-class pot share per side, the cash → pub transfer RMS (fit on the cash
//    packs alone, predict the pub packs) next to the pub packs' own refit (the noise floor), and a 2-fold flop-split
//    cross-validation RMS (flops split by even and odd index in FLOPS_BY_PRIORITY, so a flop is in the same fold in
//    every pack). The R², RMS and per-pack metrics written score the parameters as written (rounded and rebuilt from
//    their fields), so they describe the stored values.
// 5. κ_3 and κ_4 (design §3.6): per class, the Monte Carlo k-way pot share over the product of its pairwise
//    equities, from KAPPA_DEALS seeded deals per k against fixed reference ranges.
// Every sum runs in a fixed order, so the output depends only on the packs and the equity table.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { equityTableSha256, load, loadEquityTable } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const OUT = "src/poker/preflop/eqrFit.ts";
const N = 169;
const RIDGE = 1e-4;
// α of model B is held at this prior: the 5-feature fit's α (pair, suited, bway, conn, weakAce; fit 45018e13c176).
// With the rank features the class rows pin α down only weakly. Freed on the 9 features and the 1,755 + 1,755 flops
// of the BTN packs (fit 2862daa7a90f), every subset puts it below 0 (joint −0.187, cash −0.176, pub −0.321, the two CV
// training folds −0.090 and −0.201), and the CV RMS is 0.0163 / 0.0136 free against 0.0166 / 0.0183 held (OOP / IP:
// holding costs IP about 0.005). Against the strong range of the held-out UTG pack the effective α is about 0.27 OOP
// and −0.21 IP, so no single α fits both contexts (docs §3.7, bias 2). α decides the low-SPR 4-bet / jam split (§3.4),
// so 0.553 is held deliberately, as a named prior, until a 3-bet-pot or ghost-combo calibration pack measures it.
const ALPHA_PRIOR = 0.553;
const MIN_CHECK = 0.999;
// Design §3.6 budgeted 200k deals per k, but that is about 1,183 deals per class and leaves each κ with a 5–7%
// relative standard error (single classes off by up to 17% against an independent Monte Carlo), more than the
// 0.011-of-the-pot accuracy κ is there to buy. 2M deals (about 11,800 per class, about 5 s for both tables) bring
// it to about 2%.
const KAPPA_DEALS = 2_000_000;
// Reference ranges: the top fraction of classes ranked by heads-up equity against a random hand, one per seat
// (design §3.6). The hero takes every seat in turn and the other seats are dealt from their ranges.
const KAPPA = {
  3: { seed: 303, ranges: [0.3, 0.2, 0.5] },
  4: { seed: 404, ranges: [0.3, 0.2, 0.5, 0.2] },
};

// ───────────────────────── worker: one flop file ─────────────────────────

if (!isMainThread && workerData?.eqrFit) {
  const { decodeFlopFile } = await load("src/presolve/format.ts");
  const { COMBOS } = await load("src/play/handInfo.ts");
  const { evaluate } = await load("src/poker/evaluator.ts");
  const { ALL_HANDS } = await load("src/poker/cards.ts");
  const HIDX = new Map(ALL_HANDS.map((h, i) => [h, i]));
  const C1 = Int32Array.from(COMBOS, (c) => c.cards[0]);
  const C2 = Int32Array.from(COMBOS, (c) => c.cards[1]);
  const CLS = Int32Array.from(COMBOS, (c) => HIDX.get(c.hand));

  // Scratch for the sweeps, allocated once.
  const cardW = new Float64Array(52), grpCard = new Float64Array(52), cumCard = new Float64Array(52);

  /**
   * One pass over a runout's live combos sorted by strength: for every combo i with me[i] > 0, adds to num[i] the
   * opponent weight it beats (ties half) and to den[i] the opponent weight compatible with it. Card removal: an
   * opponent combo sharing a card with i is left out, through per-card weight totals; only i itself shares both.
   */
  function sweep(L, n, str, opp, me, num, den) {
    cardW.fill(0);
    cumCard.fill(0);
    let tot = 0;
    for (let k = 0; k < n; k++) {
      const i = L[k], w = opp[i];
      if (w) (tot += w), (cardW[C1[i]] += w), (cardW[C2[i]] += w);
    }
    let cum = 0;
    for (let g = 0; g < n; ) {
      let e = g;
      while (e < n && str[L[e]] === str[L[g]]) e++;
      let gt = 0;
      for (let k = g; k < e; k++) {
        const i = L[k], w = opp[i];
        if (w) (gt += w), (grpCard[C1[i]] += w), (grpCard[C2[i]] += w);
      }
      for (let k = g; k < e; k++) {
        const i = L[k];
        if (!me[i]) continue;
        const a = C1[i], b = C2[i];
        num[i] += cum - cumCard[a] - cumCard[b] + (gt - grpCard[a] - grpCard[b] + opp[i]) / 2;
        den[i] += tot - cardW[a] - cardW[b] + opp[i];
      }
      for (let k = g; k < e; k++) {
        const i = L[k], w = opp[i];
        if (w) (cumCard[C1[i]] += w), (cumCard[C2[i]] += w), (grpCard[C1[i]] = 0), (grpCard[C2[i]] = 0);
      }
      cum += gt;
      g = e;
    }
  }

  /** Flop equity of every combo of each player against the other's weights, over all turn and river cards. */
  function flopEquities(board, w0, w1) {
    const used = new Uint8Array(52);
    for (const c of board) used[c] = 1;
    const live = [];
    for (let i = 0; i < 1326; i++) if (!used[C1[i]] && !used[C2[i]] && (w0[i] > 0 || w1[i] > 0)) live.push(i);
    const num = [new Float64Array(1326), new Float64Array(1326)];
    const den = [new Float64Array(1326), new Float64Array(1326)];
    const str = new Float64Array(1326);
    const L = new Int32Array(live.length);
    const cards = new Int32Array(7);
    cards[2] = board[0];
    cards[3] = board[1];
    cards[4] = board[2];
    for (let t = 0; t < 52; t++) {
      if (used[t]) continue;
      for (let r = t + 1; r < 52; r++) {
        if (used[r]) continue;
        cards[5] = t;
        cards[6] = r;
        let n = 0;
        for (const i of live) {
          if (C1[i] === t || C1[i] === r || C2[i] === t || C2[i] === r) continue;
          cards[0] = C1[i];
          cards[1] = C2[i];
          str[i] = evaluate(cards, 7);
          L[n++] = i;
        }
        L.subarray(0, n).sort((a, b) => str[a] - str[b]);
        sweep(L, n, str, w1, w0, num[0], den[0]);
        sweep(L, n, str, w0, w1, num[1], den[1]);
      }
    }
    return [0, 1].map((p) => Float64Array.from(num[p], (v, i) => (den[p][i] > 0 ? v / den[p][i] : NaN)));
  }

  function extract({ path, weight, sha256, scenario, pot }) {
    const bytes = readFileSync(root + "public/packs/" + path);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha256) throw new Error(`${path}: sha256 ${got} does not match the manifest`);
    const flop = decodeFlopFile(JSON.parse(bytes.toString("utf8")));
    if (flop.scenario !== scenario || Math.abs(flop.pot - pot) > 1e-9) throw new Error(`${path}: scenario or pot differs from the manifest`);
    const rootNode = flop.node([]);
    const check = rootNode.actions.findIndex((a) => a.kind === "check");
    if (check < 0) throw new Error(`${path}: OOP has no check at the root`);
    let tw = 0, cw = 0;
    for (let j = 0; j < rootNode.combos.length; j++) (tw += rootNode.weight[j]), (cw += rootNode.weight[j] * rootNode.strategy[check][j]);
    const ipNode = flop.node([check]);
    if (!ipNode || ipNode.player !== 1) throw new Error(`${path}: no IP node after OOP's check`);
    const eqs = flopEquities(flop.board, flop.ranges[0], flop.ranges[1]);
    const sides = [rootNode, ipNode].map((node, side) => {
      const wEv = new Float64Array(N), wEq = new Float64Array(N), w = new Float64Array(N);
      for (let j = 0; j < node.combos.length; j++) {
        const ww = node.weight[j] * weight;
        if (!(ww > 0)) continue;
        const ci = node.combos[j];
        let ev = 0;
        for (let a = 0; a < node.actions.length; a++) {
          const p = node.strategy[a][j];
          if (!(p > 0)) continue;
          const v = node.ev[a][j];
          if (!Number.isFinite(v)) throw new Error(`${path}: no EV for ${node.actions[a].kind} at node [${node.path}]`);
          ev += p * v;
        }
        const e = eqs[side][ci];
        if (!Number.isFinite(e)) throw new Error(`${path}: no equity for combo ${ci}`);
        const c = CLS[ci];
        wEv[c] += ww * ev;
        wEq[c] += ww * e;
        w[c] += ww;
      }
      return { wEv, wEq, w };
    });
    return { board: flop.boardKey, check: cw / tw, sides };
  }

  parentPort.on("message", (job) => {
    if (job === null) return parentPort.close();
    parentPort.postMessage({ key: job.key, ...extract(job) });
  });
  parentPort.postMessage({ ready: true });
}

// ───────────────────────── main ─────────────────────────

if (isMainThread) {
  const { values: opt } = parseArgs({
    options: { check: { type: "boolean", default: false }, workers: { type: "string" }, packs: { type: "string" }, limit: { type: "string" } },
  });
  const limit = opt.limit ? Number(opt.limit) : Infinity;
  const T0 = Date.now();
  const { ALL_HANDS, comboCount, combosOf } = await load("src/poker/cards.ts");
  const { parseRange } = await load("src/poker/range.ts");
  const { FLOPS_BY_PRIORITY } = await load("src/presolve/flops.ts");
  const { FEATURE_NAMES, handFeatures } = await load("src/poker/preflop/features.ts");
  const { evaluate } = await load("src/poker/evaluator.ts");
  const { mulberry32 } = await load("src/poker/pushfold.ts");
  const table = await loadEquityTable();
  const { eq, cnt } = table;
  const F = Array.from({ length: N }, (_, h) => handFeatures(h));
  const K = FEATURE_NAMES.length;
  const manifest = JSON.parse(readFileSync(root + "public/packs/manifest.json", "utf8"));
  if (opt.packs === undefined) {
    // Default: the committed fit's packs (see --packs above).
    let committed = [];
    try {
      committed = Object.keys((await load(OUT)).EQR_FIT?.packs ?? {});
    } catch {
      committed = [];
    }
    const ids = manifest.packs.map((p) => p.id);
    if (committed.length && committed.every((id) => ids.includes(id))) {
      opt.packs = committed.join(",");
      const left = ids.filter((id) => !committed.includes(id));
      console.log(`packs: ${committed.join(", ")} (the committed fit's)${left.length ? `; not in the fit: ${left.join(", ")} (--packs all to include)` : ""}`);
    } else opt.packs = "all";
  }
  if (opt.packs === "all") opt.packs = manifest.packs.map((p) => p.id).join(",");
  {
    // The packs to fit (--packs, or the default above): the named packs only, in manifest order (so the sums and the output keep the manifest's order).
    const want = opt.packs.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(manifest.packs.map((p) => p.id));
    const unknown = want.filter((id) => !known.has(id));
    if (!want.length || unknown.length) {
      console.error(`--packs: ${want.length ? `unknown pack id(s) ${unknown.join(", ")}` : "no pack ids"}; the manifest has ${[...known].join(", ")}`);
      process.exit(2);
    }
    manifest.packs = manifest.packs.filter((p) => want.includes(p.id));
  }
  for (const pack of manifest.packs) pack.files = pack.files.slice(0, limit);
  const prio = new Map(FLOPS_BY_PRIORITY.map((f, i) => [f.key, i]));

  // ── 1. per-file extraction on a worker pool; results kept by file so every sum below runs in manifest order ──
  const jobs = [];
  manifest.packs.forEach((pack, p) =>
    pack.files.forEach((f, k) => jobs.push({ key: `${p}:${k}`, path: f.path, weight: f.weight, sha256: f.sha256, scenario: pack.id, pot: pack.scenario.pot })),
  );
  const nWorkers = Math.max(1, Math.min(jobs.length, opt.workers ? Number(opt.workers) : cpus().length));
  const results = new Map();
  const tx = Date.now();
  let next = 0, done = 0;
  const pool = [];
  await Promise.all(
    Array.from({ length: nWorkers }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { eqrFit: true } });
        pool.push(w);
        const feed = () => w.postMessage(next < jobs.length ? jobs[next++] : null);
        w.on("message", (m) => {
          if (!m.ready) {
            results.set(m.key, m);
            if (++done % 100 === 0 || done === jobs.length) console.log(`  flops ${done}/${jobs.length}, ${((Date.now() - tx) / 1000).toFixed(0)}s`);
          }
          feed();
        });
        w.once("error", reject);
        w.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
      }),
    ),
  ).catch((e) => {
    // A bad file must stop the run: the other workers would otherwise keep the process alive.
    console.error(e);
    for (const w of pool) w.terminate();
    process.exit(1);
  });
  const extractSeconds = (Date.now() - tx) / 1000;
  console.log(`extraction: ${jobs.length} flop files on ${nWorkers} workers, ${extractSeconds.toFixed(1)}s`);

  // ── 2. per-class aggregates: per pack, and per pack and fold ──
  const zero = () => [0, 1].map(() => ({ wEv: new Float64Array(N), wEq: new Float64Array(N), w: new Float64Array(N) }));
  const addInto = (dst, src) => {
    for (let s = 0; s < 2; s++) for (const k of ["wEv", "wEq", "w"]) for (let c = 0; c < N; c++) dst[s][k][c] += src[s][k][c];
  };
  const packs = manifest.packs.map((pack, p) => {
    const all = zero(), folds = [zero(), zero()], foldFlops = [0, 0];
    let minCheck = 1;
    pack.files.forEach((_, k) => {
      const r = results.get(`${p}:${k}`);
      const idx = prio.get(r.board);
      if (idx === undefined) throw new Error(`${pack.id}: board ${r.board} is not in FLOPS_BY_PRIORITY`);
      if (r.check < MIN_CHECK) throw new Error(`${pack.id} ${r.board}: OOP checks only ${r.check.toFixed(4)} at the root; IP's root EV is not stored`);
      minCheck = Math.min(minCheck, r.check);
      addInto(all, r.sides);
      addInto(folds[idx % 2], r.sides);
      foldFlops[idx % 2]++;
    });
    const range = (s) => {
      const r = parseRange(pack.scenario.ranges[s]);
      return Float64Array.from(ALL_HANDS, (h) => r[h] ?? 0);
    };
    // Expectations over the opponent's range given my class, with card removal through cnt.
    const opp = [range(1), range(0)];
    const cond = [0, 1].map((s) =>
      Array.from({ length: N }, (_, h) => {
        let EF = new Float64Array(K), E1e = 0, Ex1e = new Float64Array(K), tot = 0;
        for (let x = 0; x < N; x++) {
          const k = cnt[h * N + x] * opp[s][x];
          if (!k) continue;
          tot += k;
          const q = 1 - eq[h * N + x];
          E1e += k * q;
          for (let j = 0; j < K; j++) (EF[j] += k * F[x][j]), (Ex1e[j] += k * F[x][j] * q);
        }
        EF = EF.map((v) => v / tot);
        Ex1e = Ex1e.map((v) => v / tot);
        return { EF: [...EF], E1e: E1e / tot, Ex1e: [...Ex1e] };
      }),
    );
    const filesSha256 = createHash("sha256").update(pack.files.map((f) => `${f.path} ${f.sha256}\n`).join("")).digest("hex");
    return { id: pack.id, version: pack.version, format: pack.scenario.format, pot: pack.scenario.pot, stack: pack.scenario.stack, flops: pack.files.length, all, folds, foldFlops, minCheck, opp, cond, filesSha256 };
  });

  /** Rows of one pack from one aggregate, with weights normalized per side and scaled by `flops`. */
  function rowsOf(pk, agg, flops) {
    const rows = [];
    for (let s = 0; s < 2; s++) {
      const a = agg[s];
      let W = 0;
      for (let c = 0; c < N; c++) W += a.w[c];
      for (let c = 0; c < N; c++) {
        if (!(a.w[c] > 0)) continue;
        rows.push({ pack: pk.id, side: s, h: c, e: a.wEq[c] / a.w[c], share: a.wEv[c] / a.w[c] / pk.pot, w: (a.w[c] / W) * flops, ...pk.cond[s][c] });
      }
    }
    return rows;
  }

  // ── 3. the four forms, each linear in its parameters ──
  const MODELS = {
    modelB9: { k: K, form: "modelB", alpha: "held" },
    modelB3: { k: 3, form: "modelB", alpha: "held" },
    modelB9Free: { k: K, form: "modelB", alpha: "free" },
    product: { k: K, form: "product" },
  };
  /** Design row x and offset: prediction = offset + x·β. */
  function design(model, rw) {
    const { k, form, alpha } = MODELS[model];
    const f = F[rw.h].slice(0, k), EF = rw.EF.slice(0, k), me = rw.side === 0;
    if (form === "modelB") {
      const neg = EF.map((v) => -v);
      const rest = [me ? 1 : -1, ...(me ? f : neg), ...(me ? neg : f)];
      // Held α: β = [c, θ_O(k), θ_I(k)], α(e − ½) in the offset. Free α: β = [α, c, θ_O(k), θ_I(k)].
      if (alpha === "held") return { x: rest, off: rw.e + ALPHA_PRIOR * (rw.e - 0.5) };
      return { x: [rw.e - 0.5, ...rest], off: rw.e };
    }
    // β = [r_O0, θ_O(k), r_I0, θ_I(k)]: share = R_me·e − (R_opp0 − 1)·E[1 − eq] − θ_opp·E[F·(1 − eq)]
    const mine = [rw.e, ...f.map((v) => v * rw.e)];
    const theirs = [-rw.E1e, ...rw.Ex1e.slice(0, k).map((v) => -v)];
    return { x: me ? [...mine, ...theirs] : [...theirs, ...mine], off: rw.E1e };
  }
  /** Weighted least squares with ridge on every parameter (normal equations, Gaussian elimination with pivoting). */
  function fit(model, rows) {
    const D = rows.map((rw) => design(model, rw));
    const k = D[0].x.length;
    const A = Array.from({ length: k }, () => new Float64Array(k + 1));
    rows.forEach((rw, i) => {
      const { x, off } = D[i], y = rw.share - off;
      for (let p = 0; p < k; p++) {
        A[p][k] += rw.w * x[p] * y;
        for (let q = 0; q < k; q++) A[p][q] += rw.w * x[p] * x[q];
      }
    });
    for (let p = 0; p < k; p++) A[p][p] += RIDGE;
    for (let i = 0; i < k; i++) {
      let p = i;
      for (let j = i + 1; j < k; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      [A[i], A[p]] = [A[p], A[i]];
      for (let j = 0; j < k; j++) {
        if (j === i) continue;
        const m = A[j][i] / A[i][i];
        for (let q = i; q <= k; q++) A[j][q] -= m * A[i][q];
      }
    }
    return A.map((row, i) => row[k] / row[i]);
  }
  const predict = (model, beta, rw) => {
    const { x, off } = design(model, rw);
    return x.reduce((s, v, j) => s + v * beta[j], off);
  };
  /** Per side: weighted SSE, Σw, and the sums for R² of the share and of the gap share − e. */
  function errors(model, beta, rows) {
    return [0, 1].map((s) => {
      const rs = rows.filter((rw) => rw.side === s);
      let W = 0, ms = 0, mg = 0;
      for (const rw of rs) (W += rw.w), (ms += rw.w * rw.share), (mg += rw.w * (rw.share - rw.e));
      ms /= W;
      mg /= W;
      let sse = 0, sst = 0, sstGap = 0;
      for (const rw of rs) {
        sse += rw.w * (predict(model, beta, rw) - rw.share) ** 2;
        sst += rw.w * (rw.share - ms) ** 2;
        sstGap += rw.w * (rw.share - rw.e - mg) ** 2;
      }
      return { sse, W, sst, sstGap };
    });
  }
  const rmsOf = (err) => err.map((e) => Math.sqrt(e.sse / e.W));

  const ts = Date.now();
  const allRows = packs.flatMap((pk) => rowsOf(pk, pk.all, pk.flops));
  const cash = packs.filter((pk) => pk.format === "cash"), pub = packs.filter((pk) => pk.format === "pub");
  /** R², R² of the gap, RMS and the per-pack R² and RMS of parameters `beta` on the joint rows. */
  function jointMetrics(model, beta) {
    const err = errors(model, beta, allRows);
    const perPack = Object.fromEntries(
      packs.map((pk) => {
        const e = errors(model, beta, rowsOf(pk, pk.all, 1));
        return [pk.id, { r2: e.map((x) => 1 - x.sse / x.sst), rms: rmsOf(e) }];
      }),
    );
    return { r2: err.map((e) => 1 - e.sse / e.sst), r2Gap: err.map((e) => 1 - e.sse / e.sstGap), rms: rmsOf(err), perPack };
  }
  const fits = {};
  for (const model of Object.keys(MODELS)) {
    const beta = fit(model, allRows);
    let transferRms = null, transferRefitRms = null, cashOnly = null;
    if (cash.length && pub.length) {
      const train = cash.flatMap((pk) => rowsOf(pk, pk.all, pk.flops));
      const test = pub.flatMap((pk) => rowsOf(pk, pk.all, pk.flops));
      cashOnly = fit(model, train);
      transferRms = rmsOf(errors(model, cashOnly, test));
      transferRefitRms = rmsOf(errors(model, fit(model, test), test));
    }
    // 2-fold flop split: fit on one fold of every pack, score the other fold, pool both directions.
    const cv = [0, 1].map(() => ({ sse: 0, W: 0 }));
    for (let f = 0; f < 2; f++) {
      const train = packs.flatMap((pk) => rowsOf(pk, pk.folds[1 - f], pk.foldFlops[1 - f]));
      const test = packs.flatMap((pk) => rowsOf(pk, pk.folds[f], pk.foldFlops[f]));
      errors(model, fit(model, train), test).forEach((e, s) => ((cv[s].sse += e.sse), (cv[s].W += e.W)));
    }
    fits[model] = { beta, cashOnly, metrics: { ...jointMetrics(model, beta), transferRms, transferRefitRms, cvRms: rmsOf(cv) } };
  }
  const fitSeconds = (Date.now() - ts) / 1000;

  // ── 5. κ_3 and κ_4 ──
  const tk = Date.now();
  const combos = ALL_HANDS.map(combosOf);
  const vsRandom = ALL_HANDS.map((_, a) => {
    let m = 0, e = 0;
    for (let b = 0; b < N; b++) (m += cnt[a * N + b]), (e += cnt[a * N + b] * eq[a * N + b]);
    return e / m;
  });
  const order = [...ALL_HANDS.keys()].sort((a, b) => vsRandom[b] - vsRandom[a]);
  const top = (frac) => {
    const w = new Float64Array(N);
    let c = 0;
    for (const i of order) {
      if (c >= frac * 1326) break;
      w[i] = 1;
      c += comboCount(ALL_HANDS[i]);
    }
    return w;
  };
  /** The engine's pairwise equity of class h against range w: Σ cnt·w·eq / Σ cnt·w. */
  const pairEq = (h, w) => {
    let m = 0, e = 0;
    for (let x = 0; x < N; x++) {
      const k = cnt[h * N + x] * w[x];
      (m += k), (e += k * eq[h * N + x]);
    }
    return e / m;
  };
  function kappa(k) {
    const { seed, ranges } = KAPPA[k];
    const rand = mulberry32(seed);
    const R = ranges.map(top);
    const pe = R.map((w) => Float64Array.from({ length: N }, (_, h) => pairEq(h, w)));
    // Class samplers by combo weight.
    const cum = R.map((w) => {
      const c = new Float64Array(N);
      let s = 0;
      for (let i = 0; i < N; i++) c[i] = s += w[i] * comboCount(ALL_HANDS[i]);
      return c;
    });
    const pick = (t) => {
      const c = cum[t], x = rand() * c[N - 1];
      let i = 0;
      while (c[i] <= x) i++;
      const cs = combos[i];
      return cs[(rand() * cs.length) | 0];
    };
    const S = new Float64Array(N), S2 = new Float64Array(N), P = new Float64Array(N), n = new Float64Array(N);
    const used = new Uint8Array(52), cards = new Int32Array(7), hands = new Array(k), score = new Float64Array(k);
    for (let d = 0; d < KAPPA_DEALS; d++) {
      // Stratified: every class gets the same number of deals, spread evenly over the hero's seats.
      const h = d % N, seat = Math.floor(d / N) % k;
      used.fill(0);
      hands[seat] = combos[h][(rand() * combos[h].length) | 0];
      used[hands[seat][0]] = used[hands[seat][1]] = 1;
      let prod = 1;
      for (let t = 0; t < k; t++) {
        if (t === seat) continue;
        let c;
        do c = pick(t);
        while (used[c[0]] || used[c[1]]);
        used[c[0]] = used[c[1]] = 1;
        hands[t] = c;
        prod *= pe[t][h];
      }
      for (let b = 2; b < 7; b++) {
        let c;
        do c = (rand() * 52) | 0;
        while (used[c]);
        used[c] = 1;
        cards[b] = c;
      }
      let best = -Infinity, winners = 0;
      for (let t = 0; t < k; t++) {
        cards[0] = hands[t][0];
        cards[1] = hands[t][1];
        score[t] = evaluate(cards, 7);
        if (score[t] > best) (best = score[t]), (winners = 1);
        else if (score[t] === best) winners++;
      }
      const share = score[seat] === best ? 1 / winners : 0;
      S[h] += share;
      S2[h] += share * share;
      P[h] += prod;
      n[h]++;
    }
    const kap = Array.from({ length: N }, (_, h) => S[h] / P[h]);
    // Relative standard error of each κ from the spread of the per-deal shares (the products are exact).
    const rse = Array.from({ length: N }, (_, h) => {
      const m = S[h] / n[h];
      return Math.sqrt(Math.max(0, S2[h] / n[h] - m * m) / n[h]) / m;
    });
    return { kap, rse };
  }
  const k3 = kappa(3), k4 = kappa(4);
  const kappaSeconds = (Date.now() - tk) / 1000;

  // ── output ──
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const pair = (a) => (a ? a.map(r4) : null);
  // The joint-fit metrics written (R², R² of the gap, RMS, per pack) score the parameters as written: rounded, sliced
  // into their fields and rebuilt into β from those fields. So they describe the stored values, and a slip in the
  // slicing or the field order below shows up in them (features.test.ts bounds them). The transfer and CV metrics
  // come from fits that are not written.
  const metricsOut = (model, written) => {
    const m = { ...fits[model].metrics, ...jointMetrics(model, written) };
    return {
      r2: pair(m.r2),
      r2Gap: pair(m.r2Gap),
      rms: pair(m.rms),
      perPack: Object.fromEntries(Object.entries(m.perPack).map(([id, v]) => [id, { r2: pair(v.r2), rms: pair(v.rms) }])),
      transferRms: pair(m.transferRms),
      transferRefitRms: pair(m.transferRefitRms),
      cvRms: pair(m.cvRms),
    };
  };
  /** β of a written model B record (its fields, in the design's order). */
  const betaOfModelB = (model, o) => (MODELS[model].alpha === "held" ? [o.cFit, ...o.thetaO, ...o.thetaI] : [o.alpha, o.cFit, ...o.thetaO, ...o.thetaI]);
  const modelB = (model) => {
    const { k, alpha } = MODELS[model], b = fits[model].beta.map(r6);
    const out = alpha === "held" ? { alpha: ALPHA_PRIOR, cFit: b[0], thetaO: b.slice(1, 1 + k), thetaI: b.slice(1 + k) } : { alpha: b[0], cFit: b[1], thetaO: b.slice(2, 2 + k), thetaI: b.slice(2 + k) };
    return { form: "modelB", features: FEATURE_NAMES.slice(0, k), ...out, metrics: metricsOut(model, betaOfModelB(model, out)) };
  };
  const b9 = modelB("modelB9");
  const pb = fits.product.beta.map(r6);
  const product = {
    form: "product",
    features: [...FEATURE_NAMES],
    rO0: pb[0],
    thetaO: pb.slice(1, 1 + K),
    rI0: pb[1 + K],
    thetaI: pb.slice(2 + K),
    rO: F.map((f) => r6(pb[0] + f.reduce((s, v, j) => s + v * pb[1 + j], 0))),
    rI: F.map((f) => r6(pb[1 + K] + f.reduce((s, v, j) => s + v * pb[2 + K + j], 0))),
    metrics: null,
  };
  product.metrics = metricsOut("product", [product.rO0, ...product.thetaO, product.rI0, ...product.thetaI]);
  const body = {
    model: "modelB-rank9",
    features: [...FEATURE_NAMES],
    alphaPrior: ALPHA_PRIOR,
    alpha: b9.alpha,
    cFit: b9.cFit,
    thetaO: b9.thetaO,
    thetaI: b9.thetaI,
    metrics: null,
    alternatives: { modelB3: modelB("modelB3"), product },
    alphaFree: modelB("modelB9Free"),
    ridge: RIDGE,
    packs: Object.fromEntries(
      packs.map((pk) => [pk.id, { version: pk.version, format: pk.format, flops: pk.flops, pot: pk.pot, stack: pk.stack, minCheck: r4(pk.minCheck), filesSha256: pk.filesSha256 }]),
    ),
    kappa3: k3.kap.map(r4),
    kappa4: k4.kap.map(r4),
    kappaSampling: { deals: KAPPA_DEALS, seeds: [KAPPA[3].seed, KAPPA[4].seed], ranges3: KAPPA[3].ranges, ranges4: KAPPA[4].ranges },
    equityTable: equityTableSha256(table),
  };
  // Scored on the top-level fields as written, which the engine reads (the key keeps its place in the order).
  body.metrics = metricsOut("modelB9", betaOfModelB("modelB9", body));
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const data = { ...body, sha256 };

  // Arrays of numbers on one line; everything else indented, as JSON.
  const fmt = (v, ind) => {
    if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) return JSON.stringify(v).replace(/,/g, ", ");
    if (v && typeof v === "object") {
      const pad = " ".repeat(ind + 2);
      return `{\n${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${fmt(x, ind + 2)}`).join(",\n")}\n${" ".repeat(ind)}}`;
    }
    return JSON.stringify(v);
  };
  const text = `// Generated by scripts/fit-realization.mjs from the flop packs in public/packs/manifest.json and the cached equity
// table. Do not edit: rerun the script. Imported by scripts and tests only, not by the app.
//
// The postflop realization model of the preflop solver (model B), fitted to our own packs. For a heads-up flop
// where O acts first holding class h and I holds x, with e = eq[h, x]: O's share of the pot is
//   e + alpha·(e − ½) + c + u_O(h) − u_I(x),   u(h) = theta · handFeatures(h)   (src/poker/preflop/features.ts:
// pair, suited, hi2f5, lo2, gap, pairRank2, aceTop, wheel, suitConn, each centered on its combo-weighted mean),
// fitted in the (single raised pot, IP aggressor) context, so thetaO is the caller's u and thetaI the aggressor's.
// alpha is held at alphaPrior (the rows pin it down only weakly); c and theta are fitted. alphaFree is the same
// model with alpha fitted too, recorded as a diagnostic.
// kappa3 / kappa4: per class (ALL_HANDS order), the k-way pot share over the product of pairwise equities.
// sha256 is over JSON.stringify of every other field, in the order written.

/** R² and RMS of the per-class pot share, [OOP, IP]. */
export interface EqrFitMetrics {
  /** Joint fit, rows of every pack pooled with the fit's weights; r2, r2Gap, rms and perPack score the parameters as
   *  written here. */
  r2: [number, number];
  /** R² of the gap share − e, which the model explains beyond raw equity. */
  r2Gap: [number, number];
  rms: [number, number];
  perPack: Record<string, { r2: [number, number]; rms: [number, number] }>;
  /** Fitted on the cash packs alone, scored on the pub packs; null without both formats. */
  transferRms: [number, number] | null;
  /** The pub packs' own refit: the noise floor for transferRms. */
  transferRefitRms: [number, number] | null;
  /** 2-fold cross-validation, flops split by even and odd index in FLOPS_BY_PRIORITY. */
  cvRms: [number, number];
}

/**
 * Model B: share_O = e + alpha·(e − ½) + c + thetaO·F(h) − thetaI·F(x), F = the first features.length features.
 * alpha is EqrFit.alphaPrior where it was held, the fitted value in alphaFree.
 */
export interface EqrModelB {
  form: "modelB";
  features: string[];
  alpha: number;
  cFit: number;
  thetaO: number[];
  thetaI: number[];
  metrics: EqrFitMetrics;
}

/** Equity-scaled surplus: share_O = R_O(h)·e − (R_I(x) − 1)·(1 − e), R(h) = r0 + theta·F(h). */
export interface EqrProduct {
  form: "product";
  features: string[];
  rO0: number;
  thetaO: number[];
  rI0: number;
  thetaI: number[];
  /** R_O and R_I per class, ALL_HANDS order. */
  rO: number[];
  rI: number[];
  metrics: EqrFitMetrics;
}

export interface EqrFit {
  model: "modelB-rank9";
  features: string[];
  /** The α model B is fitted with: held, not fitted (the class rows pin it down only weakly). alpha === alphaPrior. */
  alphaPrior: number;
  alpha: number;
  cFit: number;
  thetaO: number[];
  thetaI: number[];
  metrics: EqrFitMetrics;
  /** For the sensitivity solves: model B on the first 3 features with α held (c), and the equity-scaled surplus
   *  form on all features (d). */
  alternatives: { modelB3: EqrModelB; product: EqrProduct };
  /** Diagnostic: model B on all features with α fitted as well (not used by any solve). */
  alphaFree: EqrModelB;
  ridge: number;
  packs: Record<string, { version: number; format: string; flops: number; pot: number; stack: number; minCheck: number; filesSha256: string }>;
  kappa3: number[];
  kappa4: number[];
  kappaSampling: { deals: number; seeds: number[]; ranges3: number[]; ranges4: number[] };
  /** sha256 of the equity table the expectations and kappa were computed with (equityTableSha256). */
  equityTable: string;
  sha256: string;
}

export const EQR_FIT: EqrFit = ${fmt(data, 0)};
`;

  // ── report ──
  const f3 = (v) => (v == null ? "-" : Array.isArray(v) ? v.map((x) => x.toFixed(3)).join(" / ") : v.toFixed(3));
  console.log(`\npacks: ${packs.map((pk) => `${pk.id} v${pk.version} ${pk.flops} flops (folds ${pk.foldFlops.join("/")}), min OOP check ${pk.minCheck.toFixed(4)}`).join("; ")}`);
  for (const model of Object.keys(MODELS)) {
    const m = fits[model].metrics;
    console.log(`${model.padEnd(9)} R² ${f3(m.r2)}  R²(gap) ${f3(m.r2Gap)}  RMS ${f3(m.rms)}  transfer ${f3(m.transferRms)} (pub refit ${f3(m.transferRefitRms)})  CV ${f3(m.cvRms)}`);
    const held = MODELS[model].alpha === "held" ? ` (α held at ${ALPHA_PRIOR}: β = c, θ_O, θ_I)` : "";
    console.log(`          joint β ${fits[model].beta.map((v) => v.toFixed(3)).join(", ")}${held}`);
    if (fits[model].cashOnly) console.log(`          cash-only β ${fits[model].cashOnly.map((v) => v.toFixed(3)).join(", ")}`);
  }
  // EQR of hands outside the BB's pack range, against the cash BTN range: the extrapolation risk of design §3.7.
  const cashPk = cash[0] ?? packs[0];
  const probe = ["72o", "32o", "T2o", "K2o", "AA", "AKo", "A7s", "K7s", "KTo", "K9o"];
  console.log(`\nOOP EQR vs ${cashPk.id}'s IP range (extrapolated for hands outside its OOP range):`);
  for (const hs of probe) {
    const h = ALL_HANDS.indexOf(hs);
    let e = 0, tot = 0;
    for (let x = 0; x < N; x++) {
      const k = cnt[h * N + x] * cashPk.opp[0][x];
      (tot += k), (e += k * eq[h * N + x]);
    }
    e /= tot;
    const rw = { side: 0, h, e, ...cashPk.cond[0][h] };
    const out = Object.keys(MODELS).map((m) => `${m} ${(predict(m, fits[m].beta, rw) / e).toFixed(2)}`);
    console.log(`  ${hs.padEnd(4)} eq ${e.toFixed(3)}  ${out.join("  ")}`);
  }
  const cw = ALL_HANDS.map(comboCount);
  const wMean = (a) => a.reduce((s, v, i) => s + v * cw[i], 0) / 1326;
  console.log(`\nκ_3: mean ${wMean(k3.kap).toFixed(3)}, range ${Math.min(...k3.kap).toFixed(3)}..${Math.max(...k3.kap).toFixed(3)}, rel. SE mean ${wMean(k3.rse).toFixed(3)} max ${Math.max(...k3.rse).toFixed(3)}`);
  console.log(`κ_4: mean ${wMean(k4.kap).toFixed(3)}, range ${Math.min(...k4.kap).toFixed(3)}..${Math.max(...k4.kap).toFixed(3)}, rel. SE mean ${wMean(k4.rse).toFixed(3)} max ${Math.max(...k4.rse).toFixed(3)}`);
  console.log(`timings: extraction ${extractSeconds.toFixed(1)}s, fits ${fitSeconds.toFixed(1)}s, kappa ${kappaSeconds.toFixed(1)}s, total ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  console.log(`fit sha256 ${sha256}`);

  const outPath = root + OUT;
  if (opt.limit) process.exit(0);
  if (opt.check) {
    const same = existsSync(outPath) && readFileSync(outPath, "utf8") === text;
    console.log(same ? `${OUT} is up to date` : `${OUT} differs from a fresh fit`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(outPath, text);
  console.log(`wrote ${OUT}`);
}
