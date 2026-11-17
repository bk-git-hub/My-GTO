import { useEffect, useMemo, useRef, useState } from "react";
import type { Go } from "../../backNav";
import { RANKS } from "../../poker/cards";
import { AJAE_START, ajaeSeen, ajaeStep, type AjaeState } from "./ajae";
import { AjaeReaction } from "./AjaeReaction";
import {
  actLabel,
  actsFor,
  isThreeBet,
  seatsBefore,
  spotsFor,
  VERDICT_MARK,
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
  hasChips,
  keptAction,
  keyUnitOf,
  nextSeat,
  pickBoardSlot,
  pickRes,
  pickSuited,
  resultText,
  sessionOf,
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
import { ChipGraph } from "./ChipGraph";
import { chipSeries, levelChip, marksOf, missedOf, oldestFirst, postedBy, sessionMoney, signedText, type Unit } from "./fastChips";
import { BoardPad, BoardRow, DigitPad, MarksText, MoneyHead, MoreToggle, ResultSec, SuitRow, UnitRow } from "./FastResult";
import { LevelRow } from "./inputs";
import { levelStage, PRE_STAGES, STAGE_LABEL, type PreAction } from "./quickPre";
import { buttonSeat, positionsFor, TABLE_SIZES } from "./recorder";
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

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** A verdict for a list row: "⚠ 오버 (폴드)", "▽ 언더 (오픈 72%)", another player's "⚠ 루즈 (폴드)", "차트 없음". */
const shortVerdict = (t: string) =>
  t.replace("오버플레이", "오버").replace("언더플레이", "언더").replace("차트보다 루즈", "루즈").replace("차트보다 타이트", "타이트").replace("차트: ", "").replace(" · 림프 팟", "");

/** Plain text to the clipboard: the async API, else a hidden textarea (older iOS). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back below */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
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

/** A list row's chips: "+12,000" / "−6bb" in the unit shown, 폴드 (with the blind it cost: "폴드 −200"), 본전, or – for none. */
function netShown(h: LoggedHand, view: Unit): string {
  if (h.result === "fold") return h.net ? `폴드 ${signedText(h.net, view, h.level)}` : "폴드";
  if (h.net !== null && h.net !== 0) return signedText(h.net, view, h.level);
  if (h.net === 0) return "본전";
  return h.result === "win" ? "땄음" : h.result === "lose" ? "잃음" : "–";
}

/**
 * 빠른 기록: every hand dealt to me, a few taps each. The stage and the table size stay for the session;
 * my seat moves on by itself after each hand; the class goes in on a rank pad (no suits); then the
 * result: 폴드 (one tap, saved at once, the blind it cost from my seat and the level) or 땄음 / 잃음 and the
 * amount in chips or bb on the same keypad, and the board cards I remember (ranks, a suit if I know it);
 * 저장 saves and starts the next hand. Today's list adds the chips up and draws them as a graph.
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
  // A first visit's stage: the level's usual one (from today's start time), else the last one used.
  const [fallback] = useState(() => levelStage(estimatedLevel(levelEstimateAt(Date.now()))) ?? lastStage() ?? "mid");
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
  const [now] = useState(() => Date.now());
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
  const session = useMemo(() => sessionOf(hands, Math.max(now, ...hands.slice(0, 1).map((h) => h.createdAt)), mode), [hands, now, mode]);
  // 빠른 기록 grades only the hands saved with a decision.
  const stats = useMemo(() => fastStats(other ? session : session.filter(fastActed)), [session, other]);
  /** The clock the level estimate follows (빠른 기록: every 30 s, so the level chip and the blinds keep up). */
  const [tick, setTick] = useState(() => Date.now());
  const [lvOpen, setLvOpen] = useState(false);
  /** A save waiting for the level (a blind's fold or a walk tapped with no level known): it goes through once a level is picked. */
  const pending = useRef<(() => void) | null>(null);
  /** 내 액션's section: brought into view when the class is in with 액션도 기록 open. */
  const actsRef = useRef<HTMLDivElement>(null);
  const view: Unit = s.view === "bb" ? "bb" : "chips";
  const money = useMemo(() => sessionMoney(session), [session]);
  const series = useMemo(() => (other ? null : chipSeries(session, view)), [session, view, other]);
  const missed = useMemo(() => (other ? null : missedOf(session)), [session, other]);

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
  /** The level and BB ante the draft saves at: a corrected hand's own; a new hand's from the session (fastLevel) at this moment. */
  function levelNow(c: FastState, editHand: LoggedHand | null, at: number): { lv: FastLevel & { picked?: boolean }; ante: boolean } {
    if (editHand) return { lv: editLevel(c.draft, editHand), ante: editAnte(c.draft, editHand) };
    return { lv: fastLevel(c, sessionOf(handLogStore.get().hands, at, mode), at), ante: !c.noAnte };
  }
  /** `h` on file, the editor on to the next hand, the save slot showing it. */
  function commit(c: FastState, h: LoggedHand) {
    const ok = saveHand(h);
    setFull(!ok);
    // Not on file: the hand stays on screen to try again.
    if (!ok) return;
    // Only one 되돌리기 on screen: the one in the save slot, for the hand just saved.
    closeUndoOffer();
    set(afterSave(c, h, handLogStore.get().hands, mode));
    setSaved(savedOf(h, other));
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
    const base = editHand ?? { ...freshHand(mode), players: p };
    if (other) {
      const h = fastHand(c.draft, a, base, draftStage(c), p, mode);
      if (h) commit(c, h);
      return;
    }
    // 액션도 기록: the action saves the result and board typed so far; a fold or a walk with none typed is one.
    const d = c.draft.res || c.draft.amount ? c.draft : a === "fold" ? pickRes(c.draft, "fold") : a === undefined ? pickRes(c.draft, "walk") : c.draft;
    const at = Date.now();
    setTick(at);
    const { lv, ante } = levelNow(c, editHand, at);
    if (!asked && needsLevel(d, lv, editHand)) return askLevel(() => act(a, true), "블라인드라서 레벨을 골라 주세요");
    const made = fastHand(d, a, base, draftStage(c), p, mode);
    const h = made && withFastResult(made, d, lv, ante);
    if (h) commit(c, h);
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
    const base = editHand ?? { ...freshHand(mode), players: p };
    const kept = editHand ? keptAction(editHand, d) : null;
    const made = (kept !== null ? fastHand(d, kept, base, draftStage(c), p, mode) : null) ?? fastHand(d, null, base, draftStage(c), p, mode);
    const h = made && withFastResult(made, d, lv, ante);
    if (h) commit(c, h);
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
    else set(guessed ? without(c, "levelPick") : { ...c, levelPick: { level, at: Date.now() } });
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
  const lvNow: FastLevel & { picked?: boolean } = editing ? editLevel(d, editing) : fastLevel(s, session, tick);
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
        <div className="fast-today-head">
          <h2>{other ? "오늘 남의 핸드" : "오늘 빠른 기록"}</h2>
          <span className="muted small">{session.length}핸드</span>
        </div>
        {session.length ? (
          <>
            {!other &&
              (series ? (
                <>
                  <MoneyHead money={money} missed={missed} view={view} onView={(u) => set(u === "bb" ? { ...cur(), view: "bb" } : without(cur(), "view"))} />
                  <ChipGraph series={series} hands={oldestFirst(session)} />
                  {series.unit !== view && <p className="muted small fast-note">레벨이 없어서 칩으로 보여요</p>}
                </>
              ) : (
                <p className="muted small fast-note">결과를 넣으면 오늘 칩 흐름이 그래프로 보여요</p>
              ))}
            {stats.total ? (
            <div className="fast-stats">
              <span className="v-ok">
                차트대로 <b>{stats.okPct ?? 0}%</b> <small>({stats.by.ok}/{stats.graded})</small>
              </span>
              <span className="v-over">
                ⚠ {other ? "루즈" : "오버"} {stats.by.over}
              </span>
              <span className="v-under">
                ▽ {other ? "타이트" : "언더"} {stats.by.under}
              </span>
              <span className="v-mixed">△ 섞음 {stats.by.mixed}</span>
              {stats.by.none ? <span className="v-none">차트 없음 {stats.by.none}</span> : null}
            </div>
            ) : null}
            <div className="fast-list">
              {recent.map((h) => {
                const v = fastVerdictOf(h);
                const k = v?.kind ?? "none";
                // 빠른 기록's chips and board: the hand, its seat, the chips (in the unit shown), the board as remembered.
                if (!other && hasChips(h)) {
                  const net = h.net ?? 0;
                  return (
                    <button key={h.id} type="button" className={`fast-item res v-${k}${d.editing === h.id ? " editing" : ""}`} onClick={() => edit(h)}>
                      <span className="fi-time">{clock(h.createdAt)}</span>
                      <b className="fi-seat">{h.seat}</b>
                      <b className="fi-class">{holeClass(h)}</b>
                      <span className={`fi-net${h.result === "fold" ? " fold" : net > 0 ? " up" : net < 0 ? " down" : ""}`}>{netShown(h, view)}</span>
                      <MarksText className="fi-board" marks={marksOf(h.board, h.guess?.board)} />
                      {fastActed(h) && <span className="fi-verdict">{VERDICT_MARK[k]}</span>}
                    </button>
                  );
                }
                const said = fastActText(h);
                return (
                  <button key={h.id} type="button" className={`fast-item v-${k}${d.editing === h.id ? " editing" : ""}`} onClick={() => edit(h)}>
                    <span className="fi-time">{clock(h.createdAt)}</span>
                    <b className="fi-seat">{h.seat}</b>
                    <b className="fi-class">{holeClass(h)}</b>
                    <span className="fi-act">{said}</span>
                    <span className="fi-verdict">{k === "ok" || k === "mixed" ? VERDICT_MARK[k] : v && v.text !== said ? shortVerdict(v.text) : VERDICT_MARK.none}</span>
                  </button>
                );
              })}
            </div>
            <p className="muted small">
              핸드를 누르면 고치거나 지울 수 있어요{session.length > recent.length ? ` · 최근 ${recent.length}핸드만 보여요, 전부는 지난 기록에서` : ""}
            </p>
            <div className="fast-today-foot">
              <button
                type="button"
                className="ghost small"
                onClick={async () => setCopied((await copyText(sessionText(session, mode))) ? "복사했어요 · 카톡이나 Claude에 붙여 넣으세요" : "복사하지 못했어요")}
              >
                오늘 요약 복사
              </button>
              <button type="button" className="log-link" onClick={() => go(other ? "log/list/other" : "log/list/mine")}>
                지난 기록 ›
              </button>
            </div>
            {copied && <p className="fast-hint ok">{copied}</p>}
          </>
        ) : (
          <p className="muted small">
            {other
              ? "아직 오늘 남의 핸드가 없어요. 보인 핸드마다 상대 자리 → 랭크 두 개 → 수딧/오프 → 상황 → 상대 액션만 누르면 저장돼요. 펍 사람들이 실제로 어떻게 치는지 모여요."
              : "아직 오늘 기록이 없어요. 핸드마다 랭크 두 개 → 수딧/오프 → 폴드, 아니면 땄음·잃음과 금액만 누르면 돼요. 보드는 기억나는 카드만."}
          </p>
        )}
      </section>

    </div>
  );
}
