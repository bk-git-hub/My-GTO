import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackHandler, type Go } from "../../backNav";
import { RANKS } from "../../poker/cards";
import { AJAE_START, ajaeSeen, ajaeStep, type AjaeState } from "./ajae";
import { AjaeReaction } from "./AjaeReaction";
import { warmJudgeCharts } from "./judgeChart";
import {
  actLabel,
  actsFor,
  isThreeBet,
  seatsBefore,
  spotsFor,
  type FastSpot,
  type VerdictKind,
} from "./fastVerdict";
import {
  afterSave,
  backKey,
  blockOf,
  boardTarget,
  cancelEdit,
  classDone,
  cleanFastState,
  draftClass,
  draftPlayers,
  draftReady,
  draftStage,
  fastHand,
  fastOtherStore,
  entryField,
  pickEntry,
  fastStats,
  fastStore,
  focusOf,
  keptAction,
  keyUnitOf,
  nextSeat,
  pickBoardSlot,
  pickRes,
  pickSuited,
  resultParts,
  sessionText,
  setFocus,
  shareTable,
  stackUnitOf,
  startEdit,
  storeFor,
  switchUnit,
  tapBoardRank,
  tapBoardSuit,
  tapRank,
  typeDigit,
  undoTap,
  unitOf,
  withSeat,
  withSpot,
  type FastBlock,
  type FastDraft,
  type FastLevel,
  type FastMode,
  type FastState,
} from "./fastLog";
import {
  estimatedLevel,
  fastActed,
  fastActText,
  fastOnly,
  fastVerdictOf,
  freshHand,
  handLogStore,
  handRoute,
  holeClass,
  lastStage,
  levelEstimateAt,
  rememberedText,
  saveHand,
  withLv,
  type LoggedHand,
} from "./handLog";
import { BlindsPanel, BlindsSheet, CalcSheet, useCalcKeys } from "./CalcSheet";
import { bbPart, checkSteps, chipSeries, chipsText, handLv, levelChip, levelNear, postedBy, signedText, type StackAt, type Unit } from "./fastChips";
import { CheckRow, ChipsBlock, clock, copyText, FastItem, FastStatsRow } from "./FastParts";
import { Bb, HandSheet, MoreToggle, ResultRow, type SheetMode } from "./FastResult";
import {
  cancelNewTourney,
  cancelTarget,
  checkStack,
  clockOf,
  countFor,
  currentTourney,
  dateOf,
  defaultTitle,
  deleteTourneyAll,
  anteFor,
  editTourney,
  fastEstimate,
  isCustom,
  levelFor,
  setTourneyBlinds,
  fastResultNow,
  fastSession,
  currentFields,
  groupTitle,
  infoOf,
  newFields,
  onTourneyDay,
  openCheck,
  removeCheck,
  resumeTourney,
  runningUntagged,
  saveNewFast,
  setFastStartClock,
  stampPick,
  stampStoredPick,
  sheetLevelText,
  restack,
  stackBefore,
  startNote,
  startTourney,
  tourneyEstimate,
  tourneyGroups,
  tourneyTitle,
  tourneyWhen,
  type TourneyGroup,
} from "./fastTourney";
import { LevelRow } from "./inputs";
import { levelStage, PRE_STAGES, STAGE_LABEL, type PreAction } from "./quickPre";
import { buttonSeat, positionsFor, TABLE_SIZES } from "./recorder";
import type { Blinds } from "./levelClock";
import { cleanTourneys, type StackCheck, type Tourney } from "./tourney";
import { GroupRes } from "./TourneyScreens";
import { ChipUpdateSheet, TourneySheet } from "./TourneySheet";
import { closeUndoOffer, deleteWithUndo } from "./undoDelete";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
/** 남의 핸드 has no stack. */
const NO_STACK: StackAt = { chips: null, why: "none" };
const NO_CHECKS: readonly StackCheck[] = [];

/** The rank pad, high to low, and ⌫ to finish the second row. */
const PAD = "AKQJT98765432".split("");

/** The spot chips: two short lines each so five fit one row on a phone. 3벳 이상 covers both 3-bet spots (a row below picks which). */
const SPOT_CHIP: Record<Exclude<FastSpot, "cold3">, [string, string]> = { none: ["폴드로", "나에게"], limp: ["림프", "있음"], open: ["오픈", "있음"], shove: ["올인", "있음"], "3bet": ["3벳", "이상"] };
/** 남의 핸드: the same chips seen from the player whose hand it is. */
const SPOT_CHIP_OTHER: typeof SPOT_CHIP = { ...SPOT_CHIP, none: ["폴드로", "상대에게"] };
const SPOTS = ["none", "limp", "open", "shove", "3bet"] as const;

/** A seat chip's label: in the tightest rows (10 seats, 9 beside 오픈 자리) UTG+1 goes on two lines so it isn't clipped. */
function SeatText({ seat, tight }: { seat: string; tight: boolean }) {
  const m = tight ? /^(UTG)(\+\d)$/.exec(seat) : null;
  return m ? (
    <span className="two">
      <span>{m[1]}</span>
      <span>{m[2]}</span>
    </span>
  ) : (
    <>{seat}</>
  );
}

/** "내 핸드 | 남의 핸드" at the top of both quick screens: a toggle, so it takes this screen's place in history. */
export function QuickToggle({ mine, go }: { mine: boolean; go: Go }) {
  return (
    <div className="seg small fast-toggle" role="tablist" aria-label="빠른 기록">
      <button type="button" role="tab" aria-selected={mine} className={mine ? "on" : ""} onClick={() => !mine && go("log/fast", "replace")}>
        내 핸드
      </button>
      <button type="button" role="tab" aria-selected={!mine} className={!mine ? "on" : ""} onClick={() => mine && go("log/other", "replace")}>
        남의 핸드
      </button>
    </div>
  );
}

/** The hand just saved, its verdict (or 저장했어요) shown in the save slot until the next hand is started. */
interface Saved {
  id: string;
  kind: VerdictKind;
  text: string;
  /** The hand: its seat and class (and action); then its chips with their bb apart, and the board remembered (" · K♥ 7 2"). */
  line: string;
  res: { text: string; bb: string | null } | null;
  board: string;
  /** The slot's tint: the verdict's ("v-over"), or for a hand saved without a decision its result's ("r-win"). */
  tone: string;
}

/** Why the save waits, as the save button says it. */
const BLOCK_TEXT: Record<Exclude<FastBlock, "class">, string> = {
  sign: "수익? 손실?",
  level: "bb로 넣으려면 레벨을 골라 주세요",
  stack: "지금 스택이 이번 수익보다 적어요",
  stackNow: "지금 스택을 넣어 주세요",
  over: "전 스택보다 많이 잃을 순 없어요",
  board: "보드 카드가 핸드와 겹쳐요",
};

/** BLOCK_TEXT, with a 직접 입력 tournament's word for the level (its blinds). */
const blockText = (b: Exclude<FastBlock, "class">, custom: boolean): string => (custom && b === "level" ? "bb로 넣으려면 블라인드를 넣어 주세요" : BLOCK_TEXT[b]);

/**
 * A hand being corrected: the level (or 직접 입력 blinds) and BB ante on its draft (a draft stored before they were
 * kept: the hand's own). 직접 입력 blinds carry their own ante (0: none).
 */
const editLevel = (d: FastDraft, h: LoggedHand): FastLevel =>
  d.blinds ? { level: d.blinds, guessed: false } : d.level !== undefined ? { level: d.level, guessed: !!d.levelGuess } : { level: handLv(h), guessed: !!h.levelGuess };
const editAnte = (d: FastDraft, h: LoggedHand): boolean => (d.blinds ? d.blinds.ante > 0 : d.level !== undefined ? !d.noAnte : h.bbAnte);

/** A hand being corrected is a 직접 입력 one: blinds on its draft or on file, or a hand of a 직접 입력 tournament with no level. */
const editCustom = (d: FastDraft, h: LoggedHand, ts: Tourney[]): boolean =>
  !!d.blinds || (h.level === null && (d.level === undefined || d.level === null) && (!!h.blinds || isCustom(ts.find((t) => t.id === h.tourney))));

/** The sheet's tab for the field the keypad types into. */
const modeOf = (f: ReturnType<typeof focusOf>): SheetMode => (f === "result" ? "amount" : f === "board" ? "board" : "stack");

/** The state without one of 빠른 기록's optional fields (a field at its default is left out). */
function without<T extends object>(x: T, k: keyof T): T {
  const out = { ...x };
  delete out[k];
  return out;
}

/** What the save slot says about a hand just saved. */
function savedOf(h: LoggedHand, other: boolean): Saved {
  const v = fastVerdictOf(h);
  const acted = fastActed(h);
  const base = `${h.seat} ${holeClass(h)}`;
  if (other) return { id: h.id, kind: v?.kind ?? "none", text: v?.text ?? "", line: `${base} ${fastActText(h)}`, res: null, board: "", tone: `v-${v?.kind ?? "none"}` };
  const line = [base, acted ? fastActText(h) : ""].filter(Boolean).join(" ");
  const res = resultParts(h);
  const tone = acted ? `v-${v?.kind ?? "none"}` : `r-${h.result === "win" || h.result === "chop" ? "win" : h.result === "lose" ? "lose" : h.result === "fold" ? "fold" : "none"}`;
  return { id: h.id, kind: v?.kind ?? "none", text: acted ? (v?.text ?? "") : "", line, res: res.text ? res : null, board: h.board.length ? ` · ${rememberedText(h)}` : "", tone };
}

/**
 * 빠른 기록: every hand dealt to me, a few taps each. The stage and the table size stay for the session;
 * my seat moves on by itself after each hand; the class goes in on a rank pad (no suits); then the
 * result: 폴드 (one tap, saved at once, the blind it cost from my seat and the level) or 수익 / 손실 and the
 * amount in chips or bb on the same keypad, or 스택: my chips counted after the hand, the result worked out
 * from my stack before it (no pot math); and the board cards I remember (ranks, a suit if I know it);
 * 저장 saves and starts the next hand. The current tournament's list adds the chips up and draws them as a
 * graph from its start stack; every new hand goes to that tournament with no tap of its own (fastTourney.ts),
 * and "＋ 새 토너먼트" at the list's head starts another (the sheet), well away from the pad. "칩 업데이트" by
 * the tournament's line takes my stack counted at any moment: the graph, the total and the next hand's stack
 * before it follow it.
 * "액션도 기록" (closed by default, remembered) adds what happened before me (폴드로 나에게 by default) and
 * my action: tapping it saves the hand with its result, grades it against the pub chart (shown under the
 * actions with 되돌리기 until the next hand is started, and in today's list) and starts the next hand.
 *
 * mode "other" is 남의 핸드, the same screen for a hand another player showed: their seat (it stays put
 * from hand to hand), their class, what happened before them, their action. It saves an other-hand and
 * judges it against the same chart, worded as how pub players play (차트보다 루즈 / 타이트).
 */
export function FastView({ hands, go, mode = "mine" }: { hands: LoggedHand[]; go: Go; mode?: FastMode }) {
  const other = mode === "other";
  const store = storeFor(mode);
  // A first visit's stage: the level's usual one (from the tournament's or today's start time), else the last one used.
  const [fallback] = useState(() => levelStage(estimatedLevel(fastEstimate(Date.now()))) ?? lastStage() ?? "mid");
  // 남의 핸드's first visit starts at 빠른 기록's table (the same stage and table size).
  const [first] = useState(() => (other ? cleanFastState(fastStore.get(), fallback) : null));
  const clean = (x: unknown) => cleanFastState(x, first?.stage ?? fallback, first?.players);
  const raw = store.use();
  const s = clean(raw);
  /** The state as stored right now (a second tap in the same moment must not act on the old one). */
  const cur = () => clean(store.get());
  const set = (next: FastState) => store.set(next);
  /** A new stage or table size goes for the other screen too: both are the same table. */
  const share = (next: FastState) => {
    const twin = other ? fastStore : fastOtherStore;
    twin.set(shareTable(cleanFastState(twin.get(), next.stage, next.players), next.stage, next.players));
  };
  const d = s.draft;
  const players = draftPlayers(s);
  const stage = draftStage(s);
  const seats = positionsFor(players);
  const editing = d.editing ? (hands.find((h) => h.id === d.editing) ?? null) : null;
  const [justSaved, setSaved] = useState<Saved | null>(null);
  // The hand just saved was deleted (here or in 지난 기록): its verdict goes with it.
  const saved = justSaved && hands.some((h) => h.id === justSaved.id) ? justSaved : null;
  /** A short note by the class (a rank tapped into a full class while correcting). */
  const [nudge, setNudge] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [sizes, setSizes] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** The tournament sheet open: a new tournament, the current one's details, or 칩 업데이트. */
  const [sheet, setSheet] = useState<null | "new" | "edit" | "chips">(null);
  /** A short note under the list after a tournament action ("… 시작", "…에 이어 적어요"). */
  const [tnMsg, setTnMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  /** 빠른 기록's 아재: only a class completed by a tap here reacts (not one restored or opened to correct). */
  const [ajae, setAjae] = useState<AjaeState>(AJAE_START);
  // What is left of his reaction with this hand on screen (adjusting state while rendering, React's
  // pattern for it): a hand saved, opened to correct or put back takes the reaction with it for good.
  const ajaeNow = other ? ajae : ajaeSeen(ajae, d, stage, players);
  if (ajaeNow !== ajae) setAjae((a) => ajaeSeen(a, d, stage, players));
  const barRef = useRef<HTMLDivElement>(null);
  const handRowRef = useRef<HTMLDivElement>(null);
  /** The room above the hand row for the 아재, up to the sticky stage bar (less when the page is scrolled); read at the tap, never while rendering. */
  const ajaeRoom = (): number | undefined => {
    const bar = barRef.current?.getBoundingClientRect();
    const row = handRowRef.current?.getBoundingClientRect();
    return bar && row ? Math.round(row.top - bar.bottom) : undefined;
  };
  /** The clock the level estimate follows (빠른 기록: every 30 s, so the level chip and the blinds keep up). */
  const [tick, setTick] = useState(() => Date.now());
  const log = handLogStore.use();
  const tourneys = useMemo(() => cleanTourneys(log.tourneys), [log.tourneys]);
  // Now, or the newest hand's time if the clock is behind it.
  const at = Math.max(tick, ...hands.slice(0, 1).map((h) => h.createdAt));
  /** The current tournament: new hands go to it. */
  const tn = useMemo(() => currentTourney(tourneys, hands, at), [tourneys, hands, at]);
  // The list's hands: the current tournament's of this screen's kind, else (none current) today's hands logged before tournaments.
  const session = useMemo(() => fastSession(tn, hands, at, mode), [tn, hands, at, mode]);
  const tnChecks = (!other && tn?.checks) || NO_CHECKS;
  // 빠른 기록 grades only the hands saved with a decision.
  const stats = useMemo(() => fastStats(other ? session : session.filter(fastActed)), [session, other]);
  /** The level the clock gives: the tournament's start, else today's (a tournament resumed on a later day: today's only). */
  const est = useMemo(() => tourneyEstimate(tn, tick, levelEstimateAt(tick, log)), [tn, tick, log]);
  /**
   * The level chip's panel: the 야자수 새틀 level picker or a 직접 입력 tournament's blinds editor. In the hand's
   * calculator sheet while it is up (in the keys' place); else the picker under the page's 결과 row, the blinds
   * editor in a sheet of its own.
   */
  const [panel, setPanel] = useState<null | "level" | "blinds">(null);
  /** A save waiting for the level (a blind's fold or a walk tapped with no level known): it goes through once a level is picked. */
  const pending = useRef<(() => void) | null>(null);
  /** When the last hand was saved: a second tap bounced off 저장 / 폴드 is not taken by what comes up under it. */
  const savedAt = useRef(0);
  /** For a moment after the sheet goes with a save: a clear layer where its buttons were takes a bounced second tap. */
  const [shield, setShield] = useState(false);
  /** 내 액션's section: brought into view when the class is in with 액션도 기록 open. */
  const actsRef = useRef<HTMLDivElement>(null);
  const view: Unit = s.view === "bb" ? "bb" : "chips";

  /**
   * Scroll by the least that shows all of `el` under the sticky bar (its top wins when it is taller than
   * the room). At once, never smoothly: the next tap goes to what was just brought into view, and a
   * button still moving under the finger could take the wrong tap.
   */
  function reveal(el: HTMLElement | null) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const top = (barRef.current?.getBoundingClientRect().bottom ?? 0) + 6;
    const bottom = window.innerHeight - 6;
    const dy = r.top < top ? r.top - top : r.bottom > bottom ? Math.min(r.bottom - bottom, r.top - top) : 0;
    if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
  }

  // The hand being corrected was deleted (here or in 지난 기록): back to the new hand.
  useEffect(() => {
    if (d.editing && !editing) set(cancelEdit(cur()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.editing, editing]);
  // The 아재's charts (judgeChart.ts), parsed while the screen is idle so the first hand typed doesn't wait for them.
  useEffect(() => {
    const idle = typeof window.requestIdleCallback === "function";
    const id = idle ? window.requestIdleCallback(() => warmJudgeCharts(), { timeout: 1500 }) : window.setTimeout(warmJudgeCharts, 200);
    return () => (idle ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(null), 2500);
    return () => clearTimeout(t);
  }, [nudge]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    if (!tnMsg) return;
    const t = setTimeout(() => setTnMsg(null), 2500);
    return () => clearTimeout(t);
  }, [tnMsg]);
  useEffect(() => {
    if (other) return;
    const now = () => setTick(Date.now());
    const t = setInterval(now, 30_000);
    // Back from the lock screen (timers stop there): the level chip at once, not up to 30 s later.
    const seen = () => document.visibilityState === "visible" && now();
    document.addEventListener("visibilitychange", seen);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [other]);

  // Any change to the hand on screen starts the next hand: the last verdict gives way to the hints. The class
  // completed by a tap brings the calculator sheet up (openOnClass); `also` changes the rest of the state with it.
  const draft = (f: (x: FastState["draft"], p: number) => FastState["draft"], also?: (s: FastState) => FastState) => {
    const c = cur();
    const typed = f(c.draft, draftPlayers(c));
    // The calculator comes up from 스택 입력 (or the result line), not by itself: the hand stays editable.
    const next = typed;
    set({ ...(also ? also(c) : c), draft: next });
    // Back to the hand (the sheet closed): the panel goes with it.
    if (focusOf(next) === "hand") setPanel(null);
    setSaved(null);
    setNudge(null);
    pending.current = null;
    if (!other) {
      // The level chip and the blinds as of this tap (the 30 s clock may be behind at a level change).
      setTick(Date.now());
      // With 액션도 기록 open (내 액션 on screen), the class in brings 상황 and 내 액션 into view; the hand's keypad stays in it.
      if (!classDone(c.draft) && classDone(next)) requestAnimationFrame(() => reveal(actsRef.current));
      const room = ajaeRoom();
      setAjae((a) => ajaeStep(a, c.draft, next, draftStage(c), draftPlayers(c), room));
    }
  };
  function rank(k: string) {
    const c = cur();
    if (c.draft.editing && classDone(c.draft)) {
      setNudge("수정 중 · ⌫로 먼저 지우세요");
      return;
    }
    draft((v) => tapRank(v, RANKS.indexOf(k)));
  }

  function pickStage(x: (typeof PRE_STAGES)[number]) {
    const c = cur();
    if (c.draft.editing) {
      set({ ...c, draft: { ...c.draft, stage: x } });
      return;
    }
    const next = { ...c, stage: x };
    set(next);
    share(next);
  }
  function pickPlayers(n: number) {
    const c = cur();
    const seat = positionsFor(n).includes(c.draft.seat) ? c.draft.seat : buttonSeat(n);
    if (c.draft.editing) set({ ...c, draft: { ...withSeat(c.draft, seat, n), players: n } });
    else {
      const next = { ...c, players: n, draft: withSeat(c.draft, seat, n) };
      set(next);
      share(next);
    }
    setSizes(false);
  }

  /** The hand being corrected as on file now, or null for a new hand. */
  const editHandOf = (c: FastState) => (c.draft.editing ? (handLogStore.get().hands.find((h) => h.id === c.draft.editing) ?? null) : null);
  /** The current tournament as on file at `at`. */
  const tourneyAt = (at: number): Tourney | null => {
    const st = handLogStore.get();
    return currentTourney(cleanTourneys(st.tourneys), st.hands, at);
  };
  /** The draft's blinds are a 직접 입력 tournament's (typed by hand), not a 야자수 새틀 level: the corrected hand's own kind, else the current tournament's. */
  const customFor = (c: FastState, editHand: LoggedHand | null, at: number): boolean =>
    editHand ? editCustom(c.draft, editHand, cleanTourneys(handLogStore.get().tourneys)) : isCustom(tourneyAt(at));
  /**
   * The level and BB ante the draft saves at: a corrected hand's own; a new hand's from the session at this
   * moment (levelFor): a 직접 입력 tournament's blinds, else a level picked in the current tournament, else its
   * start time's estimate.
   */
  function levelNow(c: FastState, editHand: LoggedHand | null, at: number): { lv: FastLevel & { picked?: boolean }; ante: boolean } {
    if (editHand) return { lv: editLevel(c.draft, editHand), ante: editAnte(c.draft, editHand) };
    const st = handLogStore.get();
    const t = currentTourney(cleanTourneys(st.tourneys), st.hands, at);
    return { lv: levelFor(t, c, fastSession(t, st.hands, at, mode), at, tourneyEstimate(t, at, levelEstimateAt(at, st))), ante: anteFor(t, c) };
  }
  /**
   * `h` on file, the editor on to the next hand, the save slot showing it. A new hand (`at`: the moment it
   * was tapped) goes to the current tournament, or starts one on its own (saveNewFast: in the same write);
   * a level picked before that one now belongs to it. A corrected hand (`at` null) keeps its own.
   */
  function commit(c: FastState, h: LoggedHand, at: number | null) {
    // A corrected hand: the hands by 스택 after it in its tournament work from it (restack), in the same write.
    const r = at !== null ? saveNewFast(h, at) : { ok: saveHand(h, (s) => restack(s, h.tourney, Date.now())), hand: h, started: null };
    setFull(!r.ok);
    // Not on file: the hand stays on screen to try again.
    if (!r.ok) return;
    // Only one 되돌리기 on screen: the one in the save slot, for the hand just saved.
    closeUndoOffer();
    const fromSheet = !other && focusOf(c.draft) !== "hand";
    let next = afterSave(c, r.hand, handLogStore.get().hands, mode);
    if (r.started && at !== null) {
      if (other) stampStoredPick(r.started.id, at);
      else next = stampPick(next, r.started.id, at);
    }
    set(next);
    setSaved(savedOf(r.hand, other));
    savedAt.current = Date.now();
    setNudge(null);
    setPanel(null);
    pending.current = null;
    // The sheet goes at once: a bounced second tap on its button lands on the clear layer, not on the page under it.
    if (fromSheet) setShield(true);
    // Scrolled down to 내 액션: the next hand's keypad back in view (the verdict under the actions stays when it fits).
    if (!other) requestAnimationFrame(() => reveal(handRowRef.current?.parentElement ?? null));
  }

  /** The level picker (or a 직접 입력 tournament's blinds editor) opened for a save that needs it; `then` runs once one is picked. */
  function askLevel(then: () => void, why: string, custom: boolean) {
    pending.current = then;
    setPanel(custom ? "blinds" : "level");
    setNudge(why);
  }
  /**
   * A blind's fold or a walk with no level known (and 레벨 모름 not picked on purpose): the chips it cost
   * or won are the level's blinds, so the picker opens first and the save goes through after the pick.
   */
  function needsLevel(d: FastDraft, lv: FastLevel & { picked?: boolean }, editHand: LoggedHand | null): boolean {
    if (lv.level !== null || (!editHand && lv.picked)) return false;
    return (d.res === "fold" && postedBy(d.seat, null) === null) || (d.res === "walk" && d.seat === "BB");
  }
  /** "블라인드라서 레벨을 골라 주세요" / "…블라인드를 넣어 주세요". */
  const blindWhy = (custom: boolean) => (custom ? "블라인드라서 블라인드를 넣어 주세요" : "블라인드라서 레벨을 골라 주세요");
  /** Nothing saved: what is missing, as the save button would say it (the level: the picker, the save after it). */
  function whyNot(d: FastDraft, p: number, lv: FastLevel, ante: boolean, retry: () => void, before: number | null, custom: boolean) {
    const b = blockOf(d, p, lv.level, ante, before);
    if (b === "level" && lv.level === null) askLevel(retry, custom ? "블라인드를 넣으면 저장돼요" : "레벨을 고르면 저장돼요", custom);
    else if (b && b !== "class") setNudge(blockText(b, custom));
  }

  /**
   * An action tapped (액션도 기록), or the sheet's 저장 / 결과 없이 for the action waiting (`how`). Tapped with no
   * result typed, any action but 폴드 / 워크 brings the sheet up with the action waiting (draft.act); 저장 there
   * saves the hand, the action and the result together; 결과 없이 saves the action with no chips.
   */
  function act(a: PreAction | undefined, asked = false, how: "tap" | "sheet" | "bare" = "tap") {
    const c = cur();
    const p = draftPlayers(c);
    const editHand = editHandOf(c);
    const at = Date.now();
    // A new hand goes to the current tournament (or starts one) as it is saved; a corrected hand keeps its own.
    let base = editHand ?? { ...freshHand(mode), players: p };
    const saveAt = editHand ? null : at;
    if (other) {
      // 남의 핸드 in a 직접 입력 tournament: the tournament's blinds, never an estimated level.
      const t = editHand ? null : tourneyAt(at);
      if (t && isCustom(t)) base = { ...withLv(base, t.blinds ?? null), bbAnte: anteFor(t, c) };
      const h = fastHand(c.draft, a, base, draftStage(c), p, mode);
      if (h) commit(c, h, saveAt);
      return;
    }
    const typed = !!(c.draft.res || c.draft.amount || c.draft.stackNow);
    if (how === "tap" && !asked && !typed && a !== undefined && a !== "fold" && draftReady(c.draft, p)) {
      draft((v) => ({ ...entryField(v, c), act: a }));
      return;
    }
    // 액션도 기록: the action saves the result and board typed so far; a fold or a walk with none typed is one.
    const d0 = how === "bare" ? without(without(without(c.draft, "res"), "amount"), "stackNow") : c.draft;
    const d = d0.res || d0.amount ? d0 : a === "fold" ? pickRes(d0, "fold") : a === undefined ? pickRes(d0, "walk") : d0;
    setTick(at);
    const { lv, ante } = levelNow(c, editHand, at);
    const custom = customFor(c, editHand, at);
    if (!asked && needsLevel(d, lv, editHand)) return askLevel(() => act(a, true, how), blindWhy(custom), custom);
    const made = fastHand(d, a, base, draftStage(c), p, mode);
    if (!made) return;
    // 스택: my stack before this hand as on file at this moment.
    const { hand: h, before } = fastResultNow(made, d, lv, ante, editHand, at);
    if (h) commit(c, h, saveAt);
    else whyNot(d, p, lv, ante, () => act(a, true, how), before, custom);
  }

  /** 저장 (the draft as it is), or 폴드 / 워크 (one tap: that result, saved at once). Without a decision unless a corrected hand's still fits. */
  function save(kind: "save" | "fold" | "walk", asked = false) {
    const c = cur();
    const p = draftPlayers(c);
    const editHand = editHandOf(c);
    const d = kind === "save" ? c.draft : pickRes(c.draft, kind);
    // The level as of this tap, and the chip showing it.
    const at = Date.now();
    setTick(at);
    const { lv, ante } = levelNow(c, editHand, at);
    const custom = customFor(c, editHand, at);
    if (!asked && needsLevel(d, lv, editHand)) return askLevel(() => save(kind, true), blindWhy(custom), custom);
    // A new hand goes to the current tournament (or starts one) as it is saved; a corrected hand keeps its own.
    const base = editHand ?? { ...freshHand(mode), players: p };
    const kept = editHand ? keptAction(editHand, d) : null;
    const made = (kept !== null ? fastHand(d, kept, base, draftStage(c), p, mode) : null) ?? fastHand(d, null, base, draftStage(c), p, mode);
    if (!made) return;
    const { hand: h, before } = fastResultNow(made, d, lv, ante, editHand, at);
    if (h) commit(c, h, editHand ? null : at);
    else whyNot(d, p, lv, ante, () => save(kind, true), before, custom);
  }
  /** − 손실 / + 수익 in the sheet's 금액: that sign on the amount, then the save (액션도 기록: the action waiting; none: the sheet closes). */
  function sign(x: "+" | "-") {
    const c = cur();
    const withSign = { ...c.draft, res: x } as FastDraft;
    if (actionsView && !c.draft.act) {
      draft(() => setFocus(withSign, "hand"));
      return;
    }
    set({ ...c, draft: withSign });
    if (actionsView && c.draft.act) act(c.draft.act, false, "sheet");
    else save("save");
  }
  /** The sheet's tabs: what is typed stays; 스택 / 금액 is remembered for the next hands (a new hand's only). */
  function pickTab(e: SheetMode) {
    const c = cur();
    const keep = !c.draft.editing && e !== "board";
    draft((v) => pickEntry(v, e), keep ? (x) => (e === "amount" ? { ...x, entry: "amount" } : without(x, "entry")) : undefined);
  }
  /** The sheet goes (the keypad back on the ranks, what was typed kept; an action waiting goes with it). */
  const closeSheet = () => draft((v) => setFocus(without(v, "act"), "hand"));
  function boardRank(r: number) {
    const c = cur();
    if (tapBoardRank(c.draft, r) === c.draft) return setNudge("그 카드는 이 핸드와 겹쳐요");
    draft((v) => tapBoardRank(v, r));
  }
  function boardSuit(suit: number) {
    const c = cur();
    if (tapBoardSuit(c.draft, suit) === c.draft) {
      const marks = c.draft.board ?? [];
      const i = boardTarget(c.draft);
      const m = marks[i];
      return setNudge(m && marks.some((k, j) => j !== i && k.r === m.r && k.s === suit) ? "그 카드는 이미 보드에 있어요" : "그 카드는 이 핸드와 겹쳐요");
    }
    draft((v) => tapBoardSuit(v, suit));
  }
  /**
   * 칩 | bb for the field the keypad types into (the amount, or 지금 스택): what is typed keeps its digits
   * (the line beside it shows the conversion; tapping back undoes it), and new hands type that field in it too.
   */
  function pickUnit(u: Unit) {
    const c = cur();
    const next = switchUnit(c.draft, u);
    if (next === c.draft) {
      if (keyUnitOf(c.draft) !== u) setNudge(u === "bb" ? "bb는 네 자리까지 · 지우고 바꿔 주세요" : "칩은 소수점 없이 · 지우고 바꿔 주세요");
      return;
    }
    const field = focusOf(c.draft) === "stack" ? "stackUnit" : "unit";
    set({ ...(u === "bb" ? { ...c, [field]: "bb" as const } : without(c, field)), draft: next });
  }
  /** The level picker: a corrected hand's own level, else the session's (a level tapped holds; the estimate or a start time follows the clock). */
  function pickLevel(level: number | null, guessed: boolean) {
    const c = cur();
    // A save that waited for the level goes through with it.
    const then = pending.current;
    pending.current = null;
    if (c.draft.editing) draft((v) => ({ ...without(without(without(v, "level"), "levelGuess"), "blinds"), level, ...(guessed && level !== null ? { levelGuess: true as const } : {}) }));
    else {
      // A level picked holds in the tournament it was picked in (none current: until a hand starts one, which takes it).
      const now = Date.now();
      const st = handLogStore.get();
      const t = currentTourney(cleanTourneys(st.tourneys), st.hands, now);
      set(guessed ? without(c, "levelPick") : { ...c, levelPick: { level, at: now, ...(t ? { t: t.id } : {}) } });
    }
    setPanel(null);
    then?.();
  }
  /**
   * 직접 입력's blinds applied: a corrected hand's own (이 핸드만), else the tournament's from now on (the hand on
   * screen too; saved hands keep theirs). A save that waited for them goes through.
   */
  function applyBlinds(b: Blinds) {
    const c = cur();
    const then = pending.current;
    pending.current = null;
    if (c.draft.editing) {
      draft((v) => ({ ...without(without(v, "levelGuess"), "noAnte"), level: null, blinds: b }));
    } else {
      const t = tourneyAt(Date.now());
      if (!t || !setTourneyBlinds(t.id, b, Date.now())) {
        setFull(true);
        return;
      }
      setTick(Date.now());
      setNudge(`블라인드 ${chipsText(b.sb)}/${chipsText(b.bb)} · ${classDone(c.draft) ? "이 핸드부터" : "다음 핸드부터"}`);
    }
    setPanel(null);
    then?.();
  }
  /** The level chip: its panel opens or closes (closed by hand, a save waiting for it is dropped). */
  function toggleLevel() {
    if (panel) {
      pending.current = null;
      setPanel(null);
    } else setPanel(custom ? "blinds" : "level");
  }
  function pickAnte(on: boolean) {
    const c = cur();
    if (c.draft.editing) draft((v) => (on ? without(v, "noAnte") : { ...v, noAnte: true }));
    else set(on ? without(c, "noAnte") : { ...c, noAnte: true });
  }
  function edit(h: LoggedHand) {
    if (!fastOnly(h)) {
      go(handRoute(h));
      return;
    }
    set(startEdit(cur(), h, mode));
    setSaved(null);
    setNudge(null);
    setPanel(null);
    window.scrollTo({ top: 0 });
  }
  function undo() {
    // A second tap bounced off 저장 lands here (되돌리기 comes up under it): not taken.
    if (Date.now() - savedAt.current < 600) return;
    const h = saved ? handLogStore.get().hands.find((x) => x.id === saved.id) : null;
    if (h) edit(h);
    setSaved(null);
  }
  useEffect(() => {
    if (!shield) return;
    const t = setTimeout(() => setShield(false), 450);
    return () => clearTimeout(t);
  }, [shield]);

  const cls = draftClass(d);
  const pairOrDone = d.ranks.length === 2 && d.ranks[0] === d.ranks[1];
  const needSuit = d.ranks.length === 2 && !pairOrDone;
  const spots = spotsFor(players, d.seat);
  const before = seatsBefore(players, d.seat);
  const acts = actsFor(d.spot, d.seat);
  const ready = draftReady(d, players);
  const savedAct = editing?.quickPre?.action;
  const recent = session.slice(0, 20);
  const chip = other ? SPOT_CHIP_OTHER : SPOT_CHIP;
  // 빠른 기록's result, board and level (남의 핸드 has none of them).
  const focus = other ? "hand" : focusOf(d);
  /** The hand's calculator sheet is up: the class is in and the keypad types the result (or the board). */
  const sheetOpen = !other && focus !== "hand";
  const unit = unitOf(d);
  /** A 직접 입력 tournament's blinds (typed by hand), not a 야자수 새틀 level: the corrected hand's own kind, else the current tournament's. */
  const custom = !other && (editing ? editCustom(d, editing, tourneys) : isCustom(tn));
  const lvNow: FastLevel & { picked?: boolean } = editing ? editLevel(d, editing) : levelFor(tn, s, session, tick, est);
  /** The level now, even while an older hand is corrected (that hand's level is lvNow then): my stack now is in bb at it. */
  const lvLive: FastLevel = editing ? levelFor(tn, s, session, tick, est) : lvNow;
  const anteNow = editing ? editAnte(d, editing) : anteFor(tn, s);
  /** My stack before this hand (for 스택): the current tournament's count, or a corrected hand's own. */
  const stackPre = useMemo(() => (other ? NO_STACK : stackBefore(log, editing, at)), [other, log, editing, at]);
  const block = other ? null : blockOf(d, players, lvNow.level, anteNow, stackPre.chips);
  const waits = block !== null && block !== "class";
  // A hand corrected with its decision on file shows the action row (its action lit); else the toggle decides.
  const forced = !other && !!editing && fastActed(editing);
  const actionsView = other || forced || s.actions === true;
  // No level known (and 레벨 모름 not picked on purpose): the chip asks for one once a hand is typed, since a blind's chips and bb need it.
  const declined = !editing && lvNow.level === null && !!lvNow.picked;
  const wantLevel = lvNow.level === null && (block === "level" || (!declined && classDone(d)));
  const levelClass = `${lvNow.guessed ? " est" : ""}${wantLevel ? " ask" : ""}`;
  const levelText = `${levelChip(lvNow.level, custom)}${lvNow.guessed ? " (추정)" : ""}`;
  const canSave = classDone(d) && positionsFor(players).includes(d.seat);
  const next = nextSeat(players, d.seat);
  const saveLabel = waits
    ? blockText(block, custom)
    : editing
      ? "고쳐서 저장"
      : d.res === "stack" && stackPre.chips === null
        ? `스택만 저장 · 다음 핸드 ${next}`
        : d.res
          ? `저장 · 다음 핸드 ${next}`
          : `결과 없이 저장 · 다음 ${next}`;
  const picker =
    panel === "level" ? (
      <LevelRow
        h={{ id: editing?.id ?? "fast-new", level: typeof lvNow.level === "number" ? lvNow.level : null, ...(lvNow.guessed ? { levelGuess: true as const } : {}), bbAnte: anteNow, createdAt: editing?.createdAt ?? tick }}
        open
        onToggle={toggleLevel}
        onLevel={pickLevel}
        onAnte={pickAnte}
        unknownSub="칩으로만"
        // A new hand: the tournament's clock (a hand being corrected keeps the day's start for its own time).
        {...(editing ? {} : { estimate: est, onStartClock: (c: string) => setFastStartClock(c, Date.now()), clockDefault: tn?.startSet ? clockOf(tn.start) : undefined })}
      />
    ) : null;
  /** 직접 입력's blinds editor: a corrected hand's own blinds, else the tournament's (for new hands). */
  const blindsNow = lvNow.level !== null && typeof lvNow.level === "object" ? lvNow.level : null;
  const blindsNote = editing ? "이 핸드만" : classDone(d) ? "이 핸드부터" : "새 핸드부터";
  const closePanel = () => {
    pending.current = null;
    setPanel(null);
  };
  // The hand's sheet: Android back / the header's ‹ closes a panel in it, else the sheet (the class stays).
  useBackHandler(
    sheetOpen
      ? () => {
          if (panel) closePanel();
          else closeSheet();
          return true;
        }
      : null,
  );
  /** "액션도 기록" / "액션 접기", at the bottom of what is typed (under the save slot, or under the actions); not while a decision on file is corrected. */
  const moreToggle = forced ? null : (
    <MoreToggle
      open={actionsView}
      onToggle={() => {
        const c = cur();
        set(c.actions ? without(c, "actions") : { ...c, actions: true });
      }}
    />
  );
  const savedSlot = saved ? (
    <>
      <span className="fr-text">
        <b>{saved.text || "저장했어요"}</b>{" "}
        <small>
          {saved.line}
          {saved.res && (
            <>
              {" "}
              <span className="fr-net">{saved.res.text}</span>
              {saved.res.bb && (
                <>
                  {" "}
                  <Bb v={saved.res.bb} />
                </>
              )}
            </>
          )}
          {saved.board}
        </small>
      </span>
      <button type="button" onClick={undo}>
        되돌리기
      </button>
    </>
  ) : null;

  // The tournament section (내 핸드): its title and line, the way back to the one before, the list's card when none is current.
  const tnTitle = tn ? tourneyTitle(tn, hands) : "";
  const tnCount = tn ? hands.filter((h) => h.fast === true && h.tourney === tn.id).length : 0;
  /** It is on today's clock (not one resumed on a later day). */
  const tnOnDay = !!tn && onTourneyDay(tn, hands, tick);
  /** My stack now (before the hand being typed), for the line by my seat; null when no count is known. */
  const seatStack = !other && !editing ? stackPre.chips : null;
  const seatStackBb = seatStack !== null ? bbPart(seatStack, lvLive.level) : null;
  // An empty tournament never resumed: "새 토너먼트 취소" back to the one current when it was started (cancelTarget), else "새 토너먼트 지우기".
  const tnFresh = !!tn && tnCount === 0 && tn.activeAt === tn.createdAt;
  const backTn = tn && tnFresh ? cancelTarget(tn, tourneys, hands) : null;
  // My stack now, as the graph ends (a 칩 업데이트 with no hand yet: that stack).
  const tnRun = tn && !other ? chipSeries(session, "chips", tn.startStack, tnChecks) : null;
  const tnEnd = tnRun?.absolute ? Math.round(tnRun.end) : tnChecks.length ? tnChecks[tnChecks.length - 1].stack : null;
  // One started by a hand on its own follows the day's start time: the clock the estimate runs on.
  const tnWhen = tn ? (tn.auto && tnOnDay && est?.startClock ? `${est.startClock} 시작` : tourneyWhen(tn, hands)) : "";
  // The line up to my stack now; the stack ends it with its bb at the level now, kept together with the word
  // before it ("→ 61,700 123.4bb", "지금 61,700 123.4bb": tnEndLead).
  const tnMeta = tn
    ? `${tnWhen} · ${session.length}핸드${tn.startStack !== null ? ` · 시작 ${chipsText(tn.startStack)}${tnEnd !== null ? " " : ""}` : tnEnd !== null ? " · " : ""}`
    : "";
  const tnEndLead = tn && tn.startStack !== null ? "→ " : "지금 ";
  const tnEndBb = tn && tnEnd !== null ? bbPart(tnEnd, lvLive.level) : null;
  /** The tournament's 칩 업데이트 with what each changed, and the list: the hands shown, each 칩 업데이트 among them by its time. */
  const steps = useMemo(() => (tn && !other ? checkSteps(session, tn.startStack, tnChecks) : []), [tn, other, session, tnChecks]);
  const oldestShown = session.length > recent.length ? recent[recent.length - 1].createdAt : -Infinity;
  const rows = [
    ...recent.map((h) => ({ t: h.createdAt, k: 0 as const, h })),
    ...steps.filter((c) => c.at >= oldestShown).map((c) => ({ t: c.at, k: 1 as const, c })),
  ].sort((a, b) => b.t - a.t || b.k - a.k);
  function dropCheck(c: StackCheck) {
    if (!tn || !confirm(`${clock(c.at)} 칩 업데이트 ${chipsText(c.stack)}을 지울까요?`)) return;
    if (!removeCheck(tn.id, c.at)) setTnMsg({ text: FULL_MSG, bad: true });
  }
  // A 칩 업데이트's bb: at the level of the hands around it (none yet: the level now).
  const checkRows = (xs: typeof steps) => xs.map((c) => <CheckRow key={`c${c.at}`} c={c} level={levelNear(session, c.at) ?? lvLive.level} onRemove={() => dropCheck(c)} />);
  /** The time a 지우기 went through: a second tap of it landing on the card's 이어 적기 under it is not taken. */
  const goneAt = useRef(0);
  const groups = !other && !tn && !session.length ? tourneyGroups(tourneys, hands, at) : null;
  const lastGroup = groups ? groups.tourneys.reduce<TourneyGroup | null>((b, g) => (g.t && (!b || (b.t && g.t.activeAt > b.t.activeAt)) ? g : b), null) : null;
  const pickView = (u: Unit) => set(u === "bb" ? { ...cur(), view: "bb" } : without(cur(), "view"));
  const newBtn = (
    <button type="button" className="tn-new" onClick={() => setSheet("new")}>
      ＋ 새 토너먼트
    </button>
  );
  const pastLink = (
    <button type="button" className="log-link" onClick={() => go("log/fast/past")}>
      토너먼트 기록 ›
    </button>
  );
  /** "새 토너먼트 취소": the empty tournament just started goes and the one current then is again; "새 토너먼트 지우기": it only goes (none current). */
  function cancelNew() {
    if (!tn) return;
    const title = backTn ? tourneyTitle(backTn, hands) : "";
    if (!cancelNewTourney(tn.id)) return setTnMsg({ text: FULL_MSG, bad: true });
    goneAt.current = Date.now();
    setTnMsg({ text: backTn ? `'${title}'에 이어 적어요` : "지웠어요 · 다음 핸드부터 새로 시작돼요" });
  }
  /** 이어 적기 on the last tournament's card. */
  function resumeLast(g: TourneyGroup) {
    if (!g.t || Date.now() - goneAt.current < 800) return;
    setTnMsg(resumeTourney(g.t.id) ? { text: `'${groupTitle(g, hands)}'에 이어 적어요` } : { text: FULL_MSG, bad: true });
  }

  return (
    <div className={`fast${sheetOpen ? " calc-open" : ""}`}>
      <div className="fast-bar" ref={barRef}>
        <div className="fast-stages" role="group" aria-label="스택 구간 (차트)">
          {PRE_STAGES.map((x) => (
            <button key={x} type="button" className={stage === x ? "on" : ""} aria-pressed={stage === x} onClick={() => pickStage(x)}>
              {STAGE_LABEL[x]}
            </button>
          ))}
        </div>
        <button type="button" className="fast-size" aria-expanded={sizes} aria-label={`테이블 ${players}인 · 인원 바꾸기`} onClick={() => setSizes(!sizes)}>
          {players}인 <i>{sizes ? "▴" : "▾"}</i>
        </button>
      </div>
      {sizes && (
        <div className="fast-row fast-sizes">
          {TABLE_SIZES.filter((n) => n >= 3).map((n) => (
            <button key={n} type="button" className={n === players ? "on" : ""} onClick={() => pickPlayers(n)}>
              {n}인
            </button>
          ))}
        </div>
      )}
      {full && (
        <div className="notice error" role="alert">
          {FULL_MSG}
        </div>
      )}

      <div className="fast-sec">
        <div className="fast-label">
          {other ? "상대 포지션" : "내 포지션"} <b>{d.seat}</b>
          {editing ? (
            // Correcting a saved hand: its time, 삭제 and 취소 in this line (in the toggle's place), so the hand row stays where it is.
            <span className="fast-edit-mini" role="status">
              <span>✎ {clock(editing.createdAt)} 수정 중</span>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (!confirm("이 핸드를 지울까요?")) return;
                  // Back to the new hand put aside, with 되돌리기 at the bottom for a few seconds.
                  deleteWithUndo([editing.id]);
                }}
              >
                삭제
              </button>
              <button type="button" onClick={() => set(cancelEdit(cur()))}>
                취소
              </button>
            </span>
          ) : other ? (
            <QuickToggle mine={false} go={go} />
          ) : seatStack !== null ? (
            // My stack now and its bb, by my seat (a tap: 칩 업데이트).
            <button type="button" className="seat-stack" aria-label={`내 스택 ${chipsText(seatStack)} · 칩 업데이트`} disabled={!tn} onClick={() => setSheet("chips")}>
              {chipsText(seatStack)}
              {seatStackBb && (
                <>
                  {" "}
                  <Bb v={seatStackBb} />
                </>
              )}
            </button>
          ) : null}
        </div>
        <div className={`fast-row fast-seats n${seats.length}`}>
          {seats.map((x) => (
            <button key={x} type="button" className={d.seat === x ? "on" : ""} onClick={() => draft((v, p) => withSeat(v, x, p))}>
              <SeatText seat={x} tight={seats.length >= 10} />
            </button>
          ))}
        </div>
      </div>

      <div className="fast-sec">
        <div className={focus === "hand" ? "fast-label" : "fast-label hand-line"} ref={handRowRef}>
          {/* The sheet back to the hand: the whole line is one button laid over it (the note and the class under it stay plain text). */}
          {focus !== "hand" && <button type="button" className="hand-hit" aria-label={`핸드 ${cls || ""} · 다시 입력`} onClick={closeSheet} />}
          핸드
          {nudge && (
            <span className="fast-nudge" role="alert">
              {nudge}
            </span>
          )}
          <AjaeReaction cue={ajaeNow.cue} seat={d.seat} stage={stage} players={players} off={other}>
            <span className={`fast-class${classDone(d) ? " done" : ""}`} aria-live="polite">
              {cls || "—"}
              {needSuit && d.suited === null ? <small>?</small> : null}
            </span>
          </AjaeReaction>
        </div>
        {/* The rank pad stays in its place under the sheet (hidden while it is up): opening and closing move nothing. */}
        <div className="fast-pad fast-under">
          {PAD.map((k) => (
            <button key={k} type="button" onClick={() => rank(k)}>
              {k}
            </button>
          ))}
          <button type="button" className="fast-back" aria-label="지우기" disabled={!d.ranks.length} onClick={() => draft(undoTap)}>
            ⌫
          </button>
        </div>
        <div className={`fast-suits fast-under${needSuit && d.suited === null ? " ask" : ""}`}>
          <button type="button" className={d.suited === true ? "on" : ""} disabled={!needSuit} onClick={() => draft((v) => pickSuited(v, true))}>
            수딧
          </button>
          <button type="button" className={d.suited === false ? "on" : ""} disabled={!needSuit} onClick={() => draft((v) => pickSuited(v, false))}>
            오프수트
          </button>
        </div>
      </div>

      {!other && (
        <>
          <ResultRow
            enabled={canSave}
            seat={d.seat}
            level={lvNow.level}
            levelText={levelText}
            levelClass={levelClass}
            pickerOpen={!!panel && !sheetOpen}
            res={d.res}
            amount={d.amount}
            unit={unit}
            stackNow={d.stackNow}
            stackUnit={stackUnitOf(d)}
            marks={d.board ?? []}
            before={stackPre}
            bbAnte={anteNow}
            onOpen={() => draft((v) => entryField(v, cur()))}
            onLevel={toggleLevel}
          />
          {!sheetOpen && picker && <div className="fast-under">{picker}</div>}
          {!actionsView && (
            // The save slot: the hand just saved (with 되돌리기), else 저장 with what it will do, else what to tap next.
            <div className={`fast-result fast-under${saved ? ` shown ${saved.tone}` : ""}`} role="status" aria-live="polite">
              {saved ? (
                savedSlot
              ) : canSave && !editing && !d.res && !d.amount && !d.stackNow ? (
                // The hand in, nothing typed yet: 폴드 (saved at once) or 스택 입력 (the calculator). The hand stays editable till then.
                <>
                  <button type="button" className="fs-save fs-fold" onClick={() => save("fold")}>
                    폴드
                  </button>
                  <button type="button" className="fs-save fs-stack" onClick={() => pickTab("stack")}>
                    스택 입력
                  </button>
                </>
              ) : canSave ? (
                <button type="button" className={`fs-save${d.res || editing ? "" : " plain"}`} disabled={waits} onClick={() => save("save")}>
                  {saveLabel}
                </button>
              ) : (
                <span className="fr-hint">{needSuit ? "수딧인지 오프수트인지 골라 주세요" : "랭크 두 개를 누르세요"}</span>
              )}
            </div>
          )}
          {!actionsView && moreToggle}
        </>
      )}

      {actionsView && (
        <>
          <div className="fast-sec fast-under">
            <div className="fast-label">상황{other && <small>상대 앞에서</small>}</div>
            <div className="fast-row fast-spots">
              {SPOTS.map((x) => {
                const three = x === "3bet";
                const on = three ? isThreeBet(d.spot) : d.spot === x;
                const can = three ? spots.includes("3bet") || spots.includes("cold3") : spots.includes(x);
                // 3벳 이상: over my open where I can open, else (the BB) a cold one.
                const to: FastSpot = three && !spots.includes("3bet") ? "cold3" : x;
                return (
                  <button key={x} type="button" className={on ? "on" : ""} disabled={!can} onClick={() => !on && draft((v) => withSpot(v, to))}>
                    <span>{chip[x][0]}</span>
                    <span>{chip[x][1]}</span>
                  </button>
                );
              })}
            </div>
            {(d.spot === "open" || d.spot === "shove") && (
              <div className="fast-opener">
                <span className="fast-sub">
                  {d.spot === "open" ? "오픈" : "올인"}
                  <br />
                  자리
                </span>
                <div className={`fast-row fast-seats n${before.length}`}>
                  {before.map((x) => (
                    <button key={x} type="button" className={d.opener === x ? "on" : ""} onClick={() => draft((v) => ({ ...v, opener: x }))}>
                      <SeatText seat={x} tight={before.length >= 9} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {isThreeBet(d.spot) && (
              <div className="fast-opener">
                <span className="fast-sub">
                  누가
                  <br />
                  오픈
                </span>
                <div className="fast-row fast-who">
                  <button type="button" className={d.spot === "3bet" ? "on" : ""} disabled={!spots.includes("3bet")} onClick={() => draft((v) => withSpot(v, "3bet"))}>
                    {other ? "상대 오픈에 3벳" : "내 오픈에 3벳"}
                  </button>
                  <button type="button" className={d.spot === "cold3" ? "on" : ""} disabled={!spots.includes("cold3")} onClick={() => draft((v) => withSpot(v, "cold3"))}>
                    남끼리 오픈·3벳
                  </button>
                </div>
              </div>
            )}
            {d.spot === "limp" && <p className="fast-hint">림프 팟은 차트가 없어서 판정 없이 저장돼요</p>}
          </div>

          <div className="fast-sec fast-under" ref={actsRef}>
            <div className="fast-label">{other ? "상대 액션" : "내 액션"}</div>
            <div className={`fast-acts n${Math.max(acts.length, 1)}`}>
              {acts.length ? (
                acts.map((a) => (
                  <button key={a} type="button" className={`a-${a}${editing && savedAct === a ? " on" : ""}`} disabled={!ready || waits} onClick={() => act(a)}>
                    {actLabel(d.spot, a, d.seat)}
                  </button>
                ))
              ) : (
                <button type="button" className="a-walk" disabled={!ready || waits} onClick={() => act(undefined)}>
                  워크 (모두 폴드)
                </button>
              )}
            </div>
            {/* One fixed-height slot: the verdict of the hand just saved (with 되돌리기), else what to tap next. */}
            <div className={`fast-result${saved ? ` shown ${saved.tone}` : ""}`} role="status" aria-live="polite">
              {saved ? (
                savedSlot
              ) : (
                <span className="fr-hint">
                  {ready
                    ? waits
                      ? BLOCK_TEXT[block]
                      : editing
                      ? "누르면 이 핸드를 고쳐서 저장해요"
                      : other
                        ? `누르면 바로 저장 · 자리는 ${d.seat} 그대로`
                        : d.res || d.amount || d.stackNow
                          ? `누르면 바로 저장 · 다음 핸드는 ${nextSeat(players, d.seat)}`
                          : "폴드는 바로 저장 · 다른 액션은 계산기에 결과를 넣고 저장"
                    : !classDone(d)
                      ? needSuit
                        ? "수딧인지 오프수트인지 골라 주세요"
                        : "랭크 두 개를 누르세요"
                      : "오픈·올인한 자리를 골라 주세요"}
                </span>
              )}
            </div>
          </div>
          {/* Open, the toggle goes under the actions: the hand, the result, the board and the actions fit one screen. */}
          {!other && moreToggle}
        </>
      )}

      <section className="card-box fast-today">
        {other ? (
          <>
            <div className="fast-today-head">
              <h2>오늘 남의 핸드</h2>
              <span className="muted small">{session.length}핸드</span>
            </div>
            {tn && (
              <p className="tn-meta">
                {tnTitle} · {tourneyWhen(tn, hands)}
              </p>
            )}
          </>
        ) : tn ? (
          <>
            <div className="fast-today-head tn-head">
              <h2>
                <button type="button" className="tn-title" aria-label={`토너먼트 정보 고치기: ${tnTitle}`} onClick={() => setSheet("edit")}>
                  <span>{tnTitle}</span>
                  <i>✎</i>
                </button>
              </h2>
              {newBtn}
            </div>
            <div className="tn-meta-row">
              <p className="tn-meta">
                {tnMeta}
                {tnEnd !== null && (
                  <span className="tn-end">
                    {tnEndLead}
                    {chipsText(tnEnd)}
                    {tnEndBb && (
                      <>
                        {" "}
                        <Bb v={tnEndBb} />
                      </>
                    )}
                  </span>
                )}
              </p>
              <button type="button" className="tn-upd" onClick={() => setSheet("chips")}>
                칩 업데이트
              </button>
            </div>
            {tn.startStack === null && (
              <button type="button" className="tn-invite" onClick={() => setSheet("edit")}>
                {tn.name ? "＋ 시작 스택 넣기" : "＋ 시작 스택·이름 넣기"}
                <small>그래프가 시작 스택부터</small>
              </button>
            )}
            {tnFresh && (
              <div className="tn-cancel">
                <span>아직 핸드가 없어요</span>
                <button type="button" onClick={cancelNew}>
                  {backTn ? "새 토너먼트 취소" : "새 토너먼트 지우기"}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="fast-today-head tn-head">
              <h2>오늘 빠른 기록</h2>
              {session.length ? <span className="muted small">{session.length}핸드</span> : null}
              {newBtn}
            </div>
            {session.length ? <p className="tn-meta">토너먼트 없이 적은 기록이에요 · 다음 핸드를 적으면 이 핸드들도 토너먼트로 모여요</p> : null}
          </>
        )}
        {session.length ? (
          <>
            {!other && <ChipsBlock hands={session} view={view} onView={pickView} startStack={tn?.startStack ?? null} checks={tnChecks} title={tn ? "칩 흐름" : "오늘 칩 흐름"} />}
            <FastStatsRow stats={stats} other={other} />
            <div className="fast-list">
              {rows.map((r) =>
                r.k === 1 ? (
                  checkRows([r.c])
                ) : (
                  <FastItem key={r.h.id} h={r.h} view={view} other={other} editing={d.editing === r.h.id} onClick={() => edit(r.h)} />
                ),
              )}
            </div>
            {tn && !other ? (
              <p className="muted small">
                핸드를 누르면 고치거나 지울 수 있어요
                {session.length > recent.length ? (
                  <>
                    {` · 최근 ${recent.length}핸드만 `}
                    <button type="button" className="log-link tn-all" onClick={() => go(`log/fast/t/${tn.id}`)}>
                      전부 보기 ›
                    </button>
                  </>
                ) : null}
              </p>
            ) : (
              <p className="muted small">
                핸드를 누르면 고치거나 지울 수 있어요{session.length > recent.length ? ` · 최근 ${recent.length}핸드만 보여요, 전부는 지난 기록에서` : ""}
              </p>
            )}
            <div className="fast-today-foot">
              <button
                type="button"
                className="ghost small"
                onClick={async () => setCopied((await copyText(sessionText(session, mode, tn ? infoOf(tn, hands) : undefined))) ? "복사했어요 · 카톡이나 Claude에 붙여 넣으세요" : "복사하지 못했어요")}
              >
                {tn && !other ? "요약 복사" : "오늘 요약 복사"}
              </button>
              {other ? (
                <button type="button" className="log-link" onClick={() => go("log/list/other")}>
                  지난 기록 ›
                </button>
              ) : (
                pastLink
              )}
            </div>
            {copied && <p className="fast-hint ok">{copied}</p>}
          </>
        ) : other ? (
          <p className="muted small">아직 오늘 남의 핸드가 없어요. 보인 핸드마다 상대 자리 → 랭크 두 개 → 수딧/오프 → 상황 → 상대 액션만 누르면 저장돼요. 펍 사람들이 실제로 어떻게 치는지 모여요.</p>
        ) : tn ? (
          <>
            {steps.length > 0 && <div className="fast-list">{checkRows([...steps].reverse())}</div>}
            {!tnFresh && <p className="muted small">아직 이 토너먼트에 핸드가 없어요. 핸드를 적으면 여기 모여요.</p>}
            <div className="fast-today-foot end">{pastLink}</div>
          </>
        ) : (
          <>
            {lastGroup && lastGroup.t && (
              <div className="tn-card">
                <div className="tn-card-main">
                  <small className="muted">지난 토너먼트</small>
                  <b>{groupTitle(lastGroup, hands)}</b>
                  <span className="muted small">
                    {dateOf(lastGroup.day)} · {lastGroup.hands.length}핸드 · <GroupRes g={lastGroup} />
                  </span>
                </div>
                <button type="button" className="tn-resume" onClick={() => resumeLast(lastGroup)}>
                  이어 적기
                </button>
              </div>
            )}
            <p className="muted small">아직 오늘 기록이 없어요. 핸드를 적으면 토너먼트가 시작돼요 (이름·시작 스택은 나중에). 핸드마다 랭크 두 개 → 수딧/오프 → 폴드, 아니면 스택 입력에 지금 스택만 누르면 돼요 (빼기는 앱이). 보드는 기억나는 카드만.</p>
            {groups && (groups.tourneys.length > 0 || groups.legacy.length > 0) && <div className="fast-today-foot end">{pastLink}</div>}
          </>
        )}
        {tnMsg && !other && <p className={`fast-hint ${tnMsg.bad ? "bad" : "ok"}`}>{tnMsg.text}</p>}
      </section>
      {sheet === "new" && !other && (
        <TourneySheet
          mode="new"
          initial={newFields(Date.now())}
          defaultName={defaultTitle(Date.now())}
          levelText={(clock) => sheetLevelText(clock, null, hands, Date.now())}
          join={tn ? 0 : runningUntagged(hands, Date.now()).length}
          onSave={(f, join) => {
            const id = startTourney(f, Date.now(), join);
            if (!id) return FULL_MSG;
            setSheet(null);
            setTnMsg({ text: `'${f.name.trim() || defaultTitle(Date.now())}' 시작 · 다음 핸드부터 여기 모여요` });
            return null;
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "chips" && !other && tn && (
        <ChipUpdateSheet
          now={countFor(tn, hands)}
          level={lvLive.level}
          open={openCheck(tn, hands)}
          onSave={(stack) => {
            const was = countFor(tn, handLogStore.get().hands).chips;
            if (!checkStack(tn.id, stack, Date.now())) return FULL_MSG;
            setSheet(null);
            const diff = was === null ? null : stack - was;
            setTnMsg({ text: `칩 업데이트 ${chipsText(stack)}${diff ? ` · 앱보다 ${signedText(diff, "chips")}` : diff === 0 ? " · 앱이 센 것과 같아요" : ""}` });
            return null;
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "edit" && !other && tn && (
        <TourneySheet
          mode="edit"
          initial={currentFields(tn, est, tnOnDay)}
          // A start stack not on file shows the pub's 50,000 as an offer (cleared on switching to 직접 입력).
          offered={tn.startStack === null}
          defaultName={tourneyTitle({ ...tn, name: "" }, hands)}
          levelText={(clock) => sheetLevelText(clock, tn, hands, Date.now())}
          note={startNote(tn, hands, true, Date.now())}
          canDelete
          handCount={hands.filter((h) => h.tourney === tn.id).length}
          current
          onSave={(f) => {
            if (!editTourney(tn.id, f)) return FULL_MSG;
            setSheet(null);
            return null;
          }}
          onDelete={() => {
            if (!deleteTourneyAll(tn.id)) setTnMsg({ text: FULL_MSG, bad: true });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheetOpen && (
        <CalcSheet label="결과 입력" className="hand">
          {panel === "level" && picker ? (
            <LevelPanel onClose={toggleLevel}>{picker}</LevelPanel>
          ) : panel === "blinds" ? (
            <BlindsPanel initial={blindsNow} applyNote={blindsNote} onApply={applyBlinds} onCancel={closePanel} />
          ) : (
            <HandSheet
              mode={modeOf(focus)}
              seat={d.seat}
              level={lvNow.level}
              levelText={levelText}
              levelClass={levelClass}
              custom={custom}
              unit={unit}
              stackUnit={stackUnitOf(d)}
              res={d.res}
              amount={d.amount}
              stackNow={d.stackNow}
              marks={d.board ?? []}
              target={boardTarget(d)}
              holeRanks={d.ranks}
              before={stackPre}
              bbAnte={anteNow}
              editing={!!editing}
              actionsView={actionsView}
              act={d.act ? actLabel(d.spot, d.act, d.seat) : null}
              waits={waits ? blockText(block, custom) : null}
              next={next}
              onTab={pickTab}
              onLevel={toggleLevel}
              onKey={(k) => draft((v) => typeDigit(v, k))}
              onBack={() => draft(backKey)}
              onUnit={pickUnit}
              onFold={() => save("fold")}
              onWalk={() => save("walk")}
              onSave={() => (actionsView ? (d.act ? act(d.act, false, "sheet") : closeSheet()) : save("save"))}
              onNoResult={() => d.act && act(d.act, false, "bare")}
              onSign={sign}
              onToStack={() => draft((v) => pickEntry(v, "stack"))}
              onRank={boardRank}
              onSuit={boardSuit}
              onSlot={(i) => draft((v) => pickBoardSlot(v, i))}
              onClose={closeSheet}
            />
          )}
        </CalcSheet>
      )}
      {/* Between hands (or the sheet closed), a 직접 입력 tournament's blinds in a sheet of their own. */}
      {!sheetOpen && panel === "blinds" && <BlindsSheet initial={blindsNow} applyNote={blindsNote} onApply={applyBlinds} onClose={closePanel} />}
      {shield && <div className="calc-shield" aria-hidden="true" />}
    </div>
  );
}

/** The 야자수 새틀 level picker in the hand's sheet, in the keys' place (the sheet keeps its height): "레벨 [닫기]" over it. */
function LevelPanel({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useCalcKeys({ escape: onClose });
  return (
    <>
      <div className="calc-top">
        <b className="calc-title">레벨</b>
        <span className="calc-note">야자수 새틀</span>
        <button type="button" className="calc-x" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="calc-lv">{children}</div>
    </>
  );
}

