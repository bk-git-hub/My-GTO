import { legal, type Game } from "../../play/engine";
import { applyStep, freshGame, POSITIONS, type LogStep, type TableInput } from "./recorder";

/**
 * The quick-record screen's preflop block: my stack stage, what I did preflop, the open's size and
 * seat, and my 3-bet size. One small record per hand (`quickPre`), turned into table steps when the
 * hand is carried on to the table.
 */

export const PRE_STAGES = ["deep", "mid", "short", "push"] as const;
export type PreStage = (typeof PRE_STAGES)[number];
export const STAGE_LABEL: Record<PreStage, string> = { deep: "딥", mid: "미들", short: "숏", push: "푸시" };

export const PRE_ACTIONS = ["fold", "limp", "open", "call", "3bet", "allin"] as const;
export type PreAction = (typeof PRE_ACTIONS)[number];
export const ACTION_LABEL: Record<PreAction, string> = { fold: "폴드", limp: "림프", open: "오픈", call: "콜", "3bet": "3벳", allin: "올인" };

export interface QuickPre {
  /** Stack stage the hand was played at: the one tapped when `pinned`, else it follows my stack (or the last stage used). */
  stage?: PreStage;
  /** The stage was tapped: it no longer follows my stack. */
  pinned?: true;
  action?: PreAction;
  /** The open in bb: mine when I opened, else the opener's. */
  openBb?: number;
  /** The open was an all-in (instead of `openBb`). */
  openAllIn?: true;
  /** Who opened, when it wasn't me (used for 콜 · 3벳 · 올인). */
  openerSeat?: string;
  /** My 3-bet as a multiple of the open. */
  threeBetX?: number;
  /** My 3-bet was an all-in (instead of `threeBetX`). */
  threeBetAllIn?: true;
}

/** A size chip: bb, or an all-in. */
export type PreSize = number | "allin";

/** Usual open sizes at each stage (the pub charts). */
export const OPEN_PRESETS: Record<PreStage, PreSize[]> = {
  deep: [3, 3.5, 4],
  mid: [2.2, 2.5, 3],
  short: [2, 2.2, "allin"],
  push: ["allin"],
};
export const THREE_BET_PRESETS: PreSize[] = [3, 3.5, 4, "allin"];

/** Stack depth (bb) → the pub chart stage (also what the hand analysis bot rules use). */
export function stageFor(bb: number): PreStage {
  if (bb >= 85) return "deep";
  if (bb >= 30) return "mid";
  if (bb >= 12) return "short";
  return "push";
}

export const isStage = (x: unknown): x is PreStage => typeof x === "string" && (PRE_STAGES as readonly string[]).includes(x);
const isAction = (x: unknown): x is PreAction => typeof x === "string" && (PRE_ACTIONS as readonly string[]).includes(x);
const r1 = (x: number) => Math.round(x * 10) / 10;
const posNum = (x: unknown, max: number): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= max ? x : null);

/** Size chips for the open row: an all-in is my shove (오픈) or the shove I called (콜), not a size for an open I 3-bet or shoved over. */
export function openPresets(stage: PreStage, action: PreAction | undefined): PreSize[] {
  const all = OPEN_PRESETS[stage] ?? OPEN_PRESETS.mid;
  if (action !== "3bet" && action !== "allin") return all;
  const sizes = all.filter((x) => x !== "allin");
  // At the push stage the open before me is usually a min-raise.
  return sizes.length ? sizes : OPEN_PRESETS.short.filter((x) => x !== "allin");
}

/**
 * The rows the block shows for its action: the open's size, who opened, my 3-bet. For 올인 the opener's
 * seat only once there was an open before me (a size picked): an open-shove needs neither.
 */
export function preRows(pre: QuickPre | undefined): { size: boolean; opener: boolean; threeBet: boolean } {
  const action = pre?.action;
  const overOpen = action === "allin" && (pre?.openBb !== undefined || pre?.openAllIn === true || pre?.openerSeat !== undefined);
  return { size: action === "open" || action === "call" || action === "3bet" || action === "allin", opener: action === "call" || action === "3bet" || overOpen, threeBet: action === "3bet" };
}

/** My 3-bet in bb (street total), when the open's size is known. */
export function threeBetBb(pre: QuickPre): number | null {
  return pre.openBb !== undefined && pre.threeBetX !== undefined ? r1(pre.openBb * pre.threeBetX) : null;
}

/** Whose open the size rows describe: mine (오픈), the one before me (콜 · 3벳 · 올인), or none (폴드 · 림프 · no action). */
const openSide = (a: PreAction | undefined): "mine" | "theirs" | null => (a === "open" ? "mine" : a === "call" || a === "3bet" || a === "allin" ? "theirs" : null);

/**
 * The block with my action changed (undefined: cleared). The open's size, seat and 3-bet go with the
 * action they were entered for: moving between my own open and an open before me (or to 폴드 · 림프)
 * clears them, so my 2.5bb open never turns into someone else's. An all-in open only stays for 콜.
 */
export function withAction(pre: QuickPre, action: PreAction | undefined): QuickPre {
  const next: QuickPre = { ...pre, action };
  if (openSide(pre.action) !== openSide(action)) {
    delete next.openBb;
    delete next.openAllIn;
    delete next.openerSeat;
    delete next.threeBetX;
    delete next.threeBetAllIn;
  } else if (action === "3bet" || action === "allin") delete next.openAllIn;
  if (action === undefined) delete next.action;
  return next;
}

/**
 * The most I can put in preflop, as the street total the table records: my stack in bb, less the BB
 * ante when I'm the BB (it is dead money, not part of my bet). Null when my stack isn't known.
 */
export function shoveCap(bb: number | null, me: string, bbAnte: boolean): number | null {
  if (bb === null || !(bb > 0)) return null;
  const cap = r1(me === "BB" && bbAnte ? bb - Math.min(1, bb) : bb);
  return cap > 0 ? cap : null;
}

/** My 3-bet as the table will take it: an all-in once it reaches `cap` (my shoveCap). */
export function threeBetShown(pre: QuickPre, cap: number | null): PreSize | null {
  if (pre.threeBetAllIn) return "allin";
  const tb = threeBetBb(pre);
  return tb !== null && cap !== null && tb >= cap - 1e-9 ? "allin" : tb;
}

/** Something was entered in the block (an action or a stage tapped). A stage that only follows my stack isn't. */
export const preHasInfo = (pre: QuickPre | undefined): boolean => !!pre && (pre.action !== undefined || pre.pinned === true);

/**
 * A block record as it is kept: valid fields only, in one key order (so an unchanged hand compares
 * equal), or undefined when nothing was entered. `seats` are the table's seats (an opener must be one).
 */
export function cleanPre(x: unknown, seats: readonly string[]): QuickPre | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Record<string, unknown>;
  const pre: QuickPre = {};
  if (isStage(r.stage)) pre.stage = r.stage;
  if (r.pinned === true && pre.stage) pre.pinned = true;
  if (isAction(r.action)) pre.action = r.action;
  const open = posNum(r.openBb, 1000);
  if (open !== null) pre.openBb = open;
  else if (r.openAllIn === true) pre.openAllIn = true;
  if (typeof r.openerSeat === "string" && seats.includes(r.openerSeat)) pre.openerSeat = r.openerSeat;
  const x3 = posNum(r.threeBetX, 20);
  if (x3 !== null && x3 > 1) pre.threeBetX = x3;
  else if (r.threeBetAllIn === true) pre.threeBetAllIn = true;
  return preHasInfo(pre) ? pre : undefined;
}

/** The stage the block shows: the one tapped, else from my stack (bb), else as kept on the hand, else the last one used. */
export function stageOf(pre: QuickPre | undefined, bb: number | null, last: PreStage | null): PreStage {
  if (pre?.pinned && isStage(pre.stage)) return pre.stage;
  if (bb !== null && bb > 0) return stageFor(bb);
  if (isStage(pre?.stage)) return pre.stage;
  return isStage(last) ? last : "mid";
}

/** The stage worth remembering for the next hand: tapped, or from my stack. Null if this hand doesn't say. */
export function knownStage(pre: QuickPre | undefined, bb: number | null): PreStage | null {
  if (pre?.pinned && isStage(pre.stage)) return pre.stage;
  return bb !== null && bb > 0 ? stageFor(bb) : null;
}

export interface PreContext {
  /** My stack in bb, if known. */
  bb: number | null;
  seats: readonly string[];
  /** My seat ("" if not picked). */
  seat: string;
  last: PreStage | null;
}

/**
 * The block after an edit anywhere on the screen: an unpinned stage follows my stack, an opener has to be
 * another seat at this table, and an empty block goes away.
 */
export function tidyPre(pre: QuickPre | undefined, c: PreContext): QuickPre | undefined {
  if (!pre) return undefined;
  const next: QuickPre = { ...pre, stage: stageOf(pre, c.bb, c.last) };
  if (next.openerSeat !== undefined && (next.openerSeat === c.seat || !c.seats.includes(next.openerSeat))) delete next.openerSeat;
  return cleanPre(next, c.seats);
}

// ───────────── as text ─────────────

/** What a hand's preflop came to, for one line of text. */
export interface PreSummary {
  action: PreAction;
  /** My seat ("" if unknown). */
  me: string;
  /** Who opened: me when I opened; null when nobody did or it isn't known. */
  opener: string | null;
  open: PreSize | null;
  /** My 3-bet's street total. */
  threeBet: PreSize | null;
  /** My all-in in bb, if known. */
  shove: number | null;
}

/**
 * The block's record as a summary. `cap` is my all-in as a street total (shoveCap), for the size of my
 * shove: a raise of mine that reaches it reads as the all-in the table will record.
 */
export function summaryOf(pre: QuickPre | undefined, me: string, cap: number | null): PreSummary | null {
  if (!pre?.action) return null;
  const rows = preRows(pre);
  const shove = cap !== null && cap > 0 ? r1(cap) : null;
  let action: PreAction = pre.action;
  let open: PreSize | null = !rows.size ? null : pre.openAllIn ? "allin" : (pre.openBb ?? null);
  const opener = action === "open" ? me || null : rows.opener && pre.openerSeat && pre.openerSeat !== me ? pre.openerSeat : null;
  let threeBet: PreSize | null = !rows.threeBet ? null : threeBetShown(pre, shove);
  if (action === "open" && typeof open === "number" && shove !== null && open >= shove - 1e-9) open = "allin";
  // A 3-bet all-in over a known open is the table's "→ 올인 12bb".
  if (action === "3bet" && threeBet === "allin" && (opener !== null || open !== null)) [action, threeBet] = ["allin", null];
  return { action, me, opener, open, threeBet, shove };
}

/** The table's record has my own first preflop action (not only the seats before me). */
export const actedPreflop = (g: Game, me: string): boolean => g.log.some((e) => e.street === "preflop" && e.seat === me && e.kind !== "post");

/** The same summary from the table's record: my first preflop action and the open before it. Null when it doesn't fit one line. */
export function summaryOfGame(g: Game, me: string, bb: number | null): PreSummary | null {
  let opener: string | null = null;
  let open: PreSize | null = null;
  let raises = 0;
  for (const e of g.log) {
    if (e.street !== "preflop") break;
    if (e.kind === "post") continue;
    if (e.seat !== me) {
      if (e.kind === "raise" || e.kind === "bet") {
        if (raises === 0) [opener, open] = [e.seat, e.allIn ? "allin" : e.amount];
        raises++;
      }
      continue;
    }
    // Facing a 3-bet already: more than one line says.
    if (raises > 1) return null;
    const base = { me, opener, open, threeBet: null, shove: bb !== null && bb > 0 ? r1(bb) : null };
    if (e.kind === "fold") return { ...base, action: "fold" };
    if (e.kind === "check") return null;
    if (e.kind === "call") return { ...base, action: raises ? "call" : "limp", open: raises ? open : null, opener: raises ? opener : null };
    if (!raises) return e.allIn ? { ...base, action: "allin", shove: e.amount } : { ...base, action: "open", opener: me, open: e.amount };
    return e.allIn ? { ...base, action: "allin", shove: e.amount } : { ...base, action: "3bet", threeBet: e.amount };
  }
  return null;
}

const sizeText = (x: PreSize) => (x === "allin" ? "올인" : `${Math.round(x * 100) / 100}bb`);
const words = (...xs: (string | null | false | undefined)[]) => xs.filter(Boolean).join(" ");

/** "UTG 오픈 2.5bb", "CO 2.5bb 오픈 → 콜", "BTN 3bb → 3벳 9bb", "CO 올인 12bb". */
export function summaryText(s: PreSummary): string {
  const me = s.me || null;
  // What happened before me: "CO 2.5bb", "CO 올인", "2.5bb"; null if nobody opened (or it isn't known).
  const before = s.opener || s.open !== null ? words(s.opener, s.open !== null && sizeText(s.open)) : null;
  // "CO 2.5bb 오픈 →", or "CO 올인 →" for a shove.
  const opened = before && (s.open === "allin" ? `${before} →` : `${before} 오픈 →`);
  const shove = words("올인", s.shove !== null && `${s.shove}bb`);
  switch (s.action) {
    case "fold":
      return opened ? `${opened} 폴드` : words(me, "폴드");
    case "limp":
      return words(me, "림프");
    case "open":
      return s.open === "allin" ? words(me, shove) : words(me, "오픈", s.open !== null && sizeText(s.open));
    case "call":
      return opened ? `${opened} 콜` : "콜";
    case "3bet": {
      const mine = words("3벳", s.threeBet !== null && sizeText(s.threeBet));
      return before ? `${before} → ${mine}` : mine;
    }
    case "allin":
      return before ? `${before} → ${shove}` : words(me, shove);
  }
}

// ───────────── onto the table ─────────────

/**
 * The block as table steps, so the table flow opens with the preflop already in: the seats before the
 * opener fold (marked as filled in), the open, the seats between fold, then my action. A step that
 * doesn't fit (an opener after me, a size the table can't take) ends it there: the steps before it are
 * kept and the table flow carries on from that point. Never throws.
 */
export function preSteps(t: TableInput, pre: QuickPre | undefined): LogStep[] {
  const me = t.heroSeat;
  const action = pre?.action;
  const seats = t.seats ?? POSITIONS[9];
  if (!pre || !action || !me || !seats.includes(me)) return [];
  let g: Game;
  try {
    g = freshGame(t);
  } catch {
    return [];
  }
  const steps: LogStep[] = [];
  const push = (st: LogStep): boolean => {
    const next = applyStep(g, st);
    if (!next) return false;
    g = next;
    steps.push(st);
    return true;
  };
  /** Fold (or check) the seats before `seat`, never mine, nor the last one left against me: true once `seat` is to act. */
  const foldTo = (seat: string): boolean => {
    while (!g.done && g.toAct !== null && g.street === "preflop") {
      const now = g.players[g.toAct].seat;
      if (now === seat) return true;
      if (now === me || g.players.filter((p) => !p.folded).length <= 2) return false;
      if (!push({ s: now, k: legal(g, g.toAct).canCheck ? "check" : "fold", a: 1 })) return false;
    }
    return false;
  };
  /** A raise to `to` bb (an all-in when it reaches the stack); an all-in that can't raise calls. */
  const raise = (seat: string, to: PreSize): boolean => {
    if (g.toAct === null) return false;
    const L = legal(g, g.toAct);
    if (to === "allin") return L.canRaise ? push({ s: seat, k: "raise", to: L.maxRaiseTo }) : !L.canCheck && push({ s: seat, k: "call" });
    if (!L.canRaise || !(to >= L.minRaiseTo - 1e-9)) return false;
    return push({ s: seat, k: "raise", to: Math.min(to, L.maxRaiseTo) });
  };

  const rows = preRows(pre);
  const opener = rows.opener && pre.openerSeat && pre.openerSeat !== me && seats.includes(pre.openerSeat) ? pre.openerSeat : null;
  const open: PreSize | undefined = pre.openAllIn ? "allin" : pre.openBb;
  const facing = action === "call" || action === "3bet" || (action === "allin" && (opener !== null || open !== undefined));

  if (!facing) {
    // Nobody opened before me: they all fold to me.
    if (!foldTo(me)) return steps;
    if (action === "fold") push({ s: me, k: "fold" });
    else if (action === "limp") push({ s: me, k: "call" });
    else if (action === "allin") raise(me, "allin");
    else if (open !== undefined) raise(me, open);
    return steps;
  }
  // Someone opened: without the seat there is nothing to place it on.
  if (!opener) return [];
  if (!foldTo(opener) || open === undefined || !raise(opener, open) || !foldTo(me)) return steps;
  if (action === "call") push({ s: me, k: "call" });
  else if (action === "allin") raise(me, "allin");
  else {
    const mine: PreSize | null = pre.threeBetAllIn ? "allin" : threeBetBb(pre);
    if (mine !== null) raise(me, mine);
  }
  return steps;
}
