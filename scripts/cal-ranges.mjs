// Writes src/presolve/calRanges.ts: the starting ranges of the calibration packs (docs/solver-packs.md, "Calibration
// packs"), taken from make-preflop exports of the stages they calibrate: the short stages' draft solve (20bb-2, 15bb-2)
// and the shipped solver chart (src/data/sets/preflopData.ts: 100bb-2.2, 100bb-3, 55bb-2.2, 35bb-2). The packs pin these
// ranges for their version, so a later solve of the stages (for example after a refit these packs feed) never changes a
// pack in place.
//
// Usage: node scripts/cal-ranges.mjs --from <file> [--from <file> ...] [--keep] [--check]
//   --from <file>  a make-preflop data file holding some of the stages: a TS module exporting PREFLOP_STAGES (the data
//                  file of a single-file run, e.g. src/data/sets/preflopData.ts), a TS module whose default export is one
//                  stage (src/data/sets/preflopStages/<id>.ts), or a stage as JSON (make-preflop --check-stage-out
//                  DIR/<id>.json). Repeatable; every stage of CAL_REFS must be found in exactly one of them, unless --keep.
//   --keep         a stage found in none of the files keeps its ranges and solve record from the committed file (so the
//                  shipped stages' ranges can be added without the short stages' scratch export); a ref of such a stage
//                  that the committed file lacks is an error
//   --check        compare with the committed file; write nothing, exit 1 if it would change
//
// For each ref "solver/<stage>/<scenario>:<action>" it takes the action's effective frequency per hand class (actions
// fill top to bottom, as src/data/charts.ts reads them) and writes it as a range string, with the stage's solve record
// (iterations, NashConv, realization fit, equity table, bet sizes). The ghost-combo floor and the products along a line
// (an open × its call of the 3-bet) are applied by src/presolve/scenarios.ts, not here, so this file holds the chart
// ranges exactly as solved.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runnerImport } from "vite";
import { load } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const OUT = "src/presolve/calRanges.ts";

/**
 * The calibration packs' chart spots. `line` and `kind` are checked against the export, so a renamed or reshaped spot
 * fails instead of feeding a pack the wrong range; the line also names the sizes, which scenarios.ts's pot arithmetic is
 * tested against (CAL_RANGE_LINES).
 *
 * The short stages (the first calibration packs): the BTN's 2bb open (the opener's range on the flop: the SB's fold and
 * the BB's call do not depend on the BTN's hand) and the BB's flat call of it after the SB folds.
 */
const SHORT_REFS = [
  { ref: "solver/20bb-2/bb-vs-btn-open:call", line: "BTN 2", kind: "vsOpen" },
  { ref: "solver/20bb-2/rfi-btn:open", line: "", kind: "rfi" },
  { ref: "solver/15bb-2/bb-vs-btn-open:call", line: "BTN 2", kind: "vsOpen" },
  { ref: "solver/15bb-2/rfi-btn:open", line: "", kind: "rfi" },
];

/**
 * The shipped stages: every spot on the lines of the calibration queue (scenarios.ts calQueue). The sizes are each
 * stage's preset (docs/preflop-solver.md §1.2): open, the SB's raise, the IP 3-bet (3 × open), the blind 3-bet (4 × open,
 * 3.5 × at 100bb-3), the BB's 3-bet of the SB (3 × its raise) and the OOP 4-bet (2.5 × the 3-bet, where the stage has
 * a small 4-bet against the BTN's 3-bet).
 */
const SHIPPED = {
  "100bb-2.2": { open: "2.2", sb: "3", ip3: "6.6", blind3: "8.8", bbVsSb3: "9", four: "16.5" },
  "55bb-2.2": { open: "2.2", sb: "3", ip3: "6.6", blind3: "8.8", bbVsSb3: "9" },
  // At 35bb the BTN flats the CO's open with 0.9% of hands (it 3-bets or folds), so no pack starts from that call.
  "35bb-2": { open: "2", sb: "2.5", ip3: "6", blind3: "8", bbVsSb3: "7.5", skip: ["btn-vs-co-open:call"] },
  "100bb-3": { open: "3", sb: "3.5", ip3: "9", blind3: "10.5", bbVsSb3: "10.5", four: "22.5" },
};
const shippedRefs = (stage, z) => {
  const r = (spot, action, line, kind) => ({ ref: `solver/${stage}/${spot}:${action}`, line, kind });
  return [
    r("rfi-btn", "open", "", "rfi"),
    r("rfi-co", "open", "", "rfi"),
    r("rfi-utg", "open", "", "rfi"),
    r("rfi-sb", "raise", "", "rfi"),
    r("rfi-sb", "limp", "", "rfi"),
    r("bb-vs-btn-open", "call", `BTN ${z.open}`, "vsOpen"),
    r("bb-vs-btn-open", "3bet", `BTN ${z.open}`, "vsOpen"),
    r("bb-vs-co-open", "call", `CO ${z.open}`, "vsOpen"),
    r("bb-vs-utg-open", "call", `UTG ${z.open}`, "vsOpen"),
    r("bb-vs-sb-open", "call", `SB ${z.sb}`, "vsOpen"),
    r("bb-vs-sb-open", "3bet", `SB ${z.sb}`, "vsOpen"),
    r("bb-vs-sb-limp", "check", "SB 림프", "vsLimp"),
    r("btn-vs-co-open", "call", `CO ${z.open}`, "vsOpen"),
    r("btn-vs-co-open", "3bet", `CO ${z.open}`, "vsOpen"),
    r("sb-vs-btn-open", "3bet", `BTN ${z.open}`, "vsOpen"),
    r("btn-open-vs-bb-3bet", "call", `BTN ${z.open} · BB 3벳 ${z.blind3}`, "vs3bet"),
    r("btn-open-vs-sb-3bet", "call", `BTN ${z.open} · SB 3벳 ${z.blind3}`, "vs3bet"),
    r("co-open-vs-btn-3bet", "call", `CO ${z.open} · BTN 3벳 ${z.ip3}`, "vs3bet"),
    r("sb-open-vs-bb-3bet", "call", `SB ${z.sb} · BB 3벳 ${z.bbVsSb3}`, "vs3bet"),
    ...(z.four
      ? [r("co-open-vs-btn-3bet", "4bet", `CO ${z.open} · BTN 3벳 ${z.ip3}`, "vs3bet"), r("btn-3bet-vs-co-4bet", "call", `CO ${z.open} · BTN 3벳 ${z.ip3} · CO 4벳 ${z.four}`, "vs4bet")]
      : []),
  ];
};
const CAL_REFS = [
  ...SHORT_REFS,
  ...Object.entries(SHIPPED).flatMap(([stage, z]) => shippedRefs(stage, z).filter((r) => !(z.skip ?? []).includes(r.ref.split("/")[2]))),
];

const { values: opt } = parseArgs({
  options: { from: { type: "string", multiple: true, default: [] }, keep: { type: "boolean", default: false }, check: { type: "boolean", default: false } },
});
if (!opt.from.length) {
  console.error("usage: node scripts/cal-ranges.mjs --from <make-preflop data file> [--from ...] [--keep] [--check]");
  process.exit(2);
}

const { parseRange, rangeToString } = await load("src/poker/range.ts");
const { ALL_HANDS, comboCount } = await load("src/poker/cards.ts");

/** Every stage object in a data file. */
async function stagesIn(file) {
  const path = resolve(file);
  if (path.endsWith(".json")) {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j) ? j : [j];
  }
  const mod = (await runnerImport(path)).module;
  if (Array.isArray(mod.PREFLOP_STAGES)) return mod.PREFLOP_STAGES;
  if (mod.default && typeof mod.default === "object" && Array.isArray(mod.default.scenarios)) return [mod.default];
  throw new Error(`${file}: no PREFLOP_STAGES and no stage as the default export`);
}

const found = new Map(); // stage id → { stage, file }
for (const file of opt.from)
  for (const st of await stagesIn(file)) {
    if (found.has(st.id) && CAL_REFS.some((r) => r.ref.split("/")[1] === st.id)) throw new Error(`stage ${st.id} is in both ${found.get(st.id).file} and ${file}`);
    found.set(st.id, { stage: st, file });
  }

// --keep: the committed file, for the stages no --from file holds.
const committed = opt.keep && existsSync(root + OUT) ? await load(OUT) : null;
const ranges = {};
const lines = {};
const stages = {};
for (const { ref, line, kind } of CAL_REFS) {
  const m = /^solver\/([^/]+)\/([^:]+):(.+)$/.exec(ref);
  const [, stageId, scenarioId, action] = m;
  const hit = found.get(stageId);
  lines[ref] = line;
  if (!hit && opt.keep) {
    const text = committed?.CAL_RANGES?.[ref];
    const solve = committed?.CAL_STAGE_SOLVES?.[stageId];
    if (text === undefined || !solve) throw new Error(`${ref}: stage ${stageId} is in none of ${opt.from.join(", ")}, and the committed ${OUT} has no range for it to keep`);
    ranges[ref] = text;
    stages[stageId] ??= solve;
    continue;
  }
  if (!hit) throw new Error(`${ref}: stage ${stageId} is in none of ${opt.from.join(", ")}`);
  const st = hit.stage;
  const sc = st.scenarios.find((s) => s.id === scenarioId);
  if (!sc) throw new Error(`${ref}: stage ${stageId} has no scenario ${scenarioId} (in ${hit.file})`);
  if (sc.line !== line || sc.kind !== kind) throw new Error(`${ref}: expected a ${kind} spot on line "${line}", the export has a ${sc.kind} spot on "${sc.line}"`);
  const k = sc.actions.findIndex((a) => a.key === action);
  if (k < 0) throw new Error(`${ref}: no action ${action} (actions: ${sc.actions.map((a) => a.key).join(", ")})`);
  // Effective frequencies: the actions fill each hand top to bottom (src/data/charts.ts).
  const parsed = sc.actions.map((a) => parseRange(a.range));
  const eff = {};
  for (const h of ALL_HANDS) {
    let used = 0;
    for (let i = 0; i <= k; i++) {
      const f = Math.min(parsed[i][h] ?? 0, Math.max(0, 1 - used));
      if (i === k && f > 0) eff[h] = Math.round(f * 1e6) / 1e6;
      used += f;
    }
  }
  for (const [h, f] of Object.entries(eff))
    if (Math.abs(f * 10 - Math.round(f * 10)) > 1e-9) throw new Error(`${ref}: ${h} at ${f} is not snapped to tenths; use a make-preflop export`);
  ranges[ref] = rangeToString(eff);
  const share = ALL_HANDS.reduce((s, h) => s + (eff[h] ?? 0) * comboCount(h), 0) / 1326;
  stages[stageId] ??= {
    stack: st.stack,
    open: st.open,
    cold4: st.tree?.cold4,
    iterations: st.iterations,
    nashConvMbb: st.nashConvMbb,
    model: st.model?.id,
    fitHash: st.model?.fitHash?.slice(0, 12),
    sprAlpha: st.model?.sprAlpha,
    sprSurplus: st.model?.sprSurplus,
    equityTable: st.equityTable?.slice(0, 12),
    ...(st.sizes && !SHORT_REFS.some((r) => r.ref.split("/")[1] === stageId) ? { sizes: st.sizes } : {}),
    shares: {},
  };
  stages[stageId].shares[`${scenarioId}:${action}`] = Math.round(share * 1000) / 10;
  if (!(st.stack > 0 && st.open > 1)) throw new Error(`${stageId}: stack ${st.stack} / open ${st.open} missing from the export`);
}

const text = `// Generated by scripts/cal-ranges.mjs from make-preflop exports of the stages. Do not edit: rerun the script.
//
// The starting ranges of the calibration packs (src/presolve/scenarios.ts CAL_SCENARIOS, docs/solver-packs.md
// "Calibration packs"): per ref "solver/<stage>/<scenario>:<action>", the action's effective frequency per hand class
// as the stage's chart shows it (snapped to tenths). The short stages (20bb-2, 15bb-2) come from their draft solve with
// the shipped realization fit and are not in the app yet (status "check" until the low-SPR calibration these packs
// feed); the others are the shipped solver chart (src/data/sets/preflopData.ts) as of the fit their records name. A pack
// keeps these ranges for its version: a later solve of the stages changes this file only when the script is rerun, and
// then the packs need a new version. The ghost-combo floor and the products along a line are added in scenarios.ts.

/** How each stage was solved: make-preflop's export record (fit and equity table hashes shortened to 12 hex digits). */
export interface CalStageSolve {
  stack: number;
  open: number;
  cold4?: string;
  iterations: number;
  nashConvMbb: number;
  model?: string;
  fitHash?: string;
  sprAlpha?: number;
  sprSurplus?: number;
  equityTable?: string;
  /** The stage's bet sizes (open multiples, make-preflop's stage sizes); recorded for the shipped stages. */
  sizes?: Record<string, number>;
  /** % of all hands in each range below (combo-weighted). */
  shares: Record<string, number>;
}

export const CAL_STAGE_SOLVES: Record<string, CalStageSolve> = ${JSON.stringify(stages, null, 2)};

export const CAL_RANGES: Record<string, string> = ${JSON.stringify(ranges, null, 2)};

/** The chart line of each ref's spot (the actions before it, with their sizes), as the export showed it. */
export const CAL_RANGE_LINES: Record<string, string> = ${JSON.stringify(lines, null, 2)};
`;

const outPath = root + OUT;
for (const [id, s] of Object.entries(stages)) console.log(`${id}: ${s.iterations} it, NashConv ${s.nashConvMbb} mbb, fit ${s.fitHash}, ${Object.entries(s.shares).map(([k, v]) => `${k} ${v}%`).join(", ")}`);
if (opt.check) {
  const same = existsSync(outPath) && readFileSync(outPath, "utf8") === text;
  console.log(same ? `${OUT} is up to date` : `${OUT} would change`);
  process.exit(same ? 0 : 1);
}
writeFileSync(outPath, text);
console.log(`wrote ${OUT}`);
