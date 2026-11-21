import { ALL_HANDS, comboCount } from "../poker/cards";
import { parseRange } from "../poker/range";
import type { Verb } from "../poker/preflop/tree";
import { canonicalBoard, type FileEntry, type Manifest, type ScenarioMeta } from "../presolve/format";
import { chartSeat } from "./chartSeat";
import { pot, type Game } from "./engine";
import { preflopLine } from "./preflopLine";
import { isGto } from "./profile";
import type { PlayState } from "./table";

/**
 * The solver pack registry of the AI table: which heads-up flop pack (public/packs/manifest.json) stands for the flop
 * two players reached, read from manifest data only, so every new heads-up pack is picked up with no code change.
 *
 * A pack competes when (1) the two lines have the pack's structure (the verbs of each seat's preflop actions: "call" for
 * the BB and "open" for the raiser of a single raised pot), the same OOP seat, (2) the stack-to-pot ratio is within
 * [0.7, 1.45] of the pack's, and (3) each seat's nominal range (the product of its GTO chart frequencies along its line,
 * seatLine.ts) is close to the pack's own starting range, in both directions: at most 30% of our combos in classes the
 * pack never holds, an L1 distance of at most 30 points of all hands, and a width (share of all hands) within
 * [0.55, 1.8] of the pack's. The width limit is what keeps a much wider pack away from a narrow range: a 15% UTG open
 * lies inside the 38% BTN pack (nothing "outside") and within 30 points of it, yet the BTN solution c-bets such a range
 * some 26 points more often than the UTG one. Exact: the same chart refs, seats and format, and the SPR within 5%.
 * Otherwise approximate, each difference named in a short reason. Ranking: a pack of the same two seats before a pack
 * of another opener's seat, then by 2·outside + L1/100 + |ln SPR ratio| + |ln width ratio|. A pack that lacks this
 * flop's file falls through to the next one. Pure.
 */

export const MATCH_LIMITS = { outside: 0.3, l1: 30, widthMin: 0.55, widthMax: 1.8, sprMin: 0.7, sprMax: 1.45, exactSpr: 0.05 };
export const LINE_SEP = " × ";

export interface PackSide {
  /** Chart seat ("BB", "BTN"). */
  seat: string;
  refs: string[];
  verbs: Verb[];
  /** The pack's starting range per class (ALL_HANDS order). */
  classFreq: Float64Array;
}

export interface PackInfo {
  id: string;
  version: number;
  title: string;
  meta: ScenarioMeta;
  /** Canonical board key → file. */
  files: Map<string, FileEntry>;
  /** [OOP, IP]. */
  sides: [PackSide, PackSide];
}

/** A chart ref's verb: its action key, read in its spot ("raise" first in is an open, over an SB limp an iso). */
export function refVerb(ref: string): Verb {
  const [path, key = ""] = ref.split(":");
  const spot = path.split("/").pop() ?? "";
  if (key === "call" || key === "overcall") return "call";
  if (key === "limp" || key === "check" || key === "fold" || key === "open" || key === "3bet" || key === "squeeze" || key === "4bet") return key;
  if (key === "shove") return "jam";
  if (key === "raise") return spot.startsWith("rfi-") ? "open" : spot.includes("limp") ? "iso" : "3bet";
  return "call";
}

/**
 * The packs the AI table can play: two positions, action nodes stored (no slim calibration files), files present. An
 * entry that can't be read (a side's range or source missing, a bad range string, no pot or stack) is left out, so one
 * malformed pack never takes the others down.
 */
export function packIndex(m: Manifest): PackInfo[] {
  const out: PackInfo[] = [];
  for (const p of m.packs ?? []) {
    try {
      const meta = p.scenario;
      if (!meta || meta.storage === "rootClasses" || meta.positions?.length !== 2 || !p.files?.length || !meta.ranges || !meta.rangeSources) continue;
      if (!(meta.pot > 0) || !(meta.stack > 0)) continue;
      if ([0, 1].some((i) => typeof meta.rangeSources![i] !== "string" || typeof meta.ranges[i] !== "string" || typeof meta.positions[i] !== "string")) continue;
      const sides = [0, 1].map((i): PackSide => {
        const refs = meta.rangeSources![i].split(LINE_SEP).map((r) => r.trim());
        const range = parseRange(meta.ranges[i]);
        return { seat: meta.positions[i], refs, verbs: refs.map(refVerb), classFreq: Float64Array.from(ALL_HANDS, (h) => range[h] ?? 0) };
      }) as [PackSide, PackSide];
      if (sides.some((x) => !x.classFreq.some((f) => f > 0))) continue;
      out.push({ id: p.id, version: p.version, title: p.title, meta, files: new Map(p.files.filter((f) => f && typeof f.board === "string").map((f) => [f.board, f])), sides });
    } catch {
      continue;
    }
  }
  return out;
}

export interface SeatLine {
  idx: number;
  /** Chart seat and table seat. */
  seat: string;
  tableSeat: string;
  verbs: Verb[];
  refs: (string | null)[];
  /** Nominal range per class (ALL_HANDS order), or null when the seat's steps weren't recorded. */
  freq: Float64Array | null;
}

export interface Dist {
  /** L1 distance, points of all 1326 hands. */
  l1: number;
  /** Our combo mass in classes the pack never holds, over our mass. */
  outside: number;
  /** The pack's combo mass in classes we never hold, over the pack's mass (the other direction of `outside`). */
  extra: number;
  /** Our range's width over the pack's (shares of all hands): 0.4 = ours is 40% as wide. */
  width: number;
  /** Our range's share of all hands, and the pack's (0..1). */
  share: number;
  packShare: number;
}

export interface PackMatch {
  packId: string;
  version: number;
  title: string;
  level: "exact" | "approx";
  reasons: string[];
  /** Engine indices [OOP, IP]. */
  seats: [number, number];
  /** Real flop pot ÷ the pack's flop pot. */
  potScale: number;
  /** [real, pack]. */
  spr: [number, number];
  dist: [Dist, Dist];
  file: FileEntry;
}

/** Postflop order: the SB first, then the BB, then UTG to the BTN. */
export const postflopRank = (g: Game, idx: number) => {
  const n = g.players.length;
  return idx >= n - 2 ? idx - (n - 2) : idx + 2;
};

/** The two players who see the flop, OOP first, or null when it isn't heads-up. */
export function flopPair(g: Game): [number, number] | null {
  const live = g.players.map((_, i) => i).filter((i) => !g.players[i].folded);
  if (live.length !== 2) return null;
  return live.sort((a, b) => postflopRank(g, a) - postflopRank(g, b)) as [number, number];
}

/** The two flop players' lines (OOP first): verbs from the real log, refs and nominal ranges from s.lines. */
export function seatLines(s: PlayState): [SeatLine, SeatLine] | null {
  const g = s.game;
  const pair = flopPair(g);
  if (!pair) return null;
  const seats = g.players.map((p) => p.seat);
  const l = preflopLine(g, pair[0]);
  const out = pair.map((idx): SeatLine => {
    const verbs = l.steps.filter((st) => st.idx === idx).map((st) => st.verb);
    const steps = s.lines?.[idx] ?? [];
    let freq: Float64Array | null = null;
    if (steps.length === verbs.length && steps.length) {
      freq = new Float64Array(ALL_HANDS.length).fill(1);
      for (const st of steps) for (let i = 0; i < freq.length; i++) freq[i] *= st.freq[i];
    }
    return { idx, seat: chartSeat(seats, seats[idx]), tableSeat: seats[idx], verbs, refs: steps.map((st) => st.ref), freq };
  });
  return out as [SeatLine, SeatLine];
}

export function rangeDist(ours: Float64Array, pack: Float64Array): Dist {
  let l1 = 0, mass = 0, outside = 0, packMass = 0, extra = 0;
  ALL_HANDS.forEach((h, i) => {
    const n = comboCount(h);
    l1 += n * Math.abs(ours[i] - pack[i]);
    mass += n * ours[i];
    packMass += n * pack[i];
    if (pack[i] <= 0) outside += n * ours[i];
    if (ours[i] <= 0) extra += n * pack[i];
  });
  return {
    l1: (l1 / 1326) * 100,
    outside: mass > 0 ? outside / mass : 1,
    extra: packMass > 0 ? extra / packMass : 1,
    width: packMass > 0 ? mass / packMass : 0,
    share: mass / 1326,
    packShare: packMass / 1326,
  };
}

/** The range distance passes MATCH_LIMITS. */
export const distOk = (d: Dist) => d.outside <= MATCH_LIMITS.outside && d.l1 <= MATCH_LIMITS.l1 && d.width >= MATCH_LIMITS.widthMin && d.width <= MATCH_LIMITS.widthMax;

const SET_WORD: Record<string, string> = { pub: "펍 차트", cash6: "캐시 차트", solver: "솔버 차트", shortnash: "숏스택 차트", nash: "푸시폴드 차트" };
const VERB_WORD: Partial<Record<Verb, string>> = { open: "오픈", call: "콜", "3bet": "3벳", squeeze: "스퀴즈", "4bet": "4벳", jam: "올인", limp: "림프", iso: "레이즈" };
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The flop's pot and the smaller stack behind as they were when the flop was dealt. */
export function flopStart(g: Game, pair: [number, number]): { pot: number; stack: number } {
  const bets = g.street === "flop" ? g.players.reduce((a, p) => a + p.streetBet, 0) : 0;
  const stack = Math.min(...pair.map((i) => g.players[i].stack + (g.street === "flop" ? g.players[i].streetBet : 0)));
  return { pot: pot(g) - bets, stack };
}

/**
 * The two flop lines when some pack could stand for them: heads-up, not a limped pot, both lines on the GTO charts
 * (every step recorded with its chart ref). Without them no manifest is needed (packOracle.ts needs).
 */
export function matchableLines(s: PlayState): [SeatLine, SeatLine] | null {
  const g = s.game;
  if (g.board.length < 3) return null;
  const lines = seatLines(s);
  if (!lines) return null;
  const pl = preflopLine(g, lines[0].idx);
  if (pl.otherLimp || pl.sbLimp) return null;
  if (lines.some((x) => !x.freq || x.refs.some((r) => r === null))) return null;
  return lines;
}

/** The best pack for the flop of `s` (heads-up, both lines recorded), or null. */
export function matchPack(s: PlayState, packs: readonly PackInfo[]): PackMatch | null {
  const g = s.game;
  const lines = matchableLines(s);
  if (!lines) return null;
  const pair: [number, number] = [lines[0].idx, lines[1].idx];
  const start = flopStart(g, pair);
  const realSpr = start.stack / start.pot;
  const board = canonicalBoard(g.board.slice(0, 3)).key;
  const format = s.mode === "cash" ? "cash" : "pub";
  const ourSet = (lines[0].refs[0] ?? "").split("/")[0];
  type Cand = { m: PackMatch; score: number; cross: boolean };
  const cands: Cand[] = [];
  for (const pk of packs) {
    const [po, pi] = pk.sides;
    if (!sameList(po.verbs, lines[0].verbs) || !sameList(pi.verbs, lines[1].verbs)) continue;
    if (po.seat !== lines[0].seat) continue;
    const packSpr = pk.meta.stack / pk.meta.pot;
    const ratio = packSpr / realSpr;
    if (!(ratio >= MATCH_LIMITS.sprMin && ratio <= MATCH_LIMITS.sprMax)) continue;
    const dist = [rangeDist(lines[0].freq!, po.classFreq), rangeDist(lines[1].freq!, pi.classFreq)] as [Dist, Dist];
    if (!dist.every(distOk)) continue;
    const file = pk.files.get(board);
    if (!file) continue;
    const sameRefs = sameList(po.refs, lines[0].refs) && sameList(pi.refs, lines[1].refs);
    const sameSeats = pi.seat === lines[1].seat;
    const sameFormat = pk.meta.format === format;
    const exact = sameRefs && sameSeats && sameFormat && Math.abs(ratio - 1) <= MATCH_LIMITS.exactSpr;
    const reasons: string[] = [];
    if (!exact) {
      const packSet = (po.refs[0] ?? "").split("/")[0];
      if (!sameRefs && packSet !== ourSet) reasons.push(`팩은 ${SET_WORD[packSet] ?? packSet} 레인지로 계산`);
      // Another seat's pack: both ranges' widths, so the gap is plain ("LJ 오픈 23% → BTN 팩 38%").
      if (!sameSeats) {
        const verb = VERB_WORD[lines[1].verbs[lines[1].verbs.length - 1]] ?? "";
        reasons.push(`${lines[1].tableSeat} ${verb} ${pct0(dist[1].share)} → ${pi.seat} 팩 ${pct0(dist[1].packShare)}`.replace("  ", " "));
      }
      if (!sameFormat) reasons.push(pk.meta.format === "cash" ? "앤티 없는 캐시 팩" : "앤티 있는 펍 팩");
      if (Math.abs(ratio - 1) > MATCH_LIMITS.exactSpr) reasons.push(`SPR ${r1(realSpr)} → ${r1(packSpr)}`);
    }
    const villain = pair.find((i) => i !== s.heroIdx);
    if (villain !== undefined && !isGto(s.profiles?.[villain])) reasons.push("상대 성향 미반영");
    const widthOff = Math.max(...dist.map((d) => Math.abs(Math.log(d.width))));
    const score = exact ? -1 : 2 * Math.max(dist[0].outside, dist[1].outside) + Math.max(dist[0].l1, dist[1].l1) / 100 + Math.abs(Math.log(ratio)) + widthOff;
    cands.push({
      score,
      cross: !sameSeats,
      m: {
        packId: pk.id,
        version: pk.version,
        title: pk.title,
        level: exact ? "exact" : "approx",
        reasons,
        seats: pair,
        potScale: start.pot / pk.meta.pot,
        spr: [realSpr, packSpr],
        dist,
        file,
      },
    });
  }
  cands.sort((a, b) => Number(a.cross) - Number(b.cross) || a.score - b.score);
  return cands[0]?.m ?? null;
}

/** "지금 있는 솔버 팩 3개: BTN vs BB …": the packs the manifest holds, by title. */
export const packListText = (packs: readonly PackInfo[]) => (packs.length ? `지금 있는 솔버 팩 ${packs.length}개: ${packs.map((p) => p.title).join(" · ")}` : "솔버 팩 없음");
