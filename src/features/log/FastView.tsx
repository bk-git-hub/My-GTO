import { useEffect, useMemo, useRef, useState } from "react";
import type { Go } from "../../backNav";
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
  fastLevel,
  fastOtherStore,
  fastStats,
  fastStore,
  focusOf,
  keptAction,
  keyUnitOf,
  nextSeat,
  pickBoardSlot,
  pickRes,
  pickSuited,
  resultText,
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
  withFastResult,
  withSeat,
  withSpot,
  type FastBlock,
  type FastDraft,
  type FastLevel,
  type FastMode,
  type FastRes,
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
  type LoggedHand,
} from "./handLog";
import { chipSeries, chipsText, levelChip, postedBy, type Unit } from "./fastChips";
import { ChipsBlock, clock, copyText, FastItem, FastStatsRow } from "./FastParts";
import { BoardPad, BoardRow, DigitPad, MoreToggle, ResultSec, SuitRow, UnitRow } from "./FastResult";
import {
  cancelNewTourney,
  cancelTarget,
  clockOf,
  currentTourney,
  dateOf,
  defaultTitle,
  deleteTourney,
  editTourney,
  fastEstimate,
  fastSession,
  currentFields,
  groupTitle,
  infoOf,
  newFields,
  onTourneyDay,
  resumeTourney,
  runningUntagged,
  saveNewFast,
  setFastStartClock,
  stampPick,
  stampStoredPick,
  sheetLevelText,
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
import { cleanTourneys } from "./tourney";
import { GroupRes } from "./TourneyScreens";
import { TourneySheet } from "./TourneySheet";
import { closeUndoOffer, deleteWithUndo } from "./undoDelete";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";

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
  line: string;
  /** The slot's tint: the verdict's ("v-over"), or for a hand saved without a decision its result's ("r-win"). */
  tone: string;
}

/** Why the save waits, as the save button says it. */
const BLOCK_TEXT: Record<Exclude<FastBlock, "class">, string> = {
  sign: "땄어요? 잃었어요?",
  level: "bb로 넣으려면 레벨을 골라 주세요",
  stack: "지금 스택이 이번에 딴 칩보다 적어요",
  board: "보드 카드가 핸드와 겹쳐요",
};

/** A hand being corrected: the level and BB ante on its draft (a draft stored before they were kept: the hand's own). */
const editLevel = (d: FastDraft, h: LoggedHand): FastLevel => (d.level !== undefined ? { level: d.level, guessed: !!d.levelGuess } : { level: h.level, guessed: !!h.levelGuess });
const editAnte = (d: FastDraft, h: LoggedHand): boolean => (d.level !== undefined ? !d.noAnte : h.bbAnte);

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
  if (other) return { id: h.id, kind: v?.kind ?? "none", text: v?.text ?? "", line: `${base} ${fastActText(h)}`, tone: `v-${v?.kind ?? "none"}` };
  const line = [base, acted ? fastActText(h) : "", resultText(h)].filter(Boolean).join(" ") + (h.board.length ? ` · ${rememberedText(h)}` : "");
  const tone = acted ? `v-${v?.kind ?? "none"}` : `r-${h.result === "win" || h.result === "chop" ? "win" : h.result === "lose" ? "lose" : h.result === "fold" ? "fold" : "none"}`;
  return { id: h.id, kind: v?.kind ?? "none", text: acted ? (v?.text ?? "") : "", line, tone };
}

/**
 * 빠른 기록: every hand dealt to me, a few taps each. The stage and the table size stay for the session;
 * my seat moves on by itself after each hand; the class goes in on a rank pad (no suits); then the
 * result: 폴드 (one tap, saved at once, the blind it cost from my seat and the level) or 수익 / 손실 and the
 * amount in chips or bb on the same keypad, and the board cards I remember (ranks, a suit if I know it);
 * 저장 saves and starts the next hand. The current tournament's list adds the chips up and draws them as a
 * graph from its start stack; every new hand goes to that tournament with no tap of its own (fastTourney.ts),
 * and "＋ 새 토너먼트" at the list's head starts another (the sheet), well away from the pad.
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
  /** The tournament sheet open: a new tournament, or the current one's details. */
  const [sheet, setSheet] = useState<null | "new" | "edit">(null);
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
  // 빠른 기록 grades only the hands saved with a decision.
  const stats = useMemo(() => fastStats(other ? session : session.filter(fastActed)), [session, other]);
  /** The level the clock gives: the tournament's start, else today's (a tournament resumed on a later day: today's only). */
  const est = useMemo(() => tourneyEstimate(tn, tick, levelEstimateAt(tick, log)), [tn, tick, log]);
  const [lvOpen, setLvOpen] = useState(false);
  /** A save waiting for the level (a blind's fold or a walk tapped with no level known): it goes through once a level is picked. */
  const pending = useRef<(() => void) | null>(null);
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

  // Any change to the hand on screen starts the next hand: the last verdict gives way to the hints.
  const draft = (f: (x: FastState["draft"], p: number) => FastState["draft"]) => {
    const c = cur();
    const next = f(c.draft, draftPlayers(c));
    set({ ...c, draft: next });
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
  /**
   * The level and BB ante the draft saves at: a corrected hand's own; a new hand's from the session
   * (fastLevel) at this moment: a level picked in the current tournament, else its start time's estimate.
   */
  function levelNow(c: FastState, editHand: LoggedHand | null, at: number): { lv: FastLevel & { picked?: boolean }; ante: boolean } {
    if (editHand) return { lv: editLevel(c.draft, editHand), ante: editAnte(c.draft, editHand) };
    const st = handLogStore.get();
    const t = currentTourney(cleanTourneys(st.tourneys), st.hands, at);
    return { lv: fastLevel(c, fastSession(t, st.hands, at, mode), at, tourneyEstimate(t, at, levelEstimateAt(at, st)), t?.id ?? null), ante: !c.noAnte };
  }
  /**
   * `h` on file, the editor on to the next hand, the save slot showing it. A new hand (`at`: the moment it
   * was tapped) goes to the current tournament, or starts one on its own (saveNewFast: in the same write);
   * a level picked before that one now belongs to it. A corrected hand (`at` null) keeps its own.
   */
  function commit(c: FastState, h: LoggedHand, at: number | null) {
    const r = at !== null ? saveNewFast(h, at) : { ok: saveHand(h), hand: h, started: null };
    setFull(!r.ok);
    // Not on file: the hand stays on screen to try again.
    if (!r.ok) return;
    // Only one 되돌리기 on screen: the one in the save slot, for the hand just saved.
    closeUndoOffer();
    let next = afterSave(c, r.hand, handLogStore.get().hands, mode);
    if (r.started && at !== null) {
      if (other) stampStoredPick(r.started.id, at);
      else next = stampPick(next, r.started.id, at);
    }
    set(next);
    setSaved(savedOf(r.hand, other));
    setNudge(null);
    pending.current = null;
    // Scrolled down to 내 액션: the next hand's keypad back in view (the verdict under the actions stays when it fits).
    if (!other) requestAnimationFrame(() => reveal(handRowRef.current?.parentElement ?? null));
  }

  /** The level picker opened for a save that needs the level; `then` runs once one is picked. */
  function askLevel(then: () => void, why: string) {
    pending.current = then;
    setLvOpen(true);
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
  /** Nothing saved: what is missing, as the save button would say it (the level: the picker, the save after it). */
  function whyNot(d: FastDraft, p: number, level: number | null, ante: boolean, retry: () => void) {
    const b = blockOf(d, p, level, ante);
    if (b === "level" && level === null) askLevel(retry, "레벨을 고르면 저장돼요");
    else if (b && b !== "class") setNudge(BLOCK_TEXT[b]);
  }

  function act(a: PreAction | undefined, asked = false) {
    const c = cur();
    const p = draftPlayers(c);
    const editHand = editHandOf(c);
    const at = Date.now();
    // A new hand goes to the current tournament (or starts one) as it is saved; a corrected hand keeps its own.
    const base = editHand ?? { ...freshHand(mode), players: p };
    const saveAt = editHand ? null : at;
    if (other) {
      const h = fastHand(c.draft, a, base, draftStage(c), p, mode);
      if (h) commit(c, h, saveAt);
      return;
    }
    // 액션도 기록: the action saves the result and board typed so far; a fold or a walk with none typed is one.
    const d = c.draft.res || c.draft.amount ? c.draft : a === "fold" ? pickRes(c.draft, "fold") : a === undefined ? pickRes(c.draft, "walk") : c.draft;
    setTick(at);
    const { lv, ante } = levelNow(c, editHand, at);
    if (!asked && needsLevel(d, lv, editHand)) return askLevel(() => act(a, true), "블라인드라서 레벨을 골라 주세요");
    const made = fastHand(d, a, base, draftStage(c), p, mode);
    const h = made && withFastResult(made, d, lv, ante);
    if (h) commit(c, h, saveAt);
    else if (made) whyNot(d, p, lv.level, ante, () => act(a, true));
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
    if (!asked && needsLevel(d, lv, editHand)) return askLevel(() => save(kind, true), "블라인드라서 레벨을 골라 주세요");
    // A new hand goes to the current tournament (or starts one) as it is saved; a corrected hand keeps its own.
    const base = editHand ?? { ...freshHand(mode), players: p };
    const kept = editHand ? keptAction(editHand, d) : null;
    const made = (kept !== null ? fastHand(d, kept, base, draftStage(c), p, mode) : null) ?? fastHand(d, null, base, draftStage(c), p, mode);
    const h = made && withFastResult(made, d, lv, ante);
    if (h) commit(c, h, editHand ? null : at);
    else if (made) whyNot(d, p, lv.level, ante, () => save(kind, true));
  }
  function pickResult(r: FastRes) {
    if (r === "fold" || r === "walk") save(r);
    else draft((v) => pickRes(v, r));
  }
  const focusTo = (f: Parameters<typeof setFocus>[1]) => draft((v) => setFocus(v, f));
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
    if (c.draft.editing) draft((v) => ({ ...without(without(v, "level"), "levelGuess"), level, ...(guessed && level !== null ? { levelGuess: true as const } : {}) }));
    else {
      // A level picked holds in the tournament it was picked in (none current: until a hand starts one, which takes it).
      const now = Date.now();
      const st = handLogStore.get();
      const t = currentTourney(cleanTourneys(st.tourneys), st.hands, now);
      set(guessed ? without(c, "levelPick") : { ...c, levelPick: { level, at: now, ...(t ? { t: t.id } : {}) } });
    }
    setLvOpen(false);
    then?.();
  }
  /** The level chip: the picker opens or closes (closed by hand, a save waiting for it is dropped). */
  function toggleLevel() {
    if (lvOpen) pending.current = null;
    setLvOpen(!lvOpen);
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
    setLvOpen(false);
    window.scrollTo({ top: 0 });
  }
  function undo() {
    const h = saved ? handLogStore.get().hands.find((x) => x.id === saved.id) : null;
    if (h) edit(h);
    setSaved(null);
  }

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
  const unit = unitOf(d);
  /** The unit of the field the keypad types into (the amount's, or 지금 스택's). */
  const keyUnit = keyUnitOf(d);
  const lvNow: FastLevel & { picked?: boolean } = editing ? editLevel(d, editing) : fastLevel(s, session, tick, est, tn?.id ?? null);
  const anteNow = editing ? editAnte(d, editing) : !s.noAnte;
  const block = other ? null : blockOf(d, players, lvNow.level, anteNow);
  const waits = block !== null && block !== "class";
  // A hand corrected with its decision on file shows the action row (its action lit); else the toggle decides.
  const forced = !other && !!editing && fastActed(editing);
  const actionsView = other || forced || s.actions === true;
  // No level known (and 레벨 모름 not picked on purpose): the chip asks for one once a hand is typed, since a blind's chips and bb need it.
  const declined = !editing && lvNow.level === null && !!lvNow.picked;
  const wantLevel = lvNow.level === null && (block === "level" || (!declined && classDone(d)));
  const levelClass = `${lvNow.guessed ? " est" : ""}${wantLevel ? " ask" : ""}`;
  const levelText = `${levelChip(lvNow.level)}${lvNow.guessed ? " (추정)" : ""}`;
  const canSave = classDone(d) && positionsFor(players).includes(d.seat);
  const next = nextSeat(players, d.seat);
  const saveLabel = waits ? BLOCK_TEXT[block] : editing ? "고쳐서 저장" : d.res ? `저장 · 다음 핸드 ${next}` : `결과 없이 저장 · 다음 ${next}`;
  const picker = lvOpen ? (
    <LevelRow
      h={{ id: editing?.id ?? "fast-new", level: lvNow.level, ...(lvNow.guessed ? { levelGuess: true as const } : {}), bbAnte: anteNow, createdAt: editing?.createdAt ?? tick }}
      open
      onToggle={toggleLevel}
      onLevel={pickLevel}
      onAnte={pickAnte}
      unknownSub="칩으로만"
      // A new hand: the tournament's clock (a hand being corrected keeps the day's start for its own time).
      {...(editing ? {} : { estimate: est, onStartClock: (c: string) => setFastStartClock(c, Date.now()), clockDefault: tn?.startSet ? clockOf(tn.start) : undefined })}
    />
  ) : null;
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
        <b>{saved.text || "저장했어요"}</b> <small>{saved.line}</small>
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
  // An empty tournament never resumed: "새 토너먼트 취소" back to the one current when it was started (cancelTarget), else "새 토너먼트 지우기".
  const tnFresh = !!tn && tnCount === 0 && tn.activeAt === tn.createdAt;
  const backTn = tn && tnFresh ? cancelTarget(tn, tourneys, hands) : null;
  const tnEnd = tn && tn.startStack !== null && !other ? chipSeries(session, "chips", tn.startStack)?.end ?? null : null;
  // One started by a hand on its own follows the day's start time: the clock the estimate runs on.
  const tnWhen = tn ? (tn.auto && tnOnDay && est?.startClock ? `${est.startClock} 시작` : tourneyWhen(tn, hands)) : "";
  const tnMeta = tn
    ? `${tnWhen} · ${session.length}핸드${tn.startStack !== null ? ` · 시작 ${chipsText(tn.startStack)}${tnEnd !== null ? ` → ${chipsText(Math.round(tnEnd))}` : ""}` : ""}`
    : "";
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
    <div className="fast">
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
      {editing && (
        <div className="fast-editing" role="status">
          <span>
            <b>✎ 수정 중</b> {clock(editing.createdAt)} {editing.seat} {holeClass(editing)} · {actionsView ? "액션을 다시 누르면 저장" : "고친 뒤 저장을 누르세요"}
          </span>
          <button
            type="button"
            className="fast-mini danger"
            onClick={() => {
              if (!confirm("이 핸드를 지울까요?")) return;
              // Back to the new hand put aside, with 되돌리기 at the bottom for a few seconds.
              deleteWithUndo([editing.id]);
            }}
          >
            삭제
          </button>
          <button type="button" className="fast-mini" onClick={() => set(cancelEdit(cur()))}>
            취소
          </button>
        </div>
      )}

      <div className="fast-sec">
        <div className="fast-label">
          {other ? "상대 포지션" : "내 포지션"} <b>{d.seat}</b>
          <QuickToggle mine={!other} go={go} />
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
          {/* The keypad back to the hand: the whole line is one button laid over it (the note and the class under it stay plain text). */}
          {focus !== "hand" && <button type="button" className="hand-hit" aria-label={`핸드 ${cls || ""} · 다시 입력`} onClick={() => focusTo("hand")} />}
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
        {/* One keypad: it types into the field that has it (the hand, the amount or 지금 스택, the board); the row under it follows. */}
        {focus === "result" || focus === "stack" ? (
          <DigitPad unit={keyUnit} onKey={(k) => draft((v) => typeDigit(v, k))} onBack={() => draft(backKey)} />
        ) : focus === "board" ? (
          <BoardPad marks={d.board ?? []} holeRanks={d.ranks} onRank={boardRank} onBack={() => draft(backKey)} />
        ) : (
          <div className="fast-pad">
            {PAD.map((k) => (
              <button key={k} type="button" onClick={() => rank(k)}>
                {k}
              </button>
            ))}
            <button type="button" className="fast-back" aria-label="지우기" disabled={!d.ranks.length} onClick={() => draft(undoTap)}>
              ⌫
            </button>
          </div>
        )}
        {focus === "result" || focus === "stack" ? (
          <UnitRow unit={keyUnit} onUnit={pickUnit} />
        ) : focus === "board" ? (
          <SuitRow target={(d.board ?? [])[boardTarget(d)]} onSuit={boardSuit} />
        ) : (
          <div className={`fast-suits${needSuit && d.suited === null ? " ask" : ""}`}>
            <button type="button" className={d.suited === true ? "on" : ""} disabled={!needSuit} onClick={() => draft((v) => pickSuited(v, true))}>
              수딧
            </button>
            <button type="button" className={d.suited === false ? "on" : ""} disabled={!needSuit} onClick={() => draft((v) => pickSuited(v, false))}>
              오프수트
            </button>
          </div>
        )}
      </div>

      {!other && (
        <>
          <ResultSec
            seat={d.seat}
            level={lvNow.level}
            levelLabel={levelText}
            levelClass={levelClass}
            unit={unit}
            res={d.res}
            amount={d.amount}
            bbAnte={anteNow}
            focused={focus === "result"}
            enabled={canSave}
            actionsView={actionsView}
            askSign={block === "sign"}
            pickerOpen={lvOpen}
            picker={picker}
            onAmount={() => focusTo("result")}
            onRes={pickResult}
            onLevel={toggleLevel}
          />
          <BoardRow
            marks={d.board ?? []}
            target={boardTarget(d)}
            stackNow={d.stackNow}
            stackUnit={stackUnitOf(d)}
            level={lvNow.level}
            focus={focus === "board" || focus === "stack" ? focus : null}
            enabled={canSave}
            onSlot={(i) => draft((v) => pickBoardSlot(v, i))}
            onStack={() => focusTo("stack")}
          />
          {!actionsView && (
            // The save slot: the hand just saved (with 되돌리기), else 저장 with what it will do, else what to tap next.
            <div className={`fast-result${saved ? ` shown ${saved.tone}` : ""}`} role="status" aria-live="polite">
              {saved ? (
                savedSlot
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
          <div className="fast-sec">
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

          <div className="fast-sec" ref={actsRef}>
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
                        : `누르면 바로 저장 · 다음 핸드는 ${nextSeat(players, d.seat)}`
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
            <p className="tn-meta">{tnMeta}</p>
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
            {!other && <ChipsBlock hands={session} view={view} onView={pickView} startStack={tn?.startStack ?? null} title={tn ? "칩 흐름" : "오늘 칩 흐름"} />}
            <FastStatsRow stats={stats} other={other} />
            <div className="fast-list">
              {recent.map((h) => (
                <FastItem key={h.id} h={h} view={view} other={other} editing={d.editing === h.id} onClick={() => edit(h)} />
              ))}
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
            <p className="muted small">아직 오늘 기록이 없어요. 핸드를 적으면 토너먼트가 시작돼요 (이름·시작 스택은 나중에). 핸드마다 랭크 두 개 → 수딧/오프 → 폴드, 아니면 수익·손실과 금액만 누르면 돼요. 보드는 기억나는 카드만.</p>
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
      {sheet === "edit" && !other && tn && (
        <TourneySheet
          mode="edit"
          initial={currentFields(tn, est, tnOnDay)}
          defaultName={tourneyTitle({ ...tn, name: "" }, hands)}
          levelText={(clock) => sheetLevelText(clock, tn, hands, Date.now())}
          note={startNote(tn, hands, true, Date.now())}
          canDelete={tnCount === 0}
          current
          onSave={(f) => {
            if (!editTourney(tn.id, f)) return FULL_MSG;
            setSheet(null);
            return null;
          }}
          onDelete={() => {
            if (!deleteTourney(tn.id)) setTnMsg({ text: FULL_MSG, bad: true });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}

    </div>
  );
}
