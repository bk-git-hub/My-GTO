import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseNote } from "../components/FreqBar";
import { RangeGrid } from "../components/RangeGrid";
import { ChartsPage } from "../features/charts/ChartsPage";
import { generatePreflop, gradeAnswer, quizMixedMin } from "../features/quiz/generators";
import { ALL_HANDS, comboCount, RANKS, type HandClass } from "../poker/cards";
import { EQR_FIT } from "../poker/preflop/eqrFit";
import { parseRange, rangeCombos } from "../poker/range";
import { settingsStore } from "../state/settings";
import {
  actionTotals,
  CHART_SETS,
  chartSetMenu,
  closeActions,
  displayChips,
  getNamedRanges,
  getSet,
  heroFilterSeats,
  inReach,
  isHeavyClose,
  HEAVY_CLOSE_SHARE,
  KIND_LABEL,
  legendActions,
  reachOf,
  reachShare,
  reachTotals,
  scenarioActions,
  type Scenario,
  type Stage,
} from "./charts";
import {
  ARTIFACT_CELL_FACT,
  bigPairCloseNote,
  cautionFacts,
  cautionLines,
  COMPARISON_FACT,
  flagLines,
  quizCloseActions,
  RAISE_KEYS,
  solverSetDef,
} from "./sets/preflop";
import { PREFLOP_DRAFT_STAGES, PREFLOP_STAGES } from "./sets/preflopData";
import type { PreflopFlag, PreflopFlagCode, PreflopKind, PreflopScenario, PreflopStage } from "./sets/preflopTypes";

/**
 * Data tests (design §5.2) on the committed src/data/sets/preflopData.ts, read the way the app reads it: through
 * src/data/sets/preflop.ts and buildScenario (getSet("solver")). They are independent of the generator's own
 * checks (src/poker/preflop/export.ts), so a bug there cannot hide itself here.
 *
 * Severity follows §5.2: PF-DATA-1, PF-SANITY-1 above 2pp, -2, -3 and PF-SIZE-1 fail; PF-SANITY-1 between 0.5
 * and 2pp, -4, -5, -6, -7 and -8 only warn (console.warn). PF-SANITY-5, -6 and -7 hits must carry the 낮음 badge, which
 * is a data fact the generator writes, so a hit without it fails. The thresholds are the main session's decision 2:
 * per kind, rfi / vsOpen / non-cold vs3bet / vsLimp at 0.1%, the ladder groups (squeeze, vs4bet, vsShove and the
 * cold vs3bet spots) each raised through 0.1 → 0.2 → 0.5 → 1% only as far as its own count needs (the per-group ladder,
 * the approved default).
 */

// No @types/node here: reach node:fs and node:zlib through untyped handles (as cardColors.test.tsx does).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL): Uint8Array };
const zlib = (await import(/* @vite-ignore */ "node:zlib" as string)) as { gzipSync(data: Uint8Array): Uint8Array };
const DATA_FILE = new URL("./sets/preflopData.ts", import.meta.url);

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const OPENERS = POS.slice(0, 7); // UTG..BTN: the seats whose first-in raise is the stage's open
const seatId = (p: string) => p.toLowerCase().replace("+", "p");

const STAGE_LABELS: Record<string, string> = {
  "100bb-2.2": "100bb · 오픈 2.2bb",
  "100bb-3": "100bb · 펍 사이즈 오픈 3bb",
  "55bb-2.2": "55bb · 오픈 2.2bb",
  "35bb-2": "35bb · 오픈 2bb",
};
const REQUIRED = ["100bb-2.2", "100bb-3", "55bb-2.2"];
/** §4.6: the gates are first read at 1,500 iterations, never earlier. */
const MIN_ITERATIONS = 1500;
/** The 55bb+ cap sentences (§6.6): the small-4-bet split where the hero has both, the plain reason elsewhere. */
const FOUR_BET_SPLIT = "작은 4벳과 4벳 올인의 배분은 낮은 SPR 가정에 민감해요.";
const LOW_SPR_CAP = "3벳·4벳 팟은 낮은 SPR 가정에 민감해서 신뢰도를 보통까지만 줘요.";
const LADDER = [0.1, 0.2, 0.5, 1];
const LIMITS = { rfi: 8, vsOpen: [30, 36], vsLimp: [1, 6], otherMax: 72, total: 180 } as const;
const GZIP_LIMIT = 80_000; // PF-SIZE-1, the same reading as the generator (80 KB as 80,000 bytes)

const VERBS = "open|limp|iso|call|3bet|squeeze|4bet|jam|reraise|check";
const SEATS = POS.map(seatId).join("|");
/** §6.4's generic id: `<hero>-at-` and every non-fold action of the public line as `<seat>-<verb>`. */
const GENERIC = new RegExp(`^(${SEATS})-at-(${SEATS})-(${VERBS})(-(${SEATS})-(${VERBS}))*$`);
const LIMP_IDS = ["bb-vs-sb-limp", "sb-limp-vs-bb-iso", "sb-limp-vs-bb-jam", "bb-iso-vs-sb-reraise", "bb-iso-vs-sb-jam", "sb-reraise-vs-bb-jam"];

/** Decision 1: a cold player facing a non-all-in 3-bet may only fold or jam. */
const isCold = (s: Pick<PreflopScenario, "kind" | "id">) => s.kind === "vs3bet" && GENERIC.test(s.id);

const solver = getSet("solver");
const builtStage = (id: string): Stage => solver.stages.find((s) => s.id === id)!;
const byId = (stage: Stage) => new Map(stage.scenarios.map((s) => [s.id.split("/")[2], s]));

/** Share of all 1326 combos, in %, that reach the spot and take one of `keys` (combo-weighted, times reach). */
function shareOfAll(s: Scenario, keys: string[]): number {
  let x = 0;
  for (const h of ALL_HANDS) for (const k of keys) x += comboCount(h) * reachOf(s, h) * (s.strategy[h][k] ?? 0);
  return (x / 1326) * 100;
}
/** Share of all combos, in %, that reach the spot and do not fold ("plays"). */
function playsOfAll(s: Scenario): number {
  let x = 0;
  for (const h of ALL_HANDS) x += comboCount(h) * reachOf(s, h) * (1 - s.strategy[h].fold);
  return (x / 1326) * 100;
}

/** Every warning of one stage goes out in one console.warn, so a run lists them without failing. */
function warnAll(stageId: string, check: string, lines: string[]) {
  if (lines.length) console.warn(`[${stageId}] ${check} (warning only):\n  ${lines.join("\n  ")}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("solver chart set: registration and texts", () => {
  it("is registered last; the default set and getSet's fallback stay pub", () => {
    expect(chartSetMenu().at(-1)!.id).toBe("solver");
    expect(chartSetMenu().at(-1)!.label).toBe(solver.label);
    expect(CHART_SETS[0].id).toBe("pub");
    expect(getSet("no-such-set").id).toBe("pub");
    expect(solver.label).toBe("솔버 프리플랍 (9인·BB 앤티)");
    expect(solver.positions).toEqual(POS);
    expect(solver.heroFilter).toBe(true);
    expect(solver.game).toContain("BB 앤티 1bb");
    // The source states the tree's limits the charts depend on (§6.7, with the facts of the final tree).
    for (const fact of ["상용 차트나 다른 솔버 결과는 쓰지 않았어요", "BB가 오버콜하면 4명", "폴드나 올인만", "신뢰도", "ICM 미반영"])
      expect(solver.source).toContain(fact);
  });

  it("ships the required stages in order, 35bb only after them, never the 25bb check stage", () => {
    const ids = PREFLOP_STAGES.map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(REQUIRED);
    expect(ids.slice(3).every((id) => id === "35bb-2")).toBe(true);
    expect(ids.length).toBeLessThanOrEqual(4);
    expect(solver.stages.map((s) => s.id)).toEqual(ids);
    for (const st of PREFLOP_STAGES) {
      const b = builtStage(st.id);
      expect(st.label, st.id).toBe(STAGE_LABELS[st.id]);
      expect(b.label).toBe(st.label);
      expect(b.stack).toBe(`모두 ${st.stack}bb`);
      expect(st.id.startsWith(`${st.stack}bb-${st.open}`), st.id).toBe(true);
      // The page prints the stack right before the description, so the data's leading "모두 Nbb. " is dropped.
      expect(b.description.startsWith("모두"), st.id).toBe(false);
      expect(st.description, st.id).toBe(st.description.startsWith(`${b.stack}. `) ? `${b.stack}. ${b.description}` : b.description);
      expect(st.description, st.id).toContain("서로 최선인 균형 근사(착취 아님)");
      expect(b.scenarios.length).toBe(st.scenarios.length);
    }
  });

  it("marks draft stages in their descriptions; an unmeasured move is never badged 높음; a release ran the full schedule", () => {
    const ids = PREFLOP_STAGES.map((s) => s.id);
    for (const id of PREFLOP_DRAFT_STAGES) expect(ids).toContain(id);
    for (const st of PREFLOP_STAGES) {
      const draft = PREFLOP_DRAFT_STAGES.includes(st.id);
      expect(st.description.includes("초안"), st.id).toBe(draft);
      // A stage without sensitivity solves says so in every spot, with move 0 and at most 보통.
      for (const s of st.scenarios.filter((x) => x.description.includes("(초안): 민감도 풀이를 아직 안 해서"))) {
        expect(draft, s.id).toBe(true);
        expect(s.move, s.id).toBe(0);
        expect(s.confidence, s.id).not.toBe("high");
      }
      // §4.6: a stage that is not a draft stopped no earlier than 1,500 iterations.
      if (!draft) expect(st.iterations, st.id).toBeGreaterThanOrEqual(MIN_ITERATIONS);
    }
  });

  it("was made with the committed fit and the equity table the fit was made with", () => {
    for (const st of PREFLOP_STAGES) {
      expect(st.model.fitHash, st.id).toBe(EQR_FIT.sha256);
      expect(st.equityTable, st.id).toBe(EQR_FIT.equityTable);
    }
  });

  it("the data file is the generated, typed module of decision 5", () => {
    const text = new TextDecoder().decode(fs.readFileSync(DATA_FILE));
    expect(text.startsWith("// Generated by scripts/make-preflop.mjs. Do not edit by hand")).toBe(true);
    expect(text).toContain('import type { PreflopStage } from "./preflopTypes";');
    expect(text).toContain("export const PREFLOP_STAGES: PreflopStage[] = [");
    // No timestamps: identical inputs must give identical bytes.
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
  });
});

describe.each(PREFLOP_STAGES.map((st) => [st.id, st] as const))("solver data %s", (stageId, st: PreflopStage) => {
  const stage = builtStage(stageId);
  const built = byId(stage);
  const sc = (id: string) => built.get(id);

  it("PF-DATA-1: scenario counts per kind", () => {
    const counts = Object.fromEntries(Object.keys(KIND_LABEL).map((k) => [k, 0])) as Record<PreflopKind, number>;
    for (const s of st.scenarios) counts[s.kind]++;
    expect(counts.rfi).toBe(LIMITS.rfi);
    expect(counts.vsOpen).toBeGreaterThanOrEqual(LIMITS.vsOpen[0]);
    expect(counts.vsOpen).toBeLessThanOrEqual(LIMITS.vsOpen[1]);
    expect(counts.vsLimp).toBeGreaterThanOrEqual(LIMITS.vsLimp[0]);
    expect(counts.vsLimp).toBeLessThanOrEqual(LIMITS.vsLimp[1]);
    // Cold vs3bet spots are kind vs3bet, so they count there.
    for (const k of ["vs3bet", "vs4bet", "squeeze", "vsShove"] as const) expect(counts[k], k).toBeLessThanOrEqual(LIMITS.otherMax);
    expect(st.scenarios.length).toBeLessThanOrEqual(LIMITS.total);
  });

  it("PF-DATA-1: every non-rfi spot is at or above its kind's threshold; thresholds follow the size ladder", () => {
    const t = st.occThresholdByKind;
    expect(Object.keys(t).sort()).toEqual(Object.keys(KIND_LABEL).sort());
    // rfi, vsOpen, (non-cold) vs3bet and vsLimp stay at 0.1%; the ladder group moves along 0.1 → 0.2 → 0.5 → 1.
    for (const k of ["rfi", "vsOpen", "vs3bet", "vsLimp"] as const) expect(t[k], k).toBe(0.1);
    for (const k of ["squeeze", "vs4bet", "vsShove"] as const) expect(LADDER, k).toContain(t[k]);
    expect(st.occThreshold).toBe(Math.min(...Object.values(t)));
    for (const s of st.scenarios) {
      if (s.kind === "rfi") continue;
      expect(s.occ, s.id).toBeGreaterThanOrEqual(t[s.kind]);
    }
    // The cold spots' own threshold is their ladder group's, stored as occThresholdCold: a ladder step, at least the
    // non-cold vs3bet threshold, and every cold spot meets it.
    const cold = st.occThresholdCold;
    expect(cold, "occThresholdCold").toBeDefined();
    expect(LADDER).toContain(cold);
    expect(cold!).toBeGreaterThanOrEqual(t.vs3bet);
    for (const s of st.scenarios.filter(isCold)) expect(s.occ, s.id).toBeGreaterThanOrEqual(cold!);
  });

  it("PF-DATA-1: unique ids, valid seats, kinds, actions and ids of §6.4", () => {
    const ids = st.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of st.scenarios) {
      expect(Object.keys(KIND_LABEL), s.id).toContain(s.kind);
      expect(POS, s.id).toContain(s.hero);
      if (s.villain) expect(POS, s.id).toContain(s.villain);
      for (const v of s.villainSeats ?? []) expect(POS, s.id).toContain(v);
      expect(s.chip.length > 0 && s.title.length > 0, s.id).toBe(true);
      expect(s.actions.length, s.id).toBeGreaterThan(0);
      const keys = s.actions.map((a) => a.key);
      expect(keys, s.id).not.toContain("fold");
      expect(new Set(keys).size, s.id).toBe(keys.length);
      for (const a of s.actions) {
        expect(["open", "raise", "allin", "call"], `${s.id}:${a.key}`).toContain(a.color);
        expect(a.label.length, `${s.id}:${a.key}`).toBeGreaterThan(0);
      }
      const h = seatId(s.hero);
      const v = s.villain ? seatId(s.villain) : "";
      const fixed: Record<PreflopKind, string[]> = {
        rfi: [`rfi-${h}`],
        vsOpen: [`${h}-vs-${v}-open`],
        vs3bet: [`${h}-open-vs-${v}-3bet`, `${h}-open-vs-${v}-jam`],
        vs4bet: [`${h}-3bet-vs-${v}-4bet`, `${h}-3bet-vs-${v}-4bet-jam`, `${h}-4bet-vs-${v}-jam`],
        squeeze: [],
        vsLimp: LIMP_IDS,
        vsShove: [`${h}-vs-${v}-jam`],
      };
      const generic = GENERIC.test(s.id) && s.id.startsWith(`${h}-at-`);
      expect(fixed[s.kind].includes(s.id) || (generic && s.kind !== "rfi" && s.kind !== "vsOpen" && s.kind !== "vsLimp"), s.id).toBe(true);
    }
    expect(st.scenarios.filter((s) => s.kind === "rfi").map((s) => s.hero)).toEqual(POS.slice(0, 8));
  });

  it("decision 1: cold players behind a 3-bet are vs3bet spots with one 콜드 올인 action", () => {
    const cold = st.scenarios.filter(isCold);
    for (const s of cold) {
      expect(s.title.startsWith(`${s.hero} — `) && s.title.endsWith(" (콜드: 폴드·올인)"), s.id).toBe(true);
      expect(s.actions, s.id).toEqual([{ key: "shove", label: "콜드 올인", color: "allin", range: s.actions[0].range }]);
      // A cold player has not acted on this line yet, so every hand gets here.
      expect(s.reachFrom, s.id).toBeUndefined();
      expect(sc(s.id)!.reachRange, s.id).toBeUndefined();
    }
    // And no other spot is shaped like one.
    for (const s of st.scenarios.filter((x) => !isCold(x))) expect(s.title.includes("콜드"), s.id).toBe(false);
  });

  it("PF-DATA-1: reachFrom names the hero's own earlier exported actions, in line order", () => {
    const data = new Map(st.scenarios.map((s) => [s.id, s]));
    for (const s of st.scenarios) {
      const refs = s.reachFrom ?? [];
      if (s.reachFrom) expect(refs.length, s.id).toBeGreaterThan(0);
      refs.forEach((ref, i) => {
        const [id, key] = ref.split(":");
        const t = data.get(id);
        expect(t, `${s.id} → ${ref}`).toBeDefined();
        expect(t!.hero, `${s.id} → ${ref}`).toBe(s.hero);
        expect(t!.actions.map((a) => a.key), `${s.id} → ${ref}`).toContain(key);
        // The referenced spot is on this line, earlier: its own reach is the refs before it, its public line a
        // prefix of this one, and it comes up at least as often.
        expect(t!.reachFrom ?? [], `${s.id} → ${ref}`).toEqual(refs.slice(0, i));
        expect(s.line.startsWith(t!.line), `${s.id} → ${ref}`).toBe(true);
        expect(t!.occ, `${s.id} → ${ref}`).toBeGreaterThanOrEqual(s.occ);
      });
      // A first-in spot has nothing before it.
      if (s.kind === "rfi" || s.kind === "vsOpen") expect(s.reachFrom, s.id).toBeUndefined();
    }
  });

  it("PF-DATA-1: ranges parse to the 0.1 grid, sum to at most 1 per hand, and are 0 out of reach", () => {
    for (const s of st.scenarios) {
      const ranges = s.actions.map((a) => parseRange(a.range));
      const b = sc(s.id)!;
      for (const h of ALL_HANDS) {
        let sum = 0;
        ranges.forEach((r, i) => {
          const f = r[h] ?? 0;
          expect(f >= 0 && f <= 1 && Math.abs(f * 10 - Math.round(f * 10)) < 1e-9, `${s.id}:${s.actions[i].key} ${h} = ${f}`).toBe(true);
          sum += f;
        });
        if (sum > 1 + 1e-9) expect.fail(`${s.id} ${h}: frequencies sum to ${sum}`);
        if (!inReach(b, h) && sum !== 0) expect.fail(`${s.id} ${h}: out of reach but plays ${sum}`);
      }
    }
  });

  it("reach from reachFrom equals the snapped reach the earlier charts imply, for every hand", () => {
    for (const s of st.scenarios) {
      const b = sc(s.id)!;
      if (!s.reachFrom) {
        expect(b.reachRange, s.id).toBeUndefined();
        expect(s.reachPct, s.id).toBe(100);
        continue;
      }
      expect(b.reachRange, s.id).toBeDefined();
      for (const h of ALL_HANDS) {
        // The product of what the earlier charts show for this hand (buildScenario's effective frequencies).
        let rho = 1;
        for (const ref of s.reachFrom) {
          const [id, key] = ref.split(":");
          rho *= sc(id)!.strategy[h][key];
        }
        if (Math.abs(reachOf(b, h) - rho) > 1e-9) expect.fail(`${s.id} ${h}: reach ${reachOf(b, h)} but the earlier charts give ${rho}`);
      }
      // reachPct is the combo-weighted reach, rounded to 0.1 (§6.2).
      expect(Math.abs(reachShare(b) * 100 - s.reachPct), s.id).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it("every spot builds through buildScenario: the snapped values as written, strategies summing to 1", () => {
    for (const s of st.scenarios) {
      const b = sc(s.id)!;
      expect(b.title).toBe(s.title);
      expect(b.description).toBe(s.description);
      // Quiz weight min(occ, 5), except the fold-or-jam cold spots of 55bb+ stages, which the quiz leaves out.
      if (isCold(s) && st.stack >= 55) expect(b.weight, s.id).toBe(0);
      else {
        expect(b.weight, s.id).toBe(Math.min(s.occ, 5));
        expect(b.weight!, s.id).toBeGreaterThan(0);
      }
      const ranges = s.actions.map((a) => parseRange(a.range));
      for (const h of ALL_HANDS) {
        const st0 = b.strategy[h];
        const total = Object.values(st0).reduce((x, y) => x + y, 0);
        if (Math.abs(total - 1) > 1e-9) expect.fail(`${s.id} ${h}: strategy sums to ${total}`);
        // Each hand's actions sum to at most 1, so the "earlier action takes first" fill keeps every value.
        s.actions.forEach((a, i) => {
          if (Math.abs(st0[a.key] - (ranges[i][h] ?? 0)) > 1e-12) expect.fail(`${s.id}:${a.key} ${h}: built ${st0[a.key]}, written ${ranges[i][h]}`);
        });
      }
    }
  });

  it("the BB facing an SB limp checks instead of folding, and only there", () => {
    const limp = sc("bb-vs-sb-limp")!;
    expect(limp, "bb-vs-sb-limp").toBeDefined();
    expect(limp.noFold).toBe(true);
    expect(limp.actions.at(-1)).toMatchObject({ key: "check", label: "체크" });
    expect(scenarioActions(limp).map((a) => a.key)).not.toContain("fold");
    expect(legendActions(limp).map((a) => a.key)).not.toContain("fold");
    for (const h of ALL_HANDS) if (limp.strategy[h].fold > 1e-12) expect.fail(`bb-vs-sb-limp ${h}: folds ${limp.strategy[h].fold}`);
    for (const s of stage.scenarios.filter((x) => x !== limp)) {
      expect(s.noFold, s.id).toBeUndefined();
      expect(s.actions.map((a) => a.key), s.id).not.toContain("check");
    }
    // Its text names only the actions it has: no 올인 where the BB cannot jam over the limp.
    const jam = limp.actions.some((a) => a.key === "shove");
    expect(limp.description).toContain(jam ? "BB는 폴드하지 않아요: 레이즈·올인이 아니면 체크해요." : "BB는 폴드하지 않아요: 레이즈가 아니면 체크해요.");
  });

  it("the line names every seat with chips in: each opponent, and the fold of any seat that left", () => {
    for (const s of st.scenarios) {
      const steps = s.line ? s.line.split(" · ").map((t) => ({ seat: t.split(" ")[0], what: t.split(" ").slice(1).join(" ") })) : [];
      for (const x of steps) expect(POS, `${s.id}: ${s.line}`).toContain(x.seat);
      const folded = new Set(steps.filter((x) => x.what === "폴드").map((x) => x.seat));
      const acted = new Set(steps.filter((x) => x.what !== "폴드").map((x) => x.seat));
      const villains = s.villainSeats ?? [];
      for (const v of villains) expect(acted.has(v) && !folded.has(v), `${s.id}: villain ${v} in ${s.line}`).toBe(true);
      // A seat that put chips in and is not an opponent must show its fold, or the spot reads as if it were live.
      for (const seat of acted) if (seat !== s.hero) expect(folded.has(seat) || villains.includes(seat), `${s.id}: ${seat} in ${s.line}`).toBe(true);
      if (folded.size) expect(s.title, s.id).toContain("폴드");
    }
  });

  it("chips tell spots apart within a kind group and hero seat (the seat-filtered chip row)", () => {
    const seen = new Set<string>();
    for (const s of st.scenarios) {
      const k = `${s.kind} ${s.hero} ${s.chip}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });

  it("chips are unique in every list the charts page shows, with or without the seat row", () => {
    const groups = new Map<string, Scenario[]>();
    for (const s of stage.scenarios) groups.set(s.kind, [...(groups.get(s.kind) ?? []), s]);
    for (const [kind, list] of groups) {
      const seats = heroFilterSeats(solver, list);
      for (const shown of seats.length ? seats.map((p) => list.filter((s) => s.hero === p)) : [list]) {
        const chips = displayChips(shown);
        expect(new Set(chips).size, `${kind}: ${chips.join(" | ")}`).toBe(chips.length);
      }
    }
  });

  it("spots without reachRange keep all-hands totals (reachTotals = actionTotals)", () => {
    for (const s of stage.scenarios.filter((x) => !x.reachRange)) {
      const a = actionTotals(s);
      const r = reachTotals(s);
      for (const k of Object.keys(a)) expect(r[k], `${s.id} ${k}`).toBe(a[k]);
    }
  });

  it("PF-SANITY-1: RFI rises with the seat, UTG → BTN (fail above 2pp, warn above 0.5pp)", () => {
    const rfi = OPENERS.map((p) => ({ seat: p, v: playsOfAll(sc(`rfi-${seatId(p)}`)!) }));
    const fails: string[] = [];
    const warns: string[] = [];
    for (let j = 1; j < rfi.length; j++)
      for (let i = 0; i < j; i++) {
        const gap = rfi[i].v - rfi[j].v;
        const msg = `RFI ${rfi[j].seat} ${rfi[j].v.toFixed(1)}% < ${rfi[i].seat} ${rfi[i].v.toFixed(1)}%`;
        if (gap > 2) fails.push(msg);
        else if (gap > 0.5) warns.push(msg);
      }
    warnAll(stageId, "PF-SANITY-1", warns);
    expect(fails).toEqual([]);
  });

  it("PF-SANITY-2: monotone chains in RFI and BB defense (tolerance 0.15)", () => {
    const chains: [string, string][] = [];
    const R = "AKQJT98765432";
    for (let i = 0; i + 1 < R.length; i++) chains.push([R[i] + R[i], R[i + 1] + R[i + 1]]);
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) chains.push([R[i] + R[j] + "s", R[i] + R[j] + "o"]);
    const ladder = (hands: string[]) => hands.slice(1).forEach((h, i) => chains.push([hands[i], h]));
    ladder(["AKo", "AQo", "AJo", "ATo"]);
    ladder(["KQo", "KJo", "KTo"]);
    ladder(["QJo", "QTo"]);
    const spots = stage.scenarios.filter((s) => s.kind === "rfi" || (s.kind === "vsOpen" && s.hero === "BB"));
    expect(spots.length).toBe(16);
    const fails: string[] = [];
    for (const s of spots)
      for (const [a, b] of chains) {
        const pa = 1 - s.strategy[a].fold;
        const pb = 1 - s.strategy[b].fold;
        if (pa < pb - 0.15 - 1e-9) fails.push(`${s.id}: ${a} plays ${pa.toFixed(2)} < ${b} ${pb.toFixed(2)}`);
      }
    expect(fails).toEqual([]);
  });

  it("PF-SANITY-3: BB defense rises from UTG to BTN (2pp), and vs SB at least vs BTN − 2pp", () => {
    const def = [...OPENERS, "SB"].map((p) => ({ seat: p, v: playsOfAll(sc(`bb-vs-${seatId(p)}-open`)!) }));
    const fails: string[] = [];
    for (let j = 1; j < 7; j++)
      for (let i = 0; i < j; i++)
        if (def[j].v < def[i].v - 2) fails.push(`BB vs ${def[j].seat} ${def[j].v.toFixed(1)}% < vs ${def[i].seat} ${def[i].v.toFixed(1)}%`);
    if (def[7].v < def[6].v - 2) fails.push(`BB vs SB ${def[7].v.toFixed(1)}% < vs BTN ${def[6].v.toFixed(1)}% − 2`);
    expect(fails).toEqual([]);
  });

  it("PF-SANITY-4 (warning): 3-bet % rises from EP to LP openers for BTN, SB and BB", () => {
    const warns: string[] = [];
    for (const hero of ["BTN", "SB", "BB"]) {
      const openers = POS.slice(0, POS.indexOf(hero)).filter((p) => p !== "BB");
      const xs = openers.map((o) => ({ seat: o, v: shareOfAll(sc(`${seatId(hero)}-vs-${seatId(o)}-open`)!, ["3bet", "shove"]) }));
      for (let j = 1; j < xs.length; j++)
        for (let i = 0; i < j; i++)
          if (xs[j].v < xs[i].v - 2) warns.push(`${hero} 3-bet vs ${xs[j].seat} ${xs[j].v.toFixed(1)}% < vs ${xs[i].seat} ${xs[i].v.toFixed(1)}%`);
    }
    warnAll(stageId, "PF-SANITY-4", warns);
  });

  it("PF-SANITY-5 (warning): non-blind cold calls vs a UTG–LJ open; a hit is badged 낮음", () => {
    const warns: string[] = [];
    for (const s of st.scenarios) {
      if (s.kind !== "vsOpen" || s.hero === "SB" || s.hero === "BB" || !["UTG", "UTG+1", "UTG+2", "LJ"].includes(s.villain ?? "")) continue;
      const call = shareOfAll(sc(s.id)!, ["call"]);
      if (call > 10 + 1e-6) {
        warns.push(`${s.id}: cold call ${call.toFixed(1)}% of all hands`);
        expect(s.confidence, `${s.id} (PF-SANITY-5)`).toBe("low");
      }
    }
    warnAll(stageId, "PF-SANITY-5", warns);
  });

  it("PF-SANITY-6 (warning, ≥ 55bb): 4-bet jams vs small 4-bets; a hit is badged 낮음, every 3-/4-bet spot at most 보통", () => {
    if (st.stack < 55) {
      for (const s of st.scenarios) expect(s.description.includes(FOUR_BET_SPLIT) || s.description.includes(LOW_SPR_CAP), s.id).toBe(false);
      return;
    }
    const warns: string[] = [];
    for (const s of st.scenarios) {
      const split = s.actions.some((a) => a.key === "4bet") && s.actions.some((a) => a.key === "shove");
      if (s.kind === "vs3bet" || s.kind === "vs4bet") {
        expect(s.confidence, `${s.id} (55bb+ cap)`).not.toBe("high");
        // The split sentence only where the hero chooses between a small 4-bet and a jam; the plain reason elsewhere.
        expect(s.description.includes(FOUR_BET_SPLIT), s.id).toBe(split);
        expect(s.description.includes(LOW_SPR_CAP), s.id).toBe(!split);
      } else {
        expect(s.description.includes(FOUR_BET_SPLIT) || s.description.includes(LOW_SPR_CAP), s.id).toBe(false);
      }
      // Cold spots have no small 4-bet, so the check says nothing about them.
      if (s.kind !== "vs3bet" || !s.actions.some((a) => a.key === "4bet") || !s.actions.some((a) => a.key === "shove")) continue;
      const t = reachTotals(sc(s.id)!);
      const jam = t.shove * 100;
      const four = t["4bet"] * 100;
      if (jam > four + 2 + 1e-6) {
        warns.push(`${s.id}: jam ${jam.toFixed(1)}% > small 4-bet ${four.toFixed(1)}% + 2`);
        expect(s.confidence, `${s.id} (PF-SANITY-6)`).toBe("low");
      }
    }
    warnAll(stageId, "PF-SANITY-6", warns);
  });

  it("PF-SANITY-7 (warning): kickers in RFI and BB defense (Ax ≥ Kx, higher kicker ≥ lower); a hit is badged 낮음", () => {
    // [better, worse]: Ax ≥ Kx with kicker 2–9, and in each row the higher kicker ≥ the next lower one, except below A6
    // in the ace row (the wheel aces may play more than A6–A9). Suited and offsuit. Tolerance 0.15, as PF-SANITY-2.
    const R = RANKS; // "23456789TJQKA"
    const chains: [string, string][] = [];
    for (const x of ["s", "o"]) {
      for (let k = 0; k <= 7; k++) chains.push([`A${R[k]}${x}`, `K${R[k]}${x}`]);
      for (let hi = 12; hi >= 2; hi--) for (let lo = hi - 1; lo >= 1; lo--) if (!(hi === 12 && lo <= 4)) chains.push([R[hi] + R[lo] + x, R[hi] + R[lo - 1] + x]);
    }
    const warns: string[] = [];
    for (const d of st.scenarios.filter((x) => x.kind === "rfi" || (x.kind === "vsOpen" && x.hero === "BB"))) {
      const s = sc(d.id)!;
      const bad = chains.filter(([a, b]) => 1 - s.strategy[a].fold < 1 - s.strategy[b].fold - 0.15 - 1e-9);
      if (!bad.length) continue;
      warns.push(`${d.id}: ${bad.map(([a, b]) => `${a} ${(1 - s.strategy[a].fold).toFixed(1)} < ${b} ${(1 - s.strategy[b].fold).toFixed(1)}`).join(", ")}`);
      expect(d.confidence, `${d.id} (PF-SANITY-7)`).toBe("low");
      expect(d.description, d.id).toContain("더 좋은 핸드를 덜 플레이하는 칸이 있어요");
    }
    warnAll(stageId, "PF-SANITY-7", warns);
  });

  it("PF-SANITY-8 (warning, print only): top cards in RFI and BB defense (Kx ≥ Qx with the same kicker 2–J)", () => {
    // An additive realization term cannot follow how close K and Q are against a tight range, so a few cells may
    // cross; they are printed, never badged. Qx ≥ Jx is not checked: the packs put J9/J8 at or above Q9/Q8.
    const R = RANKS;
    const chains: [string, string][] = [];
    for (const x of ["s", "o"]) for (let k = 0; k <= 9; k++) chains.push([`K${R[k]}${x}`, `Q${R[k]}${x}`]);
    const warns: string[] = [];
    for (const d of st.scenarios.filter((x) => x.kind === "rfi" || (x.kind === "vsOpen" && x.hero === "BB"))) {
      const s = sc(d.id)!;
      const bad = chains.filter(([a, b]) => 1 - s.strategy[a].fold < 1 - s.strategy[b].fold - 0.15 - 1e-9);
      if (bad.length) warns.push(`${d.id}: ${bad.map(([a, b]) => `${a} ${(1 - s.strategy[a].fold).toFixed(1)} < ${b} ${(1 - s.strategy[b].fold).toFixed(1)}`).join(", ")}`);
    }
    warnAll(stageId, "PF-SANITY-8", warns);
  });

  it("§6.6: no spot is badged better than its measured move allows", () => {
    for (const s of st.scenarios) {
      expect(["high", "mid", "low"], s.id).toContain(s.confidence);
      expect(s.move, s.id).toBeGreaterThanOrEqual(0);
      if (s.move > 20) expect(s.confidence, s.id).toBe("low");
      else if (s.move >= 8) expect(s.confidence, s.id).not.toBe("high");
    }
  });
});

describe("solver data: size and app smoke tests", () => {
  it("PF-SIZE-1: gzip of preflopData.ts is at most 80 KB", () => {
    const bytes = fs.readFileSync(DATA_FILE);
    const gz = zlib.gzipSync(bytes).length;
    console.info(`preflopData.ts: ${bytes.length} bytes, gzip ${gz} bytes (limit ${GZIP_LIMIT}); ${PREFLOP_STAGES.map((s) => `${s.id} ${s.scenarios.length}`).join(", ")}`);
    expect(gz).toBeLessThanOrEqual(GZIP_LIMIT);
  });

  it("the module builds the set from the data as is (same stages, spots and actions)", () => {
    const def = solverSetDef();
    expect(def.stages.map((s) => s.scenarios.map((x) => x.id))).toEqual(PREFLOP_STAGES.map((s) => s.scenarios.map((x) => x.id)));
    for (const [i, st] of PREFLOP_STAGES.entries())
      st.scenarios.forEach((s, j) => expect(def.stages[i].scenarios[j].actions, s.id).toEqual(s.actions));
  });

  it("the calculator lists only the solver's rfi, vsOpen and vs3bet ranges, without the actions its chart never takes", () => {
    const named = getNamedRanges().filter((r) => r.id.startsWith("solver/"));
    const want = solver.stages.flatMap((st) =>
      st.scenarios
        .filter((s) => ["rfi", "vsOpen", "vs3bet"].includes(s.kind))
        .flatMap((s) => s.actions.filter((a) => a.range.trim() !== "").map((a) => `${s.id}:${a.key}`)),
    );
    expect(named.map((r) => r.id)).toEqual(want);
    for (const r of named) expect(rangeCombos(r.range), r.id).toBeGreaterThan(0);
  });

  it("the quiz deals only hands that reach the spot, from every stage, without 폴드 where the hero cannot fold", () => {
    // Seeded, so the run is the same every time.
    let seed = 12345;
    vi.spyOn(Math, "random").mockImplementation(() => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
    const stages = new Set<string>();
    const kinds = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const q = generatePreflop("solver", "all");
      expect(q.scenario.setId).toBe("solver");
      expect(inReach(q.scenario, q.hand as HandClass), `${q.scenario.id} ${q.hand}`).toBe(true);
      // Fold-or-jam cold spots of 55bb+ stages are tree artifacts and never asked.
      const st = PREFLOP_STAGES.find((x) => q.scenario.stageId === x.id)!;
      expect(isCold({ kind: q.scenario.kind, id: q.scenario.id.split("/")[2] }) && st.stack >= 55, q.scenario.id).toBe(false);
      expect(scenarioActions(q.scenario).some((a) => a.key === "fold"), q.scenario.id).toBe(!q.scenario.noFold);
      // Flagged artifact cells (§6.10) are never dealt.
      expect(q.scenario.quizSkip?.[q.hand as HandClass], `${q.scenario.id} ${q.hand}`).toBeUndefined();
      stages.add(q.scenario.stageId);
      kinds.add(q.scenario.kind);
    }
    expect([...stages].sort()).toEqual(PREFLOP_STAGES.map((s) => s.id).sort());
    expect(kinds.has("rfi") && kinds.has("vsOpen")).toBe(true);
  });

  it("the charts page renders the solver set", () => {
    const before = settingsStore.get();
    try {
      settingsStore.set({ ...before, chartSet: "solver" });
      const html = renderToString(createElement(ChartsPage)).replace(/<!-- -->/g, "");
      for (const st of PREFLOP_STAGES) expect(html).toContain(st.label);
      expect(html).toContain("UTG 오픈 레인지");
      expect(html).toContain(KIND_LABEL.vsOpen);
    } finally {
      settingsStore.set(before);
    }
  });
});

// ───────────── Close calls and artifact flags (§6.9, §6.10) ─────────────
// Read through the built set (closeActions, the strategies the grid shows) and the raw data, independently of the
// generator's closeString and stageFlags.

const CLOSE_EPS = 0.05;
/** PF-CLOSE-3: the share of in-reach cells marked per stage, in % (measured 5.1 / 3.8 / 5.5 / 5.6). */
const CLOSE_SHARE = [1, 12];
const FLAG_CODES: PreflopFlagCode[] = ["PF-SANITY-9", "PF-SANITY-11", "PF-SANITY-12", "PF-SANITY-13", "PF-SANITY-14"];
const RAISES = new Set(["open", "raise", "3bet", "squeeze", "4bet", "shove"]);
const EP = new Set(["UTG", "UTG+1", "UTG+2", "LJ"]);
const handsOf = (text: string | undefined) => Object.keys(parseRange(text ?? "")) as HandClass[];
const legendKeys = (s: PreflopScenario) => [...s.actions.map((a) => a.key), ...(s.noFold ? [] : ["fold"])];
/** The legend key the chart shows at ≥ 0.999 for h, or null for a mixed cell. */
const pureKey = (s: Scenario, keys: string[], h: HandClass) => keys.find((k) => (s.strategy[h][k] ?? 0) >= 0.999) ?? null;
const bitsOf = (ch: string) => {
  const m = parseInt(ch, 16);
  return [0, 1, 2, 3].filter((i) => m & (1 << i));
};

/** The five flag rules (§6.10) written out again, on the built scenario: `hands` (clear cells only) and `vs`. */
function expectedFlags(stack: number, raw: PreflopScenario, s: Scenario): { code: PreflopFlagCode; hands: HandClass[]; vs: HandClass[] }[] {
  const keys = raw.actions.map((a) => a.key);
  const lk = legendKeys(raw);
  const f = (h: string, ks: string[]) => ks.reduce((x, k) => x + (s.strategy[h][k] ?? 0), 0);
  const raise = (h: string) => f(h, keys.filter((k) => RAISES.has(k)));
  const call = (h: string) => f(h, keys.filter((k) => !RAISES.has(k)));
  const plays = (h: string) => 1 - s.strategy[h].fold;
  const reach = (h: string) => reachOf(s, h as HandClass) > 0;
  // A clear model preference: the cell is pure and carries no close mark.
  const clear = (h: string) => pureKey(s, lk, h as HandClass) !== null && (raw.close?.[ALL_HANDS.indexOf(h as HandClass)] ?? ".") === ".";
  const first = !raw.reachFrom?.length;
  const out: { code: PreflopFlagCode; hands: HandClass[]; vs: HandClass[] }[] = [];
  const push = (code: PreflopFlagCode, hands: string[], vs: string[]) => hands.length && out.push({ code, hands: hands as HandClass[], vs: vs as HandClass[] });
  if (first && raw.kind === "vsOpen" && EP.has(raw.villain ?? "")) {
    const k3 = keys.filter((k) => ["3bet", "squeeze", "shove"].includes(k));
    const r = (h: string) => f(h, k3);
    const lsc = ["43s", "54s", "65s", "53s", "64s"], wheel = ["A5s", "A4s", "A3s", "A2s"];
    if (k3.length && lsc.reduce((x, h) => x + r(h), 0) > wheel.reduce((x, h) => x + r(h), 0) + 0.5 + 1e-9) {
      const hs = lsc.filter((h) => r(h) > Math.max(...wheel.map(r)) + 1e-9 && clear(h));
      if (hs.length) push("PF-SANITY-9", hs, wheel.filter((h) => r(h) < Math.max(...hs.map(r)) - 1e-9));
    }
  }
  if (first && (raw.kind === "vsOpen" || raw.kind === "squeeze") && keys.some((k) => RAISES.has(k))) {
    const mid = ["TT", "99", "88", "77"];
    const hs = ["AA", "KK", "QQ", "JJ"].filter((h) => raise(h) <= Math.max(...mid.map(raise)) - 0.5 + 1e-9 && clear(h));
    if (hs.length) push("PF-SANITY-11", hs, mid.filter((h) => raise(h) >= Math.min(...hs.map(raise)) + 0.5 - 1e-9));
  }
  if ((raw.kind === "vs3bet" || raw.kind === "vs4bet") && keys.some((k) => RAISES.has(k)) && keys.some((k) => !RAISES.has(k)))
    push("PF-SANITY-12", ["AA", "KK"].filter((h) => reach(h) && raise(h) < 0.5 - 1e-9 && call(h) >= 0.5 - 1e-9 && clear(h)), []);
  if (stack >= 100 && raw.kind === "vs3bet" && keys.includes("4bet") && keys.includes("shove")) {
    const L = ["AA", "KK", "QQ", "JJ", "TT", "99"], jam = (h: string) => s.strategy[h].shove ?? 0;
    const lo = new Set<string>(), hi = new Set<string>();
    L.forEach((a, i) => L.slice(i + 1).forEach((b) => {
      if (reach(a) && reach(b) && clear(b) && jam(b) >= jam(a) + 0.5 - 1e-9) (lo.add(b), hi.add(a));
    }));
    push("PF-SANITY-13", L.filter((h) => lo.has(h)), L.filter((h) => hi.has(h) && !lo.has(h)));
  }
  if (first) {
    const holes = new Set<string>(), over = new Set<string>();
    for (const a of ["A9o", "A8o", "A7o", "A6o"]) for (const b of ["A4o", "A3o", "A2o"]) if (clear(a) && plays(a) <= plays(b) - 0.3 + 1e-9) (holes.add(a), over.add(b));
    push("PF-SANITY-14", [...holes], [...over]);
  }
  return out;
}

describe("solver data: close calls and artifact flags (§6.9, §6.10)", () => {
  it("PF-CLOSE-1: format — closeEps, 169 hex characters, 2+ bits within the legend, '.' out of reach, no empty string", () => {
    for (const st of PREFLOP_STAGES) {
      expect(st.closeEps, st.id).toBe(CLOSE_EPS);
      const built = byId(builtStage(st.id));
      for (const raw of st.scenarios) {
        if (raw.close === undefined) continue;
        const s = built.get(raw.id)!;
        expect(raw.close, raw.id).toMatch(/^[.0-9a-f]{169}$/);
        expect(raw.close.replace(/\./g, "").length, raw.id).toBeGreaterThan(0);
        if (st.closeMinOcc !== undefined) expect(raw.occ, raw.id).toBeGreaterThanOrEqual(st.closeMinOcc);
        const n = legendKeys(raw).length;
        ALL_HANDS.forEach((h, i) => {
          const ch = raw.close![i];
          if (!inReach(s, h)) expect(ch, `${raw.id} ${h}`).toBe(".");
          if (ch === ".") return;
          const bits = bitsOf(ch);
          expect(bits.length, `${raw.id} ${h}`).toBeGreaterThanOrEqual(2);
          expect(Math.max(...bits), `${raw.id} ${h}`).toBeLessThan(n);
        });
      }
    }
  });

  it("PF-CLOSE-2: marks only pure cells, always with the chart's action, never an action under 1% of the reaching range", () => {
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      for (const raw of st.scenarios) {
        if (!raw.close) continue;
        const s = built.get(raw.id)!;
        const keys = legendKeys(raw);
        const totals = reachTotals(s);
        ALL_HANDS.forEach((h, i) => {
          const ch = raw.close![i];
          if (ch === ".") return;
          const pure = pureKey(s, keys, h);
          expect(pure, `${raw.id} ${h} is not pure`).not.toBeNull();
          const set = bitsOf(ch).map((b) => keys[b]);
          expect(set, `${raw.id} ${h}`).toContain(pure);
          for (const k of set) if (k !== "fold") expect(totals[k] * 100, `${raw.id} ${h} ${k}`).toBeGreaterThanOrEqual(1 - 1e-9);
        });
      }
    }
  });

  it("PF-CLOSE-3: 1–12% of in-reach cells are marked per stage", () => {
    const lines: string[] = [];
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      let cells = 0, marked = 0, spots = 0;
      for (const raw of st.scenarios) {
        const s = built.get(raw.id)!;
        cells += ALL_HANDS.filter((h) => inReach(s, h)).length;
        marked += Object.keys(s.close ?? {}).length;
        if (raw.close) spots++;
      }
      const pct = (marked / cells) * 100;
      lines.push(`${st.id} ${marked}/${cells} (${pct.toFixed(1)}%), ${spots} spots`);
      expect(pct, st.id).toBeGreaterThanOrEqual(CLOSE_SHARE[0]);
      expect(pct, st.id).toBeLessThanOrEqual(CLOSE_SHARE[1]);
    }
    console.info(`close calls: ${lines.join("; ")}`);
  });

  it("the built set decodes close to legend keys, only on marked pure cells", () => {
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      for (const raw of st.scenarios) {
        const s = built.get(raw.id)!;
        const keys = legendKeys(raw);
        expect(legendActions(s).map((a) => a.key), raw.id).toEqual(keys);
        ALL_HANDS.forEach((h, i) => {
          const ch = raw.close?.[i] ?? ".";
          const got = closeActions(s, h);
          if (ch === ".") expect(got, `${raw.id} ${h}`).toBeUndefined();
          else expect(got, `${raw.id} ${h}`).toEqual(bitsOf(ch).map((b) => keys[b]));
          if (pureKey(s, keys, h) === null) expect(got, `${raw.id} ${h} is mixed`).toBeUndefined();
        });
      }
    }
  });

  it("flags: the five rules written out again give exactly the stored flags; every flagged hand is in reach, pure and unmarked", () => {
    const counts: string[] = [];
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      const byCode = new Map<string, number>();
      let spots = 0;
      for (const raw of st.scenarios) {
        const s = built.get(raw.id)!;
        const want = expectedFlags(st.stack, raw, s);
        const got = (raw.flags ?? []).map((f: PreflopFlag) => ({ code: f.code, hands: handsOf(f.hands).sort(), vs: handsOf(f.vs).sort() }));
        expect(got, raw.id).toEqual(want.map((f) => ({ code: f.code, hands: [...f.hands].sort(), vs: [...f.vs].sort() })));
        expect(raw.flags === undefined || raw.flags.length > 0, raw.id).toBe(true);
        expect((raw.flags ?? []).map((f) => f.code), raw.id).toEqual(FLAG_CODES.filter((c) => raw.flags?.some((f) => f.code === c)));
        if (raw.flags) spots++;
        for (const f of raw.flags ?? []) {
          byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
          expect(f.hands.length, raw.id).toBeGreaterThan(0);
          if (f.code === "PF-SANITY-12") expect(f.vs, raw.id).toBeUndefined();
          for (const h of handsOf(f.hands)) {
            expect(inReach(s, h), `${raw.id} ${h}`).toBe(true);
            expect(pureKey(s, legendKeys(raw), h), `${raw.id} ${h}`).not.toBeNull();
            expect(closeActions(s, h), `${raw.id} ${h}`).toBeUndefined();
          }
          for (const v of Object.values(parseRange(f.hands))) expect(v).toBe(1);
          for (const v of Object.values(parseRange(f.vs ?? ""))) expect(v).toBe(1);
        }
      }
      counts.push(`${st.id} ${spots} spots (${FLAG_CODES.filter((c) => byCode.has(c)).map((c) => `${c.slice(10)}: ${byCode.get(c)}`).join(", ")})`);
    }
    console.info(`flags: ${counts.join("; ")}`);
  });

  it("cautions quote the chart's own numbers, every example is true, and the quiz skips hands plus vs of 9 and 14", () => {
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      for (const raw of st.scenarios) {
        const s = built.get(raw.id)!;
        const lines = cautionLines(s);
        expect(lines.length, raw.id).toBe(raw.flags?.length ?? 0);
        const keys = raw.actions.map((a) => a.key);
        const sum = (h: string, ks: string[]) => ks.reduce((x, k) => x + (s.strategy[h][k] ?? 0), 0);
        const p = (x: number) => Math.round(x * 100);
        const skip = new Set<string>();
        (raw.flags ?? []).forEach((f, i) => {
          const line = lines[i], H = handsOf(f.hands), V = handsOf(f.vs);
          for (const h of H) skip.add(h);
          if (f.code === "PF-SANITY-9" || f.code === "PF-SANITY-14") for (const h of V) skip.add(h);
          const m = (re: RegExp) => {
            const x = re.exec(line);
            expect(x, `${raw.id} ${f.code}: ${line}`).not.toBeNull();
            return x!;
          };
          if (f.code === "PF-SANITY-9") {
            const [, a, pa, b, pb] = m(/예: (\S+) 3벳 (\d+)%, (\S+) 3벳 (\d+)%\)/);
            const r = (h: string) => sum(h, keys.filter((k) => ["3bet", "squeeze", "shove"].includes(k)));
            expect([H.includes(a as HandClass), V.includes(b as HandClass), +pa, +pb]).toEqual([true, true, p(r(a)), p(r(b))]);
            expect(+pa).toBeGreaterThan(+pb);
          } else if (f.code === "PF-SANITY-11") {
            const [, a, verb, pa, b, pb] = m(/예: (\S+) (3벳|스퀴즈) (\d+)%, (\S+) \2 (\d+)%\)/);
            expect(verb).toBe(raw.kind === "squeeze" ? "스퀴즈" : "3벳");
            const r = (h: string) => sum(h, keys.filter((k) => RAISES.has(k)));
            expect([H.includes(a as HandClass), V.includes(b as HandClass), +pa, +pb]).toEqual([true, true, p(r(a)), p(r(b))]);
            expect(+pa).toBeLessThanOrEqual(+pb - 50);
          } else if (f.code === "PF-SANITY-12") {
            expect(line.startsWith(`${H.join("·")}는 ${raw.kind === "vs4bet" ? "4벳" : "3벳"}에`), line).toBe(true);
            for (const h of H) {
              const [, pc] = m(new RegExp(`${h} 콜 (\\d+)%`));
              expect(+pc).toBe(p(sum(h, keys.filter((k) => !RAISES.has(k)))));
              expect(sum(h, keys.filter((k) => !RAISES.has(k)))).toBeGreaterThan(sum(h, keys.filter((k) => RAISES.has(k))));
            }
          } else if (f.code === "PF-SANITY-13") {
            const [, a, pa, b, pb] = m(/예: (\S+) 올인 (\d+)%, (\S+) 올인 (\d+)%\)/);
            const jam = (h: string) => s.strategy[h].shove ?? 0;
            expect([H.includes(a as HandClass), [...H, ...V].includes(b as HandClass), +pa, +pb]).toEqual([true, true, p(jam(a)), p(jam(b))]);
            expect(ALL_HANDS.indexOf(b as HandClass)).toBeLessThan(ALL_HANDS.indexOf(a as HandClass)); // b is the higher pair
            expect(+pa).toBeGreaterThanOrEqual(+pb + 50);
          } else {
            const [, a, pa, b, pb] = m(/예: (A[2-9]o) (\d+)%, (A[2-4]o) (\d+)%\)/);
            const plays = (h: string) => 1 - s.strategy[h].fold;
            expect([H.includes(a as HandClass), V.includes(b as HandClass), +pa, +pb]).toEqual([true, true, p(plays(a)), p(plays(b))]);
            expect(+pa).toBeLessThanOrEqual(+pb - 30);
          }
        });
        expect(Object.keys(s.quizSkip ?? {}).sort(), raw.id).toEqual([...skip].sort());
        // The hand card shows the cautions whose hands or vs hold the hand.
        for (const h of ALL_HANDS) {
          const want = (raw.flags ?? []).flatMap((f, i) => (handsOf(f.hands).includes(h) || handsOf(f.vs).includes(h) ? [lines[i]] : []));
          expect(flagLines(s, h), `${raw.id} ${h}`).toEqual(want);
        }
      }
    }
  });

  it("each caution's example is its rule's extreme pair, ties to the earlier hand of the rule's list", () => {
    const LSC = ["43s", "54s", "65s", "53s", "64s"], WHEEL = ["A5s", "A4s", "A3s", "A2s"];
    const BIG = ["AA", "KK", "QQ", "JJ"], MID = ["TT", "99", "88", "77"], JAM = ["AA", "KK", "QQ", "JJ", "TT", "99"];
    const HIGH = ["A9o", "A8o", "A7o", "A6o"], LOW = ["A4o", "A3o", "A2o"];
    /** The first hand of list with the largest f. */
    const first = (list: string[], f: (h: string) => number) => list.reduce<string | undefined>((b, h) => (b === undefined || f(h) > f(b) ? h : b), undefined);
    /** The first pair with the largest gap. */
    const widest = (pairs: [string, string][], gap: (p: [string, string]) => number) => pairs.reduce<[string, string] | undefined>((b, p) => (!b || gap(p) > gap(b) ? p : b), undefined);
    let n = 0;
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      for (const raw of st.scenarios) {
        const s = built.get(raw.id)!;
        const keys = raw.actions.map((a) => a.key);
        const sum = (h: string, ks: string[]) => ks.reduce((x, k) => x + (s.strategy[h][k] ?? 0), 0);
        const lines = cautionLines(s);
        (raw.flags ?? []).forEach((f, i) => {
          const H = handsOf(f.hands) as string[], V = handsOf(f.vs) as string[];
          const ex = /\(예: (\S+) .*?, (\S+) .*?\)/.exec(lines[i]);
          let want: (string | undefined)[] | null = null;
          if (f.code === "PF-SANITY-9") {
            const r = (h: string) => sum(h, keys.filter((k) => ["3bet", "squeeze", "shove"].includes(k)));
            want = [first(LSC.filter((h) => H.includes(h)), r), first(WHEEL.filter((h) => V.includes(h)), r)];
          } else if (f.code === "PF-SANITY-11") {
            const r = (h: string) => sum(h, keys.filter((k) => RAISES.has(k)));
            want = [first(BIG.filter((h) => H.includes(h)), (h) => -r(h)), first(MID.filter((h) => V.includes(h)), r)];
          } else if (f.code === "PF-SANITY-13") {
            const jam = (h: string) => s.strategy[h].shove ?? 0;
            const pairs: [string, string][] = [];
            for (const lo of JAM.filter((h) => H.includes(h)))
              for (const hi of JAM.filter((h) => H.includes(h) || V.includes(h)))
                if (JAM.indexOf(hi) < JAM.indexOf(lo) && jam(lo) >= jam(hi) + 0.5 - 1e-9) pairs.push([lo, hi]);
            want = widest(pairs, ([lo, hi]) => jam(lo) - jam(hi)) ?? null;
          } else if (f.code === "PF-SANITY-14") {
            const plays = (h: string) => 1 - s.strategy[h].fold;
            const pairs: [string, string][] = [];
            for (const a of HIGH.filter((h) => H.includes(h))) for (const b of LOW.filter((h) => V.includes(h))) if (plays(a) <= plays(b) - 0.3 + 1e-9) pairs.push([a, b]);
            want = widest(pairs, ([a, b]) => plays(b) - plays(a)) ?? null;
          }
          if (want === null) return; // -12 quotes every hand
          expect(ex, `${raw.id} ${f.code}: ${lines[i]}`).not.toBeNull();
          expect([ex![1], ex![2]], `${raw.id} ${f.code}: ${lines[i]}`).toEqual(want);
          n++;
        });
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it("coach facts: an artifact cell (hands, vs of 9 and 14) or a comparison hand (vs of 11 and 13), as the quiz skips them", () => {
    let comparisons = 0;
    for (const st of PREFLOP_STAGES) {
      const built = byId(builtStage(st.id));
      for (const raw of st.scenarios) {
        const s = built.get(raw.id)!;
        const lines = cautionLines(s);
        for (const h of ALL_HANDS) {
          const want: string[] = [], wantAll: string[] = [];
          (raw.flags ?? []).forEach((f, i) => {
            const inH = handsOf(f.hands).includes(h), inV = handsOf(f.vs).includes(h);
            const tail = inH || (inV && (f.code === "PF-SANITY-9" || f.code === "PF-SANITY-14")) ? [ARTIFACT_CELL_FACT] : inV ? [COMPARISON_FACT] : [];
            if (inH || inV) want.push(`모델 한계: ${lines[i]}`, ...tail);
            wantAll.push(`모델 한계: ${lines[i]}`, ...tail);
          });
          expect(cautionFacts(s, h), `${raw.id} ${h}`).toEqual(want);
          expect(cautionFacts(s, h, true), `${raw.id} ${h}`).toEqual(wantAll);
          // The artifact line goes exactly with the hands the quiz never deals.
          expect(want.includes(ARTIFACT_CELL_FACT), `${raw.id} ${h}`).toBe(!!s.quizSkip?.[h]);
          if (want.includes(COMPARISON_FACT)) comparisons++;
        }
      }
    }
    expect(comparisons).toBeGreaterThan(0);
  });

  it("the grid notches exactly the marked cells; the hand card, the legend item and the heavy-spot note follow the data", () => {
    const st = builtStage("100bb-2.2");
    let notched = 0;
    for (const s of st.scenarios) {
      const html = renderToString(createElement(RangeGrid, { scenario: s, selected: null, onPick: () => {} }));
      const marked = Object.keys(s.close ?? {}).length;
      expect(html.match(/class="cell [^"]*? close"/g)?.length ?? 0, s.id).toBe(marked);
      notched += marked;
    }
    expect(notched).toBeGreaterThan(0);
    // rfi-sb: many marks, so the heavy-spot note; TT's hand card names both actions.
    const sb = byId(st).get("rfi-sb")!;
    const marked = Object.keys(sb.close ?? {}).length;
    expect(marked).toBeGreaterThanOrEqual(HEAVY_CLOSE_SHARE * 169);
    expect(isHeavyClose(sb)).toBe(true);
    const tt = closeActions(sb, "TT")!;
    expect(tt.length).toBeGreaterThanOrEqual(2);
    const note = renderToString(createElement(CloseNote, { scenario: sb, hand: "TT", eps: st.closeEps })).replace(/<!-- -->/g, "");
    const label = (k: string) => legendActions(sb).find((a) => a.key === k)!.label;
    const chart = tt.find((k) => sb.strategy.TT[k] >= 0.999)!;
    expect(note).toBe(`<p class="close-note">차트는 ${label(chart)}만 보여 주지만 ${tt.filter((k) => k !== chart).map(label).join("·")}도 EV 차이가 0.05bb 이내라 거의 같아요.</p>`);
    expect(renderToString(createElement(CloseNote, { scenario: sb, hand: ALL_HANDS.find((h) => !sb.close?.[h])!, eps: st.closeEps }))).toBe("");
    for (const stage of solver.stages)
      for (const s of stage.scenarios) {
        const m = Object.keys(s.close ?? {}).length;
        expect(isHeavyClose(s), s.id).toBe(m > 0 && m >= 0.25 * ALL_HANDS.filter((h) => inReach(s, h)).length);
      }
    // The charts page's first spot: its marks on the grid and the "EV 거의 같음" legend item.
    const before = settingsStore.get();
    try {
      settingsStore.set({ ...before, chartSet: "solver" });
      const html = renderToString(createElement(ChartsPage)).replace(/<!-- -->/g, "");
      const first = st.scenarios[0];
      expect(Object.keys(first.close ?? {}).length).toBeGreaterThan(0);
      expect(html.match(/class="cell [^"]*? close"/g)?.length).toBe(Object.keys(first.close!).length);
      expect(html).toContain('<i class="close"></i>EV 거의 같음');
      expect(html.includes("표시된 칸이 많아요")).toBe(isHeavyClose(first));
    } finally {
      settingsStore.set(before);
    }
  });

  it("the quiz grades every action the solver chart plays at least 부분 정답, every accepted near action 정답, never an AA/KK passive tie", () => {
    let mixed10 = 0, close = 0, bigPair = 0;
    for (const stage of solver.stages) {
      const mixedMin = quizMixedMin(stage);
      expect(mixedMin).toBeLessThan(0.1);
      for (const s of stage.scenarios)
        for (const h of ALL_HANDS) {
          if (!inReach(s, h)) continue;
          const near = quizCloseActions(s, h);
          for (const a of scenarioActions(s)) {
            const f = s.strategy[h][a.key] ?? 0, g = gradeAnswer(s, h, a.key, mixedMin);
            if (f > 1e-9) expect(g, `${s.id} ${h} ${a.key} ${f}`).not.toBe("wrong");
            else expect(g, `${s.id} ${h} ${a.key}`).toBe(near?.includes(a.key) ? "close" : "wrong");
            if (g === "mixed" && f < 0.2) mixed10++;
            if (g === "close") close++;
          }
          // AA and KK: a passive action the chart does not take is never accepted as close, and the caveat shows.
          if ((h === "AA" || h === "KK") && closeActions(s, h)?.some((k) => k !== "fold" && !RAISE_KEYS.has(k))) {
            bigPair++;
            expect(bigPairCloseNote(s, h), `${s.id} ${h}`).not.toBeNull();
            for (const k of closeActions(s, h)!)
              if (k !== "fold" && !RAISE_KEYS.has(k) && s.strategy[h][k] < 0.999) expect(gradeAnswer(s, h, k, mixedMin), `${s.id} ${h} ${k}`).toBe("wrong");
          } else expect(bigPairCloseNote(s, h)).toBeNull();
        }
    }
    expect(mixed10).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(0);
    console.info(`quiz grading: ${mixed10} 10% actions graded 부분 정답, ${close} close answers, ${bigPair} AA/KK passive ties`);
  });

  it("every spot the quiz can pick still has a hand to deal", () => {
    for (const st of solver.stages)
      for (const s of st.scenarios) {
        if (!((s.weight ?? 1) > 0)) continue;
        expect(ALL_HANDS.some((h) => inReach(s, h) && !s.quizSkip?.[h]), s.id).toBe(true);
      }
  });
});
