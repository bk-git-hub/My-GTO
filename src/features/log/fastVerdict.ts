import { fullDeck, type HandClass } from "../../poker/cards";
import { chartOffers, LOW_LIMP_SOFT, LOW_SOFT, lowConfidenceLimp, lowLimpJam, MODEL_GAP_SOFT } from "../../play/chartGrade";
import { chartFor, PICK_FOR_STAGE, type ChartHit, type ChartPick } from "../../play/computedChart";
import { act, legal, newGame, type Game } from "../../play/engine";
import { openSize, STAGE_STACK, type MoveOption, type PreflopDecision, type PreflopSpot } from "../../play/policy";
import { solverStageMeta } from "../../data/sets/solverSpot";
import type { PreAction, PreStage } from "./quickPre";
import { positionsFor } from "./recorder";

/**
 * 빠른 기록's verdict: was my preflop action in the chart for the stage, mixed, an overplay or an underplay.
 * The chart is the computed one of the screen's stage (computedChart.ts PICK_FOR_STAGE, the same charts as the
 * 아재's judgeChart.ts: our solver's 100bb with the 3bb open at 딥, 55bb at 미들, the short-stack chart at 17bb at 숏,
 * push/fold at 10bb at 푸시), looked up like a hand review does: an engine game built from the spot (fastGame),
 * then chartFor. The verdict names it ("· 솔버 100bb 기준"). Where the computed charts have no spot (a limp, an open
 * at the push stage, a shove at 딥 or 미들 where no one jams first in, a 3-bet whose seat isn't recorded, a cold
 * 3-bet) the verdict is "차트 없음", never the hand-made pub chart. As the hand review's grade (chartGrade.ts), a limp
 * or flat the short-stack and push/fold models leave out, and a limp or open of a premium a low-confidence solver line
 * limps, are "참고" (kind "none", `ref`), not graded; that premium's all-in is "△ 신뢰도 낮은 차트" where the chart's
 * tree has an all-in and "⚠ 오버플레이 (차트: 올인 없음)" where it has none, never "(차트: 림프)". Pure.
 */

/** What happened before my decision. "3bet": my open got 3-bet (or more); "cold3": someone opened and another 3-bet before me. */
export const FAST_SPOTS = ["none", "limp", "open", "shove", "3bet", "cold3"] as const;
export type FastSpot = (typeof FAST_SPOTS)[number];
export const isFastSpot = (x: unknown): x is FastSpot => typeof x === "string" && (FAST_SPOTS as readonly string[]).includes(x);

export const SPOT_LABEL: Record<FastSpot, string> = { none: "폴드로 나에게", limp: "림프 있음", open: "오픈 있음", shove: "올인 있음", "3bet": "3벳 이상", cold3: "콜드 3벳" };

/** A 3-bet before my action: over my open, or between two others. */
export const isThreeBet = (s: FastSpot): boolean => s === "3bet" || s === "cold3";

/** The seats that act before `seat` preflop (who can have limped, opened or shoved before me). */
export function seatsBefore(players: number, seat: string): string[] {
  const seats = positionsFor(players);
  const i = seats.indexOf(seat);
  return i < 0 ? [] : seats.slice(0, i);
}

/**
 * The spots that can happen at my seat: a limp, an open or a shove needs a seat before me; a 3-bet over
 * my open needs a seat that can open (not the BB); a cold 3-bet two seats before me (the opener, the 3-bettor).
 */
export function spotsFor(players: number, seat: string): FastSpot[] {
  if (!positionsFor(players).includes(seat)) return ["none"];
  const before = seatsBefore(players, seat).length;
  return FAST_SPOTS.filter((s) => (s === "none" ? true : s === "3bet" ? seat !== "BB" : s === "cold3" ? before >= 2 : before > 0));
}

/**
 * My choices in a spot. Unopened: 폴드 · 림프 · 오픈 · 올인 (the BB has nothing to decide: a walk).
 * Facing a limp: 폴드 · 콜 · 오픈 (iso) · 올인, the BB 체크 · 레이즈 · 올인. Facing an open: 폴드 · 콜 · 3벳 · 올인.
 * Facing a shove: 폴드 · 콜. Facing a 3-bet (mine or cold): 폴드 · 콜 · 4벳 (stored as "3bet") · 올인.
 */
export function actsFor(spot: FastSpot, seat: string): PreAction[] {
  switch (spot) {
    case "none":
      return seat === "BB" ? [] : ["fold", "limp", "open", "allin"];
    case "limp":
      return seat === "BB" ? ["call", "open", "allin"] : ["fold", "call", "open", "allin"];
    case "open":
      return ["fold", "call", "3bet", "allin"];
    case "shove":
      return ["fold", "call"];
    case "3bet":
    case "cold3":
      return ["fold", "call", "3bet", "allin"];
  }
}

/** A choice's name in its spot: the 3bet chip reads 4벳 facing a 3-bet; facing a limp 콜 is an overlimp (the BB's a check). */
export function actLabel(spot: FastSpot, act: PreAction, seat: string): string {
  if (spot === "limp") {
    if (act === "call") return seat === "BB" ? "체크" : "콜";
    if (act === "open") return seat === "BB" ? "레이즈" : "아이소";
  }
  if (isThreeBet(spot) && act === "3bet") return "4벳";
  return { fold: "폴드", limp: "림프", open: "오픈", call: "콜", "3bet": "3벳", allin: "올인" }[act];
}

export interface FastInput {
  stage: PreStage;
  players: number;
  seat: string;
  /** "AJo", "AJs", "TT". */
  cls: HandClass;
  spot: FastSpot;
  /** Who opened or shoved before me (spot "open" / "shove"). */
  opener?: string;
  /** My action; none for a walk. */
  act?: PreAction;
}

export type VerdictKind = "ok" | "mixed" | "over" | "under" | "none";

export interface Verdict {
  kind: VerdictKind;
  /** A chart answered but only for reference, not graded ("참고 · …", kind "none"): counted apart from 차트 없음. */
  ref?: true;
  /** "✓ 차트대로", "△ 섞는 핸드", "⚠ 오버플레이 (차트: 폴드)", "▽ 언더플레이 (차트: 오픈 72%)", "차트 없음". */
  text: string;
  /** What the chart does with this hand: "BTN 오픈 레인지 · 오픈 100%"; "" without a chart. */
  chart: string;
  /** How often the chart takes my action (0~1), null without a chart. */
  freq: number | null;
}

const none = (text = "차트 없음"): Verdict => ({ kind: "none", text, chart: "", freq: null });
/** "참고 · <why>": a chart answered, but not to grade by. */
const ref = (why: string): Verdict => ({ kind: "none", ref: true, text: `참고 · ${why}`, chart: "", freq: null });

/** The moves a chart offers, by what I could have tapped. */
type Group = "fold" | "call" | "raise" | "allin";
/** How much each move puts in: a shove is more than the chart's raise (a 100bb open-jam over a 3bb open). */
const LEVEL: Record<Group, number> = { fold: 0, call: 1, raise: 2, allin: 3 };
/** A chart raise to this share of the stack or more commits it: a shove instead is only a size (a deep 4-bet to ~21 of 100bb). */
const COMMIT = 0.2;
const GROUPS: Group[] = ["allin", "raise", "call", "fold"];

const pct = (f: number) => `${Math.round(f * 100)}%`;
/** An overplay's reason when the chart has no all-in at all ("⚠ 오버플레이 (차트: 올인 없음)"). */
const NO_JAM = "올인 없음";

/** The spot as the chart lookup sees it: a stack for the stage, the blinds posted, the open's usual size. */
export function spotOf(i: FastInput): PreflopSpot | null {
  const stack = STAGE_STACK[i.stage];
  if (!stack) return null;
  const blind = i.seat === "SB" ? 0.5 : i.seat === "BB" ? 1 : 0;
  const base = { mode: "pub" as const, stageId: i.stage, seat: i.seat, myBet: blind, myStack: stack - blind, limpers: 0, iAmOpener: false, facingAllIn: false };
  switch (i.spot) {
    case "none":
      return { ...base, raises: 0, currentBet: 1 };
    case "open":
      return { ...base, raises: 1, openerSeat: i.opener, lastRaiserSeat: i.opener, currentBet: openSize("pub", i.stage, i.opener ?? "") };
    case "shove":
      return { ...base, raises: 1, openerSeat: i.opener, lastRaiserSeat: i.opener, facingAllIn: true, currentBet: stack };
    case "3bet": {
      // My open, then a 3-bet: short stacks 3-bet all-in, so there it is a call-or-fold spot.
      const open = openSize("pub", i.stage, i.seat);
      const shoved = i.stage === "short" || i.stage === "push";
      return { ...base, raises: 2, openerSeat: i.seat, iAmOpener: true, facingAllIn: shoved, myBet: open, myStack: stack - open, currentBet: shoved ? stack : open * 3 };
    }
    case "cold3": {
      // Someone's open and another's 3-bet (a shove at short stacks): the policy continues with premiums only.
      const shoved = i.stage === "short" || i.stage === "push";
      return { ...base, raises: 2, facingAllIn: shoved, currentBet: shoved ? stack : openSize("pub", i.stage, "") * 3 };
    }
    case "limp":
      return null;
  }
}

/**
 * The spot as an engine game at the chart's stack, with the hero to act: the seats before fold, an opener opens to
 * the chart's own size (or shoves). Null when the spot doesn't fit the table.
 */
export function fastGame(i: FastInput, pick: ChartPick = PICK_FOR_STAGE[i.stage]): Game | null {
  const seats = positionsFor(i.players);
  const hero = seats.indexOf(i.seat);
  if (hero < 0) return null;
  let g = newGame(pick.stack, hero, fullDeck(), { seats, bbAnte: true });
  const until = (seat: string) => {
    while (!g.done && g.toAct !== null && g.players[g.toAct].seat !== seat) g = act(g, "fold");
    return !g.done && g.toAct !== null;
  };
  if (i.spot === "open" || i.spot === "shove") {
    if (!i.opener || !until(i.opener)) return null;
    const meta = pick.source === "solver" ? solverStageMeta(pick.stageId) : null;
    const size = meta ? (i.opener === "SB" ? meta.sbRaise : meta.open) : pick.open || 2;
    g = act(g, "raise", i.spot === "shove" ? legal(g, g.toAct!).maxRaiseTo : size);
  }
  if (!until(i.seat)) return null;
  return g;
}

/** The input names a real spot: my seat at this table, an opener before me, an action the spot offers. */
export function validInput(i: FastInput): boolean {
  if (!positionsFor(i.players).includes(i.seat)) return false;
  if (!spotsFor(i.players, i.seat).includes(i.spot)) return false;
  if (i.spot === "open" || i.spot === "shove") {
    if (!i.opener || !seatsBefore(i.players, i.seat).includes(i.opener)) return false;
  }
  // No action only for a walk (folded to the BB).
  return i.act === undefined ? i.spot === "none" && i.seat === "BB" : actsFor(i.spot, i.seat).includes(i.act);
}

/** My action's group; facing an all-in a call, a "4bet" or a shove all just call it. */
function myGroup(act: PreAction, facingAllIn: boolean): Group {
  if (act === "fold") return "fold";
  if (facingAllIn) return "call";
  if (act === "limp" || act === "call") return "call";
  return act === "allin" ? "allin" : "raise";
}

/** A chart move's name in this spot. */
function groupLabel(g: Group, i: FastInput): string {
  if (g === "fold") return "폴드";
  // first in, a call is a limp (the solver's SB limps)
  if (g === "call") return i.spot === "none" ? "림프" : "콜";
  const head = i.spot === "open" ? "3벳" : isThreeBet(i.spot) ? "4벳" : null;
  if (g === "allin") return head ? `${head} 올인` : "올인";
  return head ?? (i.stage === "short" ? "2bb 오픈" : "오픈");
}

/**
 * The verdict for my action. f = how often the chart takes it: f ≥ 0.5 ✓ 차트대로; 0 < f < 0.5 △ 섞는
 * 핸드; f = 0: an overplay when more of the chart is less aggressive than my action (chips in where it
 * folds, a 3-bet where it calls, a shove where it raises), else an underplay. A raise of another size
 * than the chart's counts as the chart's raise, with its size named: a small raise where it shoves, and
 * a shove where its raise commits the stack anyway (short and push stacks, a deep 4-bet). A deep or
 * middle-stack shove where the chart makes a small raise (a 100bb open-jam) is an overplay. No chart for
 * the spot (facing a limp, a walk, a spot the charts don't cover): 차트 없음, as the grading's "info".
 */
export function fastVerdict(i: FastInput, decide?: (spot: PreflopSpot) => PreflopDecision): Verdict {
  if (!validInput(i)) return none();
  if (i.act === undefined) return none("워크");
  if (i.spot === "limp") return none("차트 없음 · 림프 팟");
  let spot = spotOf(i);
  if (!spot) return none();
  let pick: ChartPick | null = null;
  let hit: ChartHit | null = null;
  let moves: MoveOption[];
  let title = "";
  try {
    if (decide) {
      // A made-up chart (tests).
      const dec = decide(spot);
      title = dec.scenario?.title ?? dec.label;
      moves = dec.moves(i.cls);
    } else {
      if (i.spot === "3bet") return none("차트 없음 · 3벳한 자리 몰라요");
      if (i.spot === "cold3") return none("차트 없음 · 콜드 3벳");
      pick = PICK_FOR_STAGE[i.stage];
      const g = fastGame(i, pick);
      if (!g) return none();
      const idx = g.toAct!;
      const ans = chartFor(g, idx, { pin: pick });
      if (!ans.ok) return none(`차트 없음 · ${ans.text.split(" · ").slice(1).join(" · ")}`);
      const me = g.players[idx];
      spot = { ...spot, myBet: me.streetBet, myStack: me.stack };
      title = `${pick.name} ${ans.scenario.title}`;
      moves = ans.moves(i.cls, legal(g, idx).maxRaiseTo);
      hit = ans;
      // A limp or open (not a fold or an all-in) of a premium the low-confidence chart limps.
      const mine0 = myGroup(i.act, spot.facingAllIn);
      if ((mine0 === "call" || mine0 === "raise") && lowConfidenceLimp(ans, i.cls)) return ref(LOW_LIMP_SOFT);
    }
  } catch {
    return none();
  }
  if (!moves.length) return none();
  const allInTo = spot.myBet + spot.myStack;
  const freq: Record<Group, number> = { fold: 0, call: 0, raise: 0, allin: 0 };
  /** The chart's biggest raise short of all-in (bb). */
  let raiseTo = 0;
  for (const m of moves) {
    const g: Group = m.kind === "fold" ? "fold" : m.kind === "call" || m.kind === "check" ? "call" : (m.to ?? 0) >= allInTo - 1e-9 ? "allin" : "raise";
    freq[g] += m.prob;
    if (g === "raise") raiseTo = Math.max(raiseTo, m.to ?? 0);
  }
  const chart = `${title} · ${GROUPS.filter((g) => freq[g] > 1e-9)
    .sort((a, b) => freq[b] - freq[a])
    .map((g) => `${groupLabel(g, i)} ${pct(freq[g])}`)
    .join(" · ")}`;
  const mine = myGroup(i.act, spot.facingAllIn);
  let f = freq[mine];
  let size = "";
  // A shove for the chart's raise is only a size when short stacks shove anyway or the raise commits the stack.
  const jamIsSize = i.stage === "short" || i.stage === "push" || raiseTo >= COMMIT * allInTo;
  if ((mine === "raise" || (mine === "allin" && jamIsSize)) && f < 1e-9) {
    // A raise of another size than the chart's: the chart's raise, its size named.
    const other: Group = mine === "raise" ? "allin" : "raise";
    if (freq[other] > 1e-9) {
      f = freq[other];
      size = groupLabel(other, i);
    }
  }
  // A limp or flat the short-stack and push/fold models don't have: only a hand they fold outright is graded.
  if (hit && hit.pick.source !== "solver" && !size && !chartOffers(hit, mine, allInTo) && freq.fold < 1 - 1e-9) return ref(MODEL_GAP_SOFT);
  // The verdict names its chart: "✓ 차트대로 · 솔버 100bb 기준".
  const named = (t: string) => (pick ? `${t} · ${pick.name} 기준` : t);
  // The all-in of a premium the low-confidence chart limps (the SB's AA), as the hand review grades it: never "차트:
  // 림프", the limp the chart is doubted for. A △ where the chart's tree has an all-in; where it has none (딥, 미들) an
  // overplay of an all-in the chart doesn't have.
  const lowJam = hit && mine === "allin" && f < 1e-9 ? lowLimpJam(hit, i.cls, allInTo) : null;
  if (lowJam === "soft") return { kind: "mixed", text: named(`△ ${LOW_SOFT}`), chart, freq: 0 };
  if (lowJam === "offTree") return { kind: "over", text: named(`⚠ 오버플레이 (차트: ${NO_JAM})`), chart, freq: 0 };
  const sized = (t: string) => named(size ? `${t} · 차트는 ${size}` : t);
  if (f >= 0.5 - 1e-9) return { kind: "ok", text: sized("✓ 차트대로"), chart, freq: f };
  if (f > 1e-9) return { kind: "mixed", text: sized(`△ 섞는 핸드 (${pct(f)})`), chart, freq: f };
  // Never in the chart: weigh what the chart does less and more aggressively than I did.
  const lv = LEVEL[mine];
  const less = GROUPS.filter((g) => LEVEL[g] < lv);
  const more = GROUPS.filter((g) => LEVEL[g] > lv);
  const sum = (gs: Group[]) => gs.reduce((a, g) => a + freq[g], 0);
  const top = (gs: Group[]) => gs.reduce((b, g) => (freq[g] > freq[b] ? g : b), gs[0]);
  const move = (g: Group) => `${groupLabel(g, i)}${freq[g] < 0.995 ? ` ${pct(freq[g])}` : ""}`;
  if (less.length && sum(less) >= sum(more)) return { kind: "over", text: named(`⚠ 오버플레이 (차트: ${move(top(less))})`), chart, freq: 0 };
  return { kind: "under", text: named(`▽ 언더플레이 (차트: ${move(top(more))})`), chart, freq: 0 };
}

/**
 * The verdict worded for another player's hand (남의 핸드): information about how pub players play, not
 * a mistake. An overplay reads "⚠ 차트보다 루즈 (차트: 폴드)", an underplay "▽ 차트보다 타이트 (차트: 오픈)";
 * the rest (✓ 차트대로, △ 섞는 핸드, 차트 없음) stays as it is.
 */
export function theirWords(v: Verdict): Verdict {
  return { ...v, text: v.text.replace("오버플레이", "차트보다 루즈").replace("언더플레이", "차트보다 타이트") };
}

/** The verdict's one-word mark for tight lists: ✓ △ ⚠ ▽ or –. */
export const VERDICT_MARK: Record<VerdictKind, string> = { ok: "✓", mixed: "△", over: "⚠", under: "▽", none: "–" };

/** The verdict in 지난 기록's rows: "– 차트 없음 · 림프 팟", but a 참고 without the dash ("참고 · …" is its own mark). */
export const listVerdictText = (v: Verdict): string => (v.kind === "none" && !v.ref ? `${VERDICT_MARK.none} ${v.text}` : v.text);
