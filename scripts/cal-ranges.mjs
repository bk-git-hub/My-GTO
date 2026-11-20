// Writes src/presolve/calRanges.ts: the starting ranges of the calibration packs (docs/solver-packs.md, "Calibration
// packs"), taken from a make-preflop export of the short stages they calibrate. The packs pin these ranges for their
// version, so a later solve of the stages (for example after the low-SPR refit) never changes a pack in place.
//
// Usage: node scripts/cal-ranges.mjs --from <file> [--from <file> ...] [--check]
//   --from <file>  a make-preflop data file holding some of the stages: a TS module exporting PREFLOP_STAGES (the data
//                  file of a single-file run), a TS module whose default export is one stage
//                  (src/data/sets/preflopStages/<id>.ts), or a stage as JSON (make-preflop --check-stage-out DIR/<id>.json).
//                  Repeatable; every stage of CAL_REFS must be found in exactly one of them.
//   --check        compare with the committed file; write nothing, exit 1 if it would change
//
// For each ref "solver/<stage>/<scenario>:<action>" it takes the action's effective frequency per hand class (actions
// fill top to bottom, as src/data/charts.ts reads them) and writes it as a range string, with the stage's solve record
// (iterations, NashConv, realization fit, equity table). The ghost-combo floor is applied by src/presolve/scenarios.ts,
// not here, so this file holds the chart ranges exactly as solved.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runnerImport } from "vite";
import { load } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const OUT = "src/presolve/calRanges.ts";

/**
 * The ranges the calibration packs start from: the BTN's 2bb open (the opener's range on the flop: the SB's fold and
 * the BB's call do not depend on the BTN's hand) and the BB's flat call of it after the SB folds. `line` and `kind` are
 * checked against the export, so a renamed or reshaped spot fails instead of feeding a pack the wrong range.
 */
const CAL_REFS = [
  { ref: "solver/20bb-2/bb-vs-btn-open:call", line: "BTN 2", kind: "vsOpen" },
  { ref: "solver/20bb-2/rfi-btn:open", line: "", kind: "rfi" },
  { ref: "solver/15bb-2/bb-vs-btn-open:call", line: "BTN 2", kind: "vsOpen" },
  { ref: "solver/15bb-2/rfi-btn:open", line: "", kind: "rfi" },
];

const { values: opt } = parseArgs({ options: { from: { type: "string", multiple: true, default: [] }, check: { type: "boolean", default: false } } });
if (!opt.from.length) {
  console.error("usage: node scripts/cal-ranges.mjs --from <make-preflop data file> [--from ...] [--check]");
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

const ranges = {};
const stages = {};
for (const { ref, line, kind } of CAL_REFS) {
  const m = /^solver\/([^/]+)\/([^:]+):(.+)$/.exec(ref);
  const [, stageId, scenarioId, action] = m;
  const hit = found.get(stageId);
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
    shares: {},
  };
  stages[stageId].shares[`${scenarioId}:${action}`] = Math.round(share * 1000) / 10;
  if (!(st.stack > 0 && st.open > 1)) throw new Error(`${stageId}: stack ${st.stack} / open ${st.open} missing from the export`);
}

const text = `// Generated by scripts/cal-ranges.mjs from a make-preflop export of the short stages. Do not edit: rerun the script.
//
// The starting ranges of the calibration packs (src/presolve/scenarios.ts CAL_SCENARIOS, docs/solver-packs.md
// "Calibration packs"): per ref "solver/<stage>/<scenario>:<action>", the action's effective frequency per hand class
// as the stage's chart shows it (snapped to tenths). The stages are solved with the shipped realization fit and are not
// in the app yet (status "check" until the low-SPR calibration these packs feed). A pack keeps these ranges for its
// version: a later solve of the stages changes this file only when the script is rerun, and then the packs need a new
// version. The ghost-combo floor is added in scenarios.ts.

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
  /** % of all hands in each range below (combo-weighted). */
  shares: Record<string, number>;
}

export const CAL_STAGE_SOLVES: Record<string, CalStageSolve> = ${JSON.stringify(stages, null, 2)};

export const CAL_RANGES: Record<string, string> = ${JSON.stringify(ranges, null, 2)};
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
