import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { RANKS, SUITS, SUIT_SYMBOL, type Card } from "../../poker/cards";
import { countOuts } from "../../poker/equity";
import { legal, pot, toCall, type Game, type Street } from "../../play/engine";
import { flowTabs, initialStep, type FlowStep } from "./flowSteps";
import { analyseHand, SUIT_GUESS_NOTE, type HandAnalysis, type StreetView } from "./handAnalysis";
import {
  estimatedLevel,
  guessedCards,
  holeClass,
  holeGuessed,
  isOther,
  knownBoard,
  knownHole,
  lastStage,
  levelEstimateAt,
  levelInfo,
  LOG_STREET_LABEL,
  myShowdown,
  RESULT_LABEL,
  seatName,
  seatTags,
  stackBb,
  stepsThatFit,
  subjectLabel,
  subjectWord,
  tableOf,
  tablePre,
  unfinished,
  withBoard,
  withHole,
  withLevel,
  type LoggedHand,
  type Result,
} from "./handLog";
import { CardText, ChipRow, ChipsInput, levelDeclined, LevelRow, TableCard } from "./inputs";
import { levelStage, OPEN_PRESETS, PRE_STAGES, preSteps, STAGE_LABEL, stageFor, type PreStage } from "./quickPre";
import { BoardRanks, FlopPairFix, HoleEntry } from "./SuitEntry";
import { describeGuess } from "./suitGuess";
import { BUBBLE_FORMS, cardVars, layoutTable, seatSpots, tableGeometry, type BubbleForm, type Size, type TableIn } from "./tableLayout";
import { amountLabel, applyStep, baseStack, buttonSeat, positionsFor, raiseVerb, sizeOptions, skipTo, streetLines, TABLE_SIZES, undoSteps, upcoming, type LogStep } from "./recorder";

/**
 * Recording a hand on a picture of the table: the hole cards first (exact, or ranks with the suits
 * guessed), then table size, seats, blinds and stacks, then every seat's action street by street
 * (unpressed seats fold, or check when nobody bet), and at the end a run-out with each player's
 * equity on every street. The same flow records another player's hand (the subject is then the hero).
 */

const NEED: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);

export interface TableFlowProps {
  h: LoggedHand;
  /** Every edit; `cardsClean` comes with an edit of the hole-card field (false while it is mid-way). */
  onChange: (h: LoggedHand, cardsClean?: boolean) => void;
  /** The hole-card field turned clean or not (a typo, a half-typed card, ranks waiting for 수딧/오프수트). */
  onCardsClean?: (ok: boolean) => void;
  /** Leaving the hand step: a card field left mid-way gives the hand back the cards on file. */
  onLeaveHand?: () => void;
  onReview: (h: LoggedHand, extra: string) => void;
  /** The step the hand opens on, instead of its first missing piece. */
  startAt?: FlowStep;
  /** At the right end of the hand step's first line (the past-hands link, a hand to pick up again). */
  aside?: ReactNode;
  /** The hand step's save line. */
  status?: ReactNode;
  /** 나중에 작성하기: keep the hand as it is and leave it for the past hands. Not offered without it. */
  onLater?: () => void;
  /** Leaving now loses nothing: everything on screen is on file. */
  laterReady?: boolean;
  /** ＋ 다음 핸드: offered instead of 나중에 작성하기 once the hand is complete (nothing left to finish later). */
  onNextHand?: () => void;
  /** Above the step tabs on every step but the hand step (whose first line has its own links). */
  top?: ReactNode;
  /** Under the table step while the hand isn't on file yet: what saves it. */
  unsaved?: ReactNode;
}

export function TableFlow(props: TableFlowProps) {
  const { h, onChange, onCardsClean, onLeaveHand, onReview, aside, status, onLater, laterReady, onNextHand, top, unsaved } = props;
  const [step, setStepRaw] = useState<FlowStep>(() => props.startAt ?? initialStep(h));
  /** Where the result replay starts: a finished hand's street tab opens it at that street. */
  const [replay, setReplay] = useState<ReplayFrom>({ street: "preflop", n: 0 });
  const set = (patch: Partial<LoggedHand>) => onChange({ ...h, ...patch });
  /**
   * A new level keeps the chips typed (withLevel). If the stacks it gives still leave recorded actions
   * that no longer fit (an all-in over a shorter stack…), say so before saving rather than letting the
   * next tap drop them.
   */
  const setLevel = (level: number | null, guessed: boolean) => {
    const next = withLevel(h, level, guessed);
    const lost = stepsThatFit(h) - stepsThatFit(next);
    if (lost > 0 && !confirm(`이 블라인드면 스택이 달라져서 기록한 액션 ${lost}개가 맞지 않아요. 그래도 바꿀까요?`)) return;
    onChange(next);
  };
  const setStep = (next: FlowStep) => {
    if (step === "hand" && next !== "hand") onLeaveHand?.();
    setStepRaw(next);
  };
  const toPlay = () => setStep("play");
  const openResult = (street: Street = "preflop") => {
    setReplay((r) => ({ street, n: r.n + 1 }));
    setStep("result");
  };
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const fmt = (bb: number) => amountLabel(bb, bbChips);

  // Light replay for recording (no grading); the result screen runs the full analysis.
  const live = useMemo(() => analyseHand(h, { iterations: 2000 }), [h]);
  const tabs = flowTabs(step, { seat: !!h.seat, cards: h.hole.length === 2, street: live.game.street, done: live.game.done });
  // A complete hand has nothing to finish later: the next hand is the way on.
  const complete = !unfinished(h) && (h.steps.length > 0 || h.result !== null);
  const later =
    complete && onNextHand ? (
      <button type="button" className="flow-later next" disabled={!laterReady} onClick={onNextHand}>
        ＋ 다음 핸드
      </button>
    ) : onLater ? (
      <button type="button" className="flow-later" disabled={!laterReady} onClick={onLater}>
        나중에 작성하기
      </button>
    ) : null;

  return (
    <div className="flow">
      {step !== "hand" && top}
      <nav className="flow-steps" aria-label="기록 단계">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={t.on ? "on" : t.passed ? "done" : ""}
            disabled={!t.enabled}
            aria-current={t.on ? "step" : undefined}
            onClick={() => (t.step === "result" ? openResult(t.street ?? "preflop") : t.step === "play" ? toPlay() : setStep(t.step))}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {step === "hand" && <HandStep h={h} onChange={onChange} onCardsClean={onCardsClean} aside={aside} status={status} later={later} onNext={() => setStep("setup")} />}
      {step === "setup" && <SetupStep h={h} set={set} setLevel={setLevel} fmt={fmt} later={later} unsaved={unsaved} onNext={() => (h.hole.length === 2 ? toPlay() : setStep("hand"))} />}
      {step === "play" && <PlayStep h={h} set={set} update={onChange} fmt={fmt} a={live} later={later} onResult={() => openResult()} />}
      {step === "result" && <ResultStep h={h} set={set} fmt={fmt} onReview={onReview} from={replay} later={later} />}
    </div>
  );
}

// ───────────── ① the hole cards ─────────────

function HandStep(props: { h: LoggedHand; onChange: (h: LoggedHand, cardsClean?: boolean) => void; onCardsClean?: (ok: boolean) => void; aside?: ReactNode; status?: ReactNode; later: ReactNode; onNext: () => void }) {
  const { h, onChange, onCardsClean, aside, status, later, onNext } = props;
  // Known cards only: typing the real cards over guessed ones moves the guess (handLog reguess).
  const taken = [...knownBoard(h), ...h.showdowns.flatMap((s) => s.cards)];
  const avoid = guessedCards(h).filter((c) => !h.hole.includes(c));
  const cls = holeClass(h);
  return (
    <div className="flow-body hand-first">
      <div className="flow-label">
        {subjectWord(h, "핸드")}
        {cls && <small className="hand-cls">{cls}</small>}
        {aside}
      </div>
      <HoleEntry key={h.id} h={h} taken={taken} avoid={avoid} onChange={(v, clean) => onChange(withHole(h, v.hole, v.guessed, v.holeKind), clean)} onValid={onCardsClean} />
      {status}
      <div className="flow-actions">
        <button type="button" className="flow-next" disabled={h.hole.length !== 2} onClick={onNext}>
          다음: 테이블 →
        </button>
        {later}
      </div>
    </div>
  );
}

// ───────────── ② table size, seats, blinds, stacks ─────────────

function SetupStep(props: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; setLevel: (level: number | null, guessed: boolean) => void; fmt: (bb: number) => string; later: ReactNode; unsaved?: ReactNode; onNext: () => void }) {
  const { h, set, setLevel, fmt, later, unsaved, onNext } = props;
  const other = isOther(h);
  const seats = positionsFor(h.players);
  const base = baseStack(tableOf(h));
  const bb = stackBb(h);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  /** What is open below the rows: the blinds editor, or one seat's stack (tapped on the table). */
  const [edit, setEdit] = useState<{ kind: "blind" } | { kind: "stack"; seat: string } | null>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const others = Object.keys(h.stacks).filter((s) => s !== h.seat && seats.includes(s));
  // No stack typed in: show the assumed 100bb, not a chip count nobody entered.
  const baseLabel = h.stack === null ? amountLabel(base, null) : fmt(base);
  const stackSeat = edit?.kind === "stack" && edit.seat !== h.seat ? edit.seat : null;
  const mySeats = seats.filter((s) => s !== h.seat);

  // An editor opened from a seat on the table may sit below the fold.
  useEffect(() => {
    if (edit) editRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [edit]);
  // Today's start time is set: a hand with no level takes the level the clock says for its time (not
  // when that would leave recorded actions that no longer fit: then the user picks it).
  useEffect(() => {
    if (h.level !== null || levelDeclined.has(h.id)) return;
    const lv = estimatedLevel(levelEstimateAt(h.createdAt));
    if (lv === null) return;
    const next = withLevel(h, lv, true);
    if (stepsThatFit(next) >= stepsThatFit(h)) set({ level: next.level, levelGuess: true, steps: next.steps, stacks: next.stacks });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickSeat = (s: string) => set({ seat: s, steps: h.seat === s ? h.steps : [] });
  const pickPlayers = (n: number) => {
    const next = positionsFor(n);
    // A new table size changes the seats: keep the subject's seat only if it still exists, and start the actions over.
    set({ players: n, seat: next.includes(h.seat) ? h.seat : "", steps: [], stacks: {} });
    setEdit(null);
  };
  const setSeatStack = (s: string, v: number | null) => {
    const stacks = { ...h.stacks };
    if (v && v > 0) stacks[s] = bbChips ? v / bbChips : v;
    else delete stacks[s];
    set({ stacks });
  };

  return (
    <div className="flow-body setup">
      <div className="flow-label">몇 인 테이블?</div>
      <ChipRow items={TABLE_SIZES} value={h.players} label={(n) => `${n}인`} onPick={pickPlayers} />
      <div className="flow-label">
        {subjectWord(h, "포지션")} <small>{h.seat || "테이블에서 자리를 눌러도 돼요"}</small>
      </div>
      <ChipRow items={seats} value={h.seat} onPick={pickSeat} className={`seats n${seats.length}`} />
      {other && (
        <>
          <div className="flow-label">
            내 자리 <small>{h.mySeat ? `${h.mySeat} · 같은 테이블` : "같은 테이블이었다면 (선택)"}</small>
          </div>
          <ChipRow items={mySeats} value={h.mySeat ?? null} onPick={(s) => set({ mySeat: h.mySeat === s ? undefined : s })} className={`seats n${mySeats.length}`} />
        </>
      )}
      <RaceTable
        seats={seats}
        hero={h.seat}
        meLabel={subjectLabel(h)}
        mine={h.mySeat}
        button={buttonSeat(h.players)}
        stacks={Object.fromEntries(seats.map((s) => [s, s !== h.seat && h.stacks[s] !== undefined ? fmt(h.stacks[s]) : baseLabel]))}
        marked={others}
        picked={stackSeat ?? undefined}
        // Until the subject's seat is chosen a tap picks it; after that a tap changes that seat's stack.
        onSeat={(s) => (!h.seat ? pickSeat(s) : s === h.seat ? setEdit(null) : setEdit(stackSeat === s ? null : { kind: "stack", seat: s }))}
        compact
      />
      <div className="flow-form">
        <LevelRow
          h={h}
          onLevel={setLevel}
          onAnte={(bbAnte) => set({ bbAnte, steps: [] })}
          open={edit?.kind === "blind"}
          onToggle={() => setEdit(edit?.kind === "blind" ? null : { kind: "blind" })}
          editRef={editRef}
          unknownLabel="레벨 모름"
        />
        <label className="flow-row-box flow-row-in">
          <span>{subjectWord(h, "스택")}</span>
          <ChipsInput value={h.stack} unit="chips" onChange={(stack) => set({ stack })} placeholder="칩 (예: 32,000)" ariaLabel={`${subjectWord(h, "스택")} (칩)`} />
          <small>{bb !== null ? `= ${bb}bb` : h.stack !== null ? "레벨 고르면 bb" : "비우면 100bb"}</small>
        </label>
        {stackSeat !== null && (
          <div className="flow-row-box open">
            <div className="flow-edit" ref={editRef}>
              <label className="flow-stack-in">
                <span>{stackSeat} 스택</span>
                <ChipsInput
                  value={h.stacks[stackSeat] !== undefined ? (bbChips ? Math.round(h.stacks[stackSeat] * bbChips) : h.stacks[stackSeat]) : null}
                  unit={bbChips ? "chips" : "bb"}
                  placeholder={`${other ? "상대와" : "나와"} 같게 ${baseLabel}`}
                  onChange={(v) => setSeatStack(stackSeat, v)}
                  autoFocus
                />
                {h.stacks[stackSeat] !== undefined && (
                  <button type="button" className="ghost small" onClick={() => setSeatStack(stackSeat, null)}>
                    같게
                  </button>
                )}
              </label>
              <div className="flow-edit-foot">
                <span>{others.length ? others.map((s) => `${s} ${fmt(h.stacks[s])}`).join(" · ") : "다른 자리는 테이블에서 그 자리를 누르세요"}</span>
                <button type="button" className="ghost small" onClick={() => setEdit(null)}>
                  완료
                </button>
              </div>
            </div>
          </div>
        )}
        {h.seat && stackSeat === null && (
          <div className="flow-tip">{others.length ? `따로 넣은 스택: ${others.map((s) => `${s} ${fmt(h.stacks[s])}`).join(" · ")}` : "다른 자리 스택이 다르면 테이블에서 그 자리를 누르세요"}</div>
        )}
      </div>
      {unsaved}
      <div className="flow-actions">
        <button type="button" className="flow-next" disabled={!h.seat} onClick={onNext}>
          {h.hole.length === 2 ? "다음: 프리플랍 →" : "다음: 핸드 →"}
        </button>
        {later}
      </div>
    </div>
  );
}

// ───────────── ③ recording ─────────────

/** The stage the first open's sizes follow: the opener's stack when stacks are known, else the level's usual stage, else the last one used. */
function openStage(h: LoggedHand, openerBb: number | null): PreStage {
  if (stackBb(h) !== null && openerBb !== null && openerBb > 0) return stageFor(openerBb);
  return levelStage(h.level) ?? lastStage() ?? "mid";
}

/** Index of the first card that differs between two boards (where an edit starts). */
const firstDiff = (a: Card[], b: Card[]) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

function PlayStep(props: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; update: (h: LoggedHand) => void; fmt: (bb: number) => string; a: HandAnalysis; later: ReactNode; onResult: () => void }) {
  const { h, set, update, fmt, a, later, onResult } = props;
  // Into the action: a preflop block jotted on the quick screen becomes the first steps, on the table as it now is.
  useEffect(() => {
    const pre = tablePre(h);
    if (!pre || h.steps.length || !h.seat || h.hole.length !== 2) return;
    const steps = preSteps(tableOf(h), pre);
    if (steps.length) update({ ...h, steps });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const g = a.game;
  const seats = positionsFor(h.players);
  const valid = h.steps.slice(0, a.applied);
  const push = (...steps: LogStep[]) => set({ steps: [...valid, ...steps] });
  const idx = g.done ? null : g.toAct;
  const actor = idx !== null ? g.players[idx] : null;
  const L = idx !== null ? legal(g, idx) : null;
  const next = actor ? upcoming(g) : [];
  const need = NEED[g.street];
  const boardMissing = !g.done && h.board.length < need;
  const potNow = pot(g);
  const call = idx !== null ? toCall(g, idx) : 0;
  const tags = seatTags(h);
  const lines = streetLines(g, fmt, tags);
  const current = lines.find((l) => l.street === g.street);
  const earlier = lines.filter((l) => l.street !== g.street || g.done);
  const [custom, setCustom] = useState("");
  const [fixBoard, setFixBoard] = useState(false);
  /** The board goes in by ranks ("무늬 모름"); kept from street to street. */
  const [suitless, setSuitless] = useState(false);
  /** A stage tapped for the first open's sizes (otherwise it follows the stacks, the level, the last one used). */
  const [stagePick, setStagePick] = useState<PreStage | null>(null);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const verb = raiseVerb(g);
  const firstOpen = g.street === "preflop" && verb === "오픈";
  const stage = stagePick ?? openStage(h, actor ? actor.stack + actor.streetBet : null);
  /** The first open: the stage's usual sizes (an all-in has its own button); later raises: the usual multiples. */
  const sizes = firstOpen && L ? OPEN_PRESETS[stage].flatMap((x) => (typeof x === "number" && x >= L.minRaiseTo - 1e-9 && x < L.maxRaiseTo - 1e-9 ? [{ label: `${x}bb`, to: x }] : [])) : sizeOptions(g);
  const sdCards = h.showdowns.flatMap((s) => s.cards);
  /** The cards an exact board field can't take: known ones only (a guessed card gives way to the real one). */
  const knownTaken = [...knownHole(h), ...sdCards];
  const from = need === 3 ? 0 : need - 1;
  const guessText = describeGuess(h.guess);

  // Bubbles: each seat's latest action this street, numbered like the order chips below the table.
  const bubbles: Record<string, Bubble> = {};
  {
    let n = 0, raised = false;
    const invested = new Set<number>();
    for (const e of g.log) {
      if (e.kind === "call" || e.kind === "bet" || e.kind === "raise") invested.add(e.idx);
      if (e.street !== g.street || e.kind === "post") continue;
      if (e.kind === "fold") {
        // Numbered like the order chips: streetLines lists these folds (tagged seats too, e.g. my seat in another player's hand).
        if (invested.has(e.idx) || g.players[e.idx].hero || tags.seats?.[e.seat]) n++;
        continue;
      }
      n++;
      const limp = g.street === "preflop" && e.kind === "call" && !raised;
      if (e.kind === "raise" || e.kind === "bet") raised = true;
      const cls = e.allIn ? "allin" : e.kind === "check" ? "check" : limp ? "limp" : e.kind === "call" ? "call" : "raise";
      const verb = e.kind === "check" ? "체크" : limp ? "림프" : e.kind === "call" ? "콜" : e.kind === "bet" ? "벳" : "레이즈";
      bubbles[e.seat] = { cls, verb, amount: e.kind === "check" ? "" : fmt(e.amount), num: n };
    }
  }
  const folded = g.players.filter((p) => p.folded).map((p) => p.seat);

  /** A bet or raise to `to` bb; `all` marks an all-in, so it follows the seat's real stack if the level or stacks change. */
  function raiseTo(to: number, all = false) {
    if (!actor) return;
    push({ s: actor.seat, k: "raise", to, ...(all || to >= (L?.maxRaiseTo ?? Infinity) - 1e-9 ? { all: 1 as const } : {}) });
    setCustom("");
  }
  /** Fold (or check) the other seats until my turn or the end of the street; never acts for me. */
  function restDefault() {
    const steps: LogStep[] = [];
    let cur: Game | null = g;
    while (cur && !cur.done && cur.toAct !== null && cur.street === g.street && cur.players[cur.toAct].seat !== h.seat) {
      const st: LogStep = { s: cur.players[cur.toAct].seat, k: legal(cur, cur.toAct).canCheck ? "check" : "fold", a: 1 };
      cur = applyStep(cur, st);
      if (cur) steps.push(st);
    }
    if (steps.length) push(...steps);
  }

  return (
    <div className="flow-body">
      <div className="flow-calc">
        <div>
          <span>팟</span>
          <b>{fmt(potNow)}</b>
          {bbChips ? <small>{Math.round(potNow * 10) / 10}bb</small> : null}
        </div>
        <div>
          <span>콜하려면</span>
          <b>{call > 0 ? fmt(call) : "-"}</b>
          {bbChips && call > 0 ? <small>{Math.round(call * 10) / 10}bb</small> : null}
        </div>
        <div>
          <span>필요 에퀴티</span>
          <b>{call > 0 ? pct(call / (potNow + call)) : "-"}</b>
        </div>
        <div className={a.current?.equity != null ? "eq" : ""}>
          <span>{subjectWord(h, "에퀴티")}</span>
          <b>{a.current ? pct(a.current.equity) : "-"}</b>
        </div>
      </div>
      {earlier.length > 0 && (
        <div className="flow-lines">
          {earlier.map((l) => (
            <div key={l.street}>
              <b>{LOG_STREET_LABEL[l.street as keyof typeof LOG_STREET_LABEL]}</b> {l.actions.join(" · ") || "-"} <em>팟 {fmt(l.pot)}</em>
            </div>
          ))}
        </div>
      )}
      {a.applied < h.steps.length && (
        <div className="notice error">
          <span>자리·스택이 바뀌어서 뒤쪽 액션 {h.steps.length - a.applied}개가 맞지 않아요.</span>
          <button type="button" className="ghost small" onClick={() => set({ steps: valid })}>
            지우기
          </button>
        </div>
      )}
      <RaceTable
        seats={seats}
        hero={h.seat}
        meLabel={subjectLabel(h)}
        mine={h.mySeat}
        button={buttonSeat(h.players)}
        stacks={Object.fromEntries(g.players.map((p) => [p.seat, fmt(p.stack)]))}
        bubbles={bubbles}
        turn={actor?.seat}
        out={folded}
        board={boardSlots(h.board, g.done ? 5 : need)}
        pot={`팟 ${fmt(potNow)}`}
        heroCards={h.hole}
        heroGuessed={holeGuessed(h)}
        boardGuessed={h.guess?.board}
        onSeat={(s) => actor && s !== actor.seat && next.includes(s) && push(...skipTo(g, s))}
      />
      {guessText && (
        <div className="flow-guess">
          <span>{guessText}</span>
          <FlopPairFix board={h.board} guessed={h.guess?.board ?? []} taken={[...h.hole, ...sdCards]} onFix={(flop) => update(withBoard(h, flop, 0, true))} />
        </div>
      )}
      {current && current.actions.length > 0 && (
        <div className="flow-order">
          {current.actions.map((t, i) => (
            <span key={i}>
              <i>{i + 1}</i>
              {t}
            </span>
          ))}
          {actor && <span className="now">{seatName(h, actor.seat)} 차례</span>}
        </div>
      )}
      {boardMissing &&
        // Only this street's new card(s): typing the turn card never touches the flop.
        (suitless ? (
          <BoardRanks
            key={g.street}
            street={g.street as "flop" | "turn" | "river"}
            board={h.board.slice(0, from)}
            taken={[...h.hole, ...sdCards]}
            onFill={(cards) => update(withBoard(h, [...h.board.slice(0, from), ...cards], from, true))}
          />
        ) : (
          <CardText
            key={g.street}
            label={`${LOG_STREET_LABEL[g.street as keyof typeof LOG_STREET_LABEL]} 카드`}
            cards={h.board.slice(from, need)}
            max={need === 3 ? 3 : 1}
            taken={[...knownTaken, ...knownBoard(h, 0, from)]}
            onChange={(cards) => update(withBoard(h, [...h.board.slice(0, from), ...cards], from))}
            placeholder={g.street === "flop" ? "예) Kd9d2s" : g.street === "turn" ? "턴 한 장 예) 6c" : "리버 한 장 예) Qd"}
            autoFocus
            compact
          />
        ))}
      {boardMissing && (
        <button type="button" className="suit-toggle" onClick={() => setSuitless(!suitless)}>
          {suitless ? (
            "무늬 알면 직접 입력"
          ) : (
            <>
              무늬 모름 <small>숫자만 기억나요</small>
            </>
          )}
        </button>
      )}
      {!boardMissing && h.board.length > 0 && (
        <button type="button" className="ghost small" onClick={() => setFixBoard(!fixBoard)}>
          보드 고치기
        </button>
      )}
      {fixBoard && !boardMissing && (
        <CardText label="보드 전체" cards={h.board} max={5} taken={knownTaken} onChange={(cards) => update(withBoard(h, cards, firstDiff(h.board, cards)))} compact />
      )}
      {g.done ? (
        <div className="flow-pad">
          <div className="flow-who">
            <b>핸드 끝</b>
            <span>{g.showdown ? "쇼다운까지 갔어요" : "한 명만 남았어요"}</span>
          </div>
          <button type="button" className="primary wide" onClick={onResult}>
            결과 보기 →
          </button>
          <button type="button" className="ghost wide" disabled={!h.steps.length} onClick={() => set({ steps: undoSteps(valid) })}>
            ↶ 되돌리기
          </button>
        </div>
      ) : actor && L ? (
        <div className="flow-pad">
          <div className="flow-who">
            <b>{seatName(h, actor.seat)} 차례</b>
            <span>
              {call > 0 ? `콜 ${fmt(Math.min(g.currentBet, actor.streetBet + actor.stack))}` : "벳 없음"} · 남은 스택 {fmt(actor.stack)}
            </span>
          </div>
          <div className="flow-btns">
            {!L.canCheck && (
              <button type="button" className="fold" onClick={() => push({ s: actor.seat, k: "fold" })}>
                폴드
              </button>
            )}
            {L.canCheck ? (
              <button type="button" className="check" onClick={() => push({ s: actor.seat, k: "check" })}>
                체크
              </button>
            ) : (
              <button type="button" className="call" onClick={() => push({ s: actor.seat, k: "call" })}>
                콜 {fmt(Math.min(g.currentBet, actor.streetBet + actor.stack))}
                <small>{call >= actor.stack ? "올인" : `+${fmt(call)}`}</small>
              </button>
            )}
            {L.canRaise && (
              <button type="button" className="allin" onClick={() => raiseTo(L.maxRaiseTo, true)}>
                올인
                <small>{fmt(L.maxRaiseTo)}</small>
              </button>
            )}
          </div>
          {L.canRaise && (
            <>
              <div className="flow-amount">
                <input
                  inputMode={bbChips ? "numeric" : "decimal"}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={`${verb} 금액 (${bbChips ? "칩" : "bb"}, 총액)`}
                />
                <button
                  type="button"
                  className="raise"
                  disabled={!(Number(custom) > 0)}
                  onClick={() => raiseTo(bbChips ? Number(custom) / bbChips : Number(custom))}
                >
                  {verb}
                  {Number(custom) > 0 && bbChips ? <small>{Math.round((Number(custom) / bbChips) * 10) / 10}bb</small> : null}
                </button>
              </div>
              <div className="flow-quick">
                {firstOpen && (
                  <button type="button" className="stage" onClick={() => setStagePick(PRE_STAGES[(PRE_STAGES.indexOf(stage) + 1) % PRE_STAGES.length])} aria-label={`스택 구간 ${STAGE_LABEL[stage]} · 눌러서 바꾸기`}>
                    {STAGE_LABEL[stage]}
                    <small>구간</small>
                  </button>
                )}
                {[...sizes, potSized(g)].filter(uniqueTo).map((o) => (
                  <button key={o.to} type="button" onClick={() => raiseTo(o.to)}>
                    {o.label || `${verb}`}
                    <small>{firstOpen && o.label !== "팟" && !bbChips ? verb : fmt(o.to)}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flow-row2">
            <button type="button" disabled={!h.steps.length} onClick={() => set({ steps: undoSteps(valid) })}>
              ↶ 되돌리기
            </button>
            <button type="button" disabled={actor.seat === h.seat} onClick={restDefault}>
              {L.canCheck ? "나머지 체크" : "나머지 폴드"}
              <small>{isOther(h) ? "상대 차례까지" : "내 차례까지"}</small>
            </button>
          </div>
          <div className="flow-tip">자리를 누르면 그 자리로 넘어가요. 그 사이 자리는 {L.canCheck ? "체크" : "폴드"}로 채워져요.</div>
        </div>
      ) : null}
      {later}
    </div>
  );
}

/** Board for a street: its cards, empty slots for ones not entered yet, nothing for later streets. */
/** Postflop grading line: my option's EV next to the best one (bot-response model, this street only). */
function evLine(d: { options: { key: string; label: string; ev: number | null }[]; chosen: string }, chipsIn: (s: string) => string, chosenWord: string): string {
  const evs = d.options.filter((o) => o.ev !== null) as { key: string; label: string; ev: number }[];
  if (!evs.length) return "";
  const best = evs.reduce((x, y) => (y.ev > x.ev ? y : x));
  const mine = evs.find((o) => o.key === d.chosen);
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 10) / 10}bb`;
  const same = mine && mine.key === best.key;
  return `EV(이번 스트리트, 펍아재 봇 반응 가정): ${mine ? `${chosenWord} ${sign(mine.ev)}` : ""}${same ? " · 가장 높음" : ` · 최고 ${chipsIn(best.label)} ${sign(best.ev)}`}`;
}

function boardSlots(board: Card[], n: number): (Card | null | undefined)[] {
  return Array.from({ length: 5 }, (_, i) => (i < n ? (board[i] ?? null) : undefined));
}

/** A pot-sized raise: call, then raise by the pot after the call. */
function potSized(g: Game): { label: string; to: number } {
  const idx = g.toAct!;
  const L = legal(g, idx);
  const call = toCall(g, idx);
  const to = Math.round((g.currentBet + pot(g) + call) * 2) / 2;
  return { label: "팟", to: Math.min(Math.max(to, L.minRaiseTo), L.maxRaiseTo) };
}
function uniqueTo(o: { to: number }, i: number, all: { to: number }[]) {
  return all.findIndex((x) => x.to === o.to) === i;
}

// ───────────── ④ result: the run-out ─────────────

/** The street the result replay opens on; `n` changes on every request, even for the same street. */
type ReplayFrom = { street: Street; n: number };

function ResultStep(props: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; fmt: (bb: number) => string; onReview: (h: LoggedHand, extra: string) => void; from: ReplayFrom; later: ReactNode }) {
  const { h, set, fmt, onReview, from, later } = props;
  const [a, setA] = useState<HandAnalysis | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const jumped = useRef(-1);
  const seats = positionsFor(h.players);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const approx = !!a && a.suitGuess !== null && a.game.showdown;
  const autoFilled = useRef(false);

  // Grading every decision takes a moment: paint first, then compute.
  useEffect(() => {
    setA(null);
    const t = setTimeout(() => setA(analyseHand(h, { decisions: true, iterations: 3000 })), 30);
    return () => clearTimeout(t);
  }, [h]);
  useEffect(() => {
    if (!a || a.heroNet === null) return;
    const bbc = levelInfo(h.level)?.bb ?? null;
    const net = bbc ? Math.round(a.heroNet * bbc) : a.heroNet;
    const result: Result = a.heroNet > 0 ? "win" : a.heroNet < 0 ? "lose" : "chop";
    // A showdown settled with guessed suits is only approximate (the guess steers clear of flushes):
    // the result the user picks stands; an empty one is filled in, and no net is stored.
    if (approx) {
      // Filled once: a result the user clears again stays cleared.
      const fill = !autoFilled.current && h.result === null;
      autoFilled.current = true;
      if (fill || h.net !== null) set({ result: fill ? result : h.result, net: null });
      return;
    }
    if (h.net !== net || h.result !== result) set({ net, result });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a]);
  // Open on the street asked for (a street tab above), once the analysis is in.
  useEffect(() => {
    if (!a || jumped.current === from.n) return;
    jumped.current = from.n;
    setAt(Math.max(0, a.streets.findIndex((x) => x.street === from.street)));
    setPlaying(false);
  }, [a, from]);
  useEffect(() => {
    if (!playing || !a) return;
    if (at >= a.streets.length - 1) return setPlaying(false);
    const t = setTimeout(() => setAt((x) => x + 1), 1300);
    return () => clearTimeout(t);
  }, [playing, at, a]);

  if (!a) return <div className="flow-body"><div className="flow-wait">승률 계산 중…</div></div>;
  const other = isOther(h);
  const views = a.streets;
  const v = views[Math.min(at, views.length - 1)];
  const heroEq = (x: StreetView) => x.known.find((k) => k.seat === h.seat)?.equity ?? null;
  const leadOf = (x: StreetView) => (heroEq(x) === null ? null : heroEq(x)! >= Math.max(...x.known.map((k) => k.equity)) - 1e-9);
  const prev = at > 0 ? views[at - 1] : null;
  const flipped = prev && leadOf(prev) !== null && leadOf(v) !== null && leadOf(prev) !== leadOf(v);
  const decisions = a.decisions.filter((d) => d.street === v.street);
  const chipLines = new Map(streetLines(a.game, fmt, seatTags(h)).map((l) => [l.street, l.actions]));
  /** Option labels from the grader are in bb: show their amounts in chips (percentages stay). */
  const chipsIn = (label: string) =>
    label.replace(/(\d+(?:\.\d+)?)(?![\d%.])/g, (m) => (bbChips ? (Math.round((Number(m) * bbChips) / 100) * 100).toLocaleString() : fmt(Number(m))));
  const sdSeats = a.showdownSeats;
  const known = new Map(h.showdowns.filter((s) => s.seat).map((s) => [s.seat, s]));
  const net = a.heroNet;
  /** The chip result rests on guessed suits at a showdown: shown as approximate, with the result chips to set the real one. */
  const netApprox = net !== null && approx;

  // Hands on the table at this street: me, the cards I saw, and face-down for live players I didn't see.
  const hands: Record<string, HandShow> = {};
  for (const seat of v.street === "preflop" ? v.endLive : v.live) {
    const k = v.known.find((x) => x.seat === seat);
    const isHero = seat === h.seat;
    const cards = isHero ? h.hole : known.get(seat)?.cards ?? [];
    const label = seatName(h, seat);
    const last = at === views.length - 1;
    if (k) {
      const best = Math.max(...v.known.map((x) => x.equity));
      const cls = last && v.board?.length === 5 ? (k.equity >= best - 1e-9 ? "win" : "lose") : k.equity >= best - 1e-9 ? "lead" : "behind";
      const text = last && v.board?.length === 5 ? (k.equity >= 0.999 ? "승" : k.equity > 0.001 ? `찹 ${pct(k.equity)}` : "패") : pct(k.equity);
      hands[seat] = { cards, label, badge: text, cls, guess: isHero && holeGuessed(h) };
    } else if (cards.length === 2) {
      hands[seat] = { cards, label, badge: v.estimate !== null && isHero ? `추정 ${pct(v.estimate)}` : "-", cls: "unknown", guess: isHero && holeGuessed(h) };
    } else if (!isHero) {
      hands[seat] = { cards: [], label, badge: "?", cls: "unknown" };
    }
  }

  // Outs when I'm behind one known hand on the flop or turn.
  const villainsKnown = v.known.filter((k) => k.seat !== h.seat);
  const outs =
    (v.street === "flop" || v.street === "turn") && v.board && villainsKnown.length === 1 && leadOf(v) === false && h.hole.length === 2
      ? countOuts(h.hole, villainsKnown[0].cards, v.board)
      : null;

  const setShowdown = (seat: string, patch: Partial<{ cards: Card[]; name: string }>) => {
    const rest = h.showdowns.filter((s) => s.seat !== seat);
    const cur = h.showdowns.find((s) => s.seat === seat) ?? { name: "", seat, cards: [], did: "" };
    const tags = seatTags(h);
    const who = `${seat}${tags.seats?.[seat] ?? ""} `;
    const did = streetLines(a.game, fmt, tags)
      .flatMap((l) => l.actions.filter((x) => x.startsWith(who)).map((x) => `${LOG_STREET_LABEL[l.street as keyof typeof LOG_STREET_LABEL]} ${x.slice(who.length)}`))
      .join(", ");
    set({ showdowns: [...rest, { ...cur, ...patch, did: cur.did || did }] });
  };

  const summary = () => {
    const eqLine = views.map((x) => `${LOG_STREET_LABEL[x.street as keyof typeof LOG_STREET_LABEL]} ${heroEq(x) !== null ? pct(heroEq(x)) : `추정 ${pct(x.estimate)}`}`).join(" → ");
    const dec = a.decisions.map((d) => {
      const grade = { good: "좋은 선택", ok: "괜찮음", mistake: "실수", info: "참고" }[d.decision.grade];
      return `- ${LOG_STREET_LABEL[d.street as keyof typeof LOG_STREET_LABEL]} ${d.decision.chosenLabel}: 필요 ${pct(d.decision.reqEquity)} · 그때 추정 ${pct(d.decision.equity)} · 실제 ${pct(d.actual)} [${grade}] ${d.decision.summary}${d.decision.chart ? ` (차트: ${d.decision.chart})` : ""}`;
    });
    return [
      "",
      `스트리트별 ${subjectWord(h, "승률")} (공개된 패 기준, 없으면 추정 레인지 기준${a.suitGuess ? ", 무늬 추정 카드가 있어 플러시 관련은 근사" : ""}):`,
      eqLine,
      "",
      `${subjectWord(h, "결정")} 채점 (금액은 bb, 상대 레인지는 액션으로 좁힌 추정):`,
      ...dec,
    ].join("\n");
  };

  return (
    <div className="flow-body">
      {sdSeats.length > 0 && (
        <div className="flow-sd">
          {sdSeats.map((seat) => (
            <div key={seat} className="flow-sd-row">
              <b>{seatName(h, seat)}</b>
              <CardText
                cards={known.get(seat)?.cards ?? []}
                max={2}
                taken={[...knownHole(h), ...knownBoard(h), ...h.showdowns.filter((s) => s.seat !== seat).flatMap((s) => s.cards)]}
                onChange={(cards) => setShowdown(seat, { cards })}
                placeholder={`${seat} 핸드 예) KcQc`}
                compact
                inline
              />
              {myShowdown(h, { seat }) ? (
                <span className="flow-nick mine">내 핸드</span>
              ) : (
                <input className="flow-nick" list="log-villain-names" value={known.get(seat)?.name ?? ""} onChange={(e) => setShowdown(seat, { name: e.target.value })} placeholder="별명" />
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flow-streetbar">
        {views.map((x, i) => (
          <button key={x.street} type="button" className={i === at ? "on" : ""} onClick={() => (setAt(i), setPlaying(false))}>
            {LOG_STREET_LABEL[x.street as keyof typeof LOG_STREET_LABEL]}
            <b>{heroEq(x) !== null ? (i === views.length - 1 && x.board?.length === 5 ? (heroEq(x)! >= 0.999 ? "승" : heroEq(x)! > 0.001 ? "찹" : "패") : pct(heroEq(x))) : x.estimate !== null ? `~${pct(x.estimate)}` : "-"}</b>
          </button>
        ))}
      </div>
      <div className="flow-controls">
        <button type="button" disabled={at === 0} onClick={() => setAt(at - 1)}>
          ◀
        </button>
        <button type="button" className="play" onClick={() => (at >= views.length - 1 ? (setAt(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? "❚❚ 멈춤" : at >= views.length - 1 ? "↺ 처음부터" : "▶ 자동 재생"}
        </button>
        <button type="button" disabled={at >= views.length - 1} onClick={() => setAt(at + 1)}>
          ▶
        </button>
      </div>
      <RaceTable
        seats={seats}
        hero={h.seat}
        meLabel={subjectLabel(h)}
        mine={h.mySeat}
        button={buttonSeat(h.players)}
        stacks={{}}
        out={seats.filter((s) => !v.live.includes(s))}
        board={boardSlots(h.board, NEED[v.street])}
        boardGuessed={h.guess?.board}
        hot={flipped ? NEED[v.street] - 1 : -1}
        pot={`팟 ${fmt(v.potEnd)}`}
        hands={hands}
      />
      <div className="flow-lines">
        <div>
          <b>{LOG_STREET_LABEL[v.street as keyof typeof LOG_STREET_LABEL]}</b> {(chipLines.get(v.street) ?? []).join(" · ") || "액션 없음 (올인 후 런아웃)"} <em>팟 {fmt(v.potEnd)}</em>
        </div>
      </div>
      {decisions.map((d, i) => (
        <div key={i} className={`flow-decision ${d.decision.grade}`}>
          <div className="mark">{{ good: "✓", ok: "△", mistake: "✗", info: "·" }[d.decision.grade]}</div>
          <div>
            <b>
              {d.verb}
              {d.amount !== null ? ` ${fmt(d.amount)}` : ""}
            </b>{" "}
            <span>
              {d.decision.reqEquity !== null ? `필요 ${pct(d.decision.reqEquity)} · ` : ""}
              {d.actual !== null ? `실제 ${pct(d.actual)}${d.actualComplete ? "" : "(본 패만)"} · ` : ""}그때 추정 {pct(d.decision.equity)}
            </span>
            <br />
            <em>{d.decision.chart ?? evLine(d.decision, chipsIn, subjectWord(h, "선택"))}</em>
          </div>
        </div>
      ))}
      {outs && outs.outs.length > 0 && (
        <div className="flow-outs">
          아웃 <b>{outs.outs.length}장</b>
          <span className="mini">
            {outs.outs.map((c) => (
              <span key={c} className={`rt-card tiny s-${SUITS[c & 3]}`}>
                {RANKS[c >> 2]}
                <small>{SUIT_SYMBOL[SUITS[c & 3]]}</small>
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="flow-result">
        {net !== null && !netApprox ? (
          <div className={`net ${net > 0 ? "win" : net < 0 ? "lose" : ""}`}>
            {net > 0 ? "+" : ""}
            {fmt(net)}
            <small>
              {other ? "상대 기준 · " : ""}
              {bbChips ? `${net > 0 ? "+" : ""}${net}bb · ` : ""}
              {a.game.showdown ? "쇼다운" : other ? "나머지 폴드" : "상대 폴드"}
            </small>
          </div>
        ) : (
          <div className="net unknown">
            {other ? "상대 결과" : "결과"}
            <small>
              {netApprox
                ? `≈ ${net! > 0 ? "+" : ""}${fmt(net!)} (근사) · 실제 결과를 고르세요`
                : other
                  ? "보인 카드를 넣으면 자동 계산"
                  : "상대 핸드를 넣으면 자동 계산"}
            </small>
            <span className="flow-result-chips" role="group" aria-label={other ? "상대 결과" : "결과"}>
              {(Object.keys(RESULT_LABEL) as Result[]).map((r) => (
                <button key={r} type="button" className={h.result === r ? "on" : ""} onClick={() => set({ result: h.result === r ? null : r })}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
            </span>
          </div>
        )}
        <button
          type="button"
          className="go"
          onClick={() => onReview(net !== null && !netApprox ? { ...h, net: bbChips ? Math.round(net * bbChips) : net, result: net > 0 ? "win" : net < 0 ? "lose" : "chop" } : h, summary())}
        >
          AI 리뷰
        </button>
      </div>
      {a.suitGuess && <div className="flow-approx">{SUIT_GUESS_NOTE}</div>}
      {later}
    </div>
  );
}

// ───────────── the table ─────────────

interface Bubble {
  cls: string;
  verb: string;
  amount: string;
  num: number;
}

interface HandShow {
  cards: Card[];
  label: string;
  badge: string;
  cls: string;
  /** The cards' suits were guessed. */
  guess?: boolean;
}

/** A seat's bet this street: its order number, the action, and the amount (one line, or the amount alone, when crowded). */
function BetBubble({ b, form, style, m }: { b: Bubble; form: BubbleForm; style?: CSSProperties; m?: string }) {
  return (
    <div className={`rt-bub ${b.cls} ${form} ${b.amount ? "" : "bare"}`} style={style} data-m={m}>
      <em>{b.num}</em>
      <span>{b.verb}</span>
      {b.amount && <b>{b.amount}</b>}
    </div>
  );
}

/** What RaceTable measured on screen: the table's width and the px size of each label, bubble and tag. */
interface Measured {
  width: number;
  sizes: Record<string, Size>;
}

function remeasure(el: HTMLElement, prev: Measured): Measured {
  const width = el.getBoundingClientRect().width;
  const sizes: Record<string, Size> = {};
  el.querySelectorAll<HTMLElement>("[data-m]").forEach((n) => {
    const r = n.getBoundingClientRect();
    sizes[n.dataset.m!] = [r.width, r.height];
  });
  const keys = Object.keys(sizes);
  const same =
    Math.abs(width - prev.width) < 0.5 &&
    keys.length === Object.keys(prev.sizes).length &&
    keys.every((k) => prev.sizes[k] && Math.abs(prev.sizes[k][0] - sizes[k][0]) < 0.5 && Math.abs(prev.sizes[k][1] - sizes[k][1]) < 0.5);
  return same ? prev : { width, sizes };
}

/** Sizes to lay out with before anything is measured (server render, first pass). */
const GUESS: Record<string, Size> = { label: [62, 33], bubble: [50, 28], pot: [80, 23], tag: [30, 15], me: [22, 13], hot: [28, 10] };

/**
 * Racetrack table: seats spaced evenly along the rail, me at the bottom, then clockwise in action order.
 * Seats scale with the table; the hands, bubbles, D button, my cards and the board's card size are
 * placed in px of its measured width (tableLayout.ts), so nothing lands on the board or on each other.
 */
function RaceTable(props: {
  seats: string[];
  hero: string;
  button: string;
  stacks: Record<string, string>;
  bubbles?: Record<string, Bubble>;
  turn?: string;
  out?: string[];
  board?: (Card | null | undefined)[];
  hot?: number;
  pot?: string;
  hands?: Record<string, HandShow>;
  heroCards?: Card[];
  onSeat?: (seat: string) => void;
  /** Seats whose stack differs from mine. */
  marked?: string[];
  /** The seat being edited. */
  picked?: string;
  compact?: boolean;
  /** The tag under the hero's seat: "나", or "상대" in another player's hand (subjectLabel). */
  meLabel?: string;
  /** The hero's cards were guessed from their ranks. */
  heroGuessed?: boolean;
  /** My own seat in another player's hand: tagged "나" under it, like the hero's tag. */
  mine?: string;
  /** Board indexes whose suits were guessed. */
  boardGuessed?: number[];
}) {
  const { seats, hero, button, stacks, bubbles = {}, turn, out = [], board, hot = -1, pot: potText, hands = {}, heroCards, onSeat, marked = [], picked, compact, meLabel = "나", heroGuessed, boardGuessed = [], mine } = props;
  const mySeat = mine && mine !== hero ? mine : null;
  const { W, H, RW, RH, cy, left, top, r } = tableGeometry(!!compact);
  const heroIdx = Math.max(0, seats.indexOf(hero || seats[seats.length - 1]));
  const order = [...seats.slice(heroIdx), ...seats.slice(0, heroIdx)];
  const spots = seatSpots(order.length, !!compact);
  const X = (x: number) => `${(x / W) * 100}%`;
  const Y = (y: number) => `${(y / H) * 100}%`;

  // Measure after every render (labels change from street to street) and whenever the table resizes.
  const ref = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<Measured>({ width: 0, sizes: {} });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setM((prev) => remeasure(el, prev));
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setM((prev) => remeasure(el, prev)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const size = (key: string, guess: Size): Size => m.sizes[key] ?? guess;

  const showHero = !!heroCards && heroCards.length === 2 && order[0] === hero && !hands[hero];
  const dealerSlot = order.indexOf(button);
  // the card that flipped the lead, as a slot on the board row (slots not drawn yet don't count)
  const hotSlot = board && hot >= 0 && board[hot] != null ? board.slice(0, hot).filter((c) => c !== undefined).length : -1;
  const input: TableIn = {
    compact: !!compact,
    width: m.width,
    seats: order.map((seat, k) => ({
      ...(hands[seat] ? { hand: { label: size(`l${k}`, GUESS.label), hero: seat === hero } } : {}),
      ...(bubbles[seat] && !hands[seat] ? { bubble: BUBBLE_FORMS.map((f) => size(`b${k}${f}`, GUESS.bubble)) } : {}),
      ...(turn === seat && !hands[seat] ? { tag: size("tag", GUESS.tag) } : {}),
      ...(seat === hero && !hands[seat] ? { me: size("me", GUESS.me) } : seat === mySeat && !hands[seat] ? { me: size("mine", GUESS.me) } : {}),
    })),
    dealer: dealerSlot >= 0 && !hands[button] ? dealerSlot : null,
    heroCards: showHero,
    pot: potText ? size("pot", GUESS.pot) : null,
    board: board ? board.filter((c) => c !== undefined).length : null,
    hot: hotSlot >= 0 ? { slot: hotSlot, tag: size("hot", GUESS.hot) } : null,
  };
  const key = JSON.stringify(input);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lay = useMemo(() => layoutTable(input), [key]);
  const PX = (x: number) => `${(x / lay.width) * 100}%`;
  const PY = (y: number) => `${(y / lay.height) * 100}%`;
  const css = (vars: Record<string, string>) => vars as CSSProperties;

  return (
    <div ref={ref} className={`rt-table ${compact ? "compact" : ""}`} style={{ aspectRatio: `${W} / ${H}` }}>
      <div className="rt-rail" style={{ left: X(left), top: Y(top), width: X(RW), height: Y(RH), borderRadius: `${r}px / ${r}px` }} />
      <div className="rt-felt" style={{ left: X(left + 14), top: Y(top + 14), width: X(RW - 28), height: Y(RH - 28), borderRadius: `${r - 14}px` }} />
      <div className="rt-betline" style={{ left: X(left + 48), top: Y(top + 48), width: X(RW - 96), height: Y(RH - 96), borderRadius: `${r - 48}px` }} />
      <div className="rt-logo" style={{ top: Y(cy + RH / 2 - 112) }}>
        PubAJ
      </div>
      {order.map((seat, k) => {
        const { x, y } = spots[k];
        const isHero = seat === hero;
        const hand = hands[seat];
        const hp = lay.hands[k];
        const b = bubbles[seat];
        const bp = lay.bubbles[k];
        const clickable = !!onSeat;
        return (
          <div key={seat}>
            {hand && hp ? (
              <div className={`rt-hand ${hand.cls}`} style={{ left: PX(hp.x), top: PY(hp.y), ...css(cardVars(hp, "hand")) }}>
                <div className="cards">{hand.cards.length ? hand.cards.map((c) => <TableCard key={c} c={c} guess={hand.guess} />) : [0, 1].map((i) => <span key={i} className="rt-card back" />)}</div>
                <div className="rt-eq" data-m={`l${k}`}>
                  <small>{hand.label}</small>
                  {hand.badge}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={["rt-seat", isHero ? "hero" : "", turn === seat ? "turn" : "", out.includes(seat) ? "out" : "", clickable ? "click" : "", marked.includes(seat) ? "own" : "", picked === seat ? "picked" : ""].join(" ")}
                style={{ left: X(x), top: Y(y) }}
                onClick={() => onSeat?.(seat)}
              >
                {turn === seat && (
                  <span className="tag" data-m="tag" style={{ top: -lay.tagLift[k] }}>
                    차례
                  </span>
                )}
                <b>{seat}</b>
                {stacks[seat] && <i>{stacks[seat]}</i>}
                {isHero && (
                  <span className="me" data-m="me" style={{ bottom: -lay.meDrop[k] }}>
                    {meLabel}
                  </span>
                )}
                {seat === mySeat && (
                  <span className="me mine" data-m="mine" style={{ bottom: -lay.meDrop[k] }}>
                    나
                  </span>
                )}
              </button>
            )}
            {b && !hand && bp && <BetBubble b={b} form={bp.form} style={{ left: PX(bp.x), top: PY(bp.y) }} />}
            {k === dealerSlot && lay.dealer && (
              <div className="rt-dealer" style={{ left: PX(lay.dealer.x), top: PY(lay.dealer.y) }}>
                D
              </div>
            )}
            {k === 0 && showHero && lay.heroCards && (
              <div className="rt-herocards" style={{ left: PX(lay.heroCards.x), top: PY(lay.heroCards.y) }}>
                {heroCards!.map((c) => (
                  <TableCard key={c} c={c} small guess={heroGuessed} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* every bubble in each of its forms, unseen, for the layout to measure */}
      <div className="rt-sizer" aria-hidden="true">
        {order.map((seat, k) => bubbles[seat] && !hands[seat] && BUBBLE_FORMS.map((f) => <BetBubble key={`${seat}${f}`} b={bubbles[seat]} form={f} m={`b${k}${f}`} />))}
      </div>
      {(potText || board) && (
        <div className="rt-center" style={{ top: PY(lay.center), gap: lay.centerGap }}>
          {potText && (
            <div className="rt-pot" data-m="pot">
              {potText}
            </div>
          )}
          {board && (
            <div className="rt-board" style={{ gap: lay.board.gap, ...css(cardVars(lay.board, "board")) }}>
              {board.map((c, i) => (c === undefined ? null : c === null ? <span key={i} className="rt-card empty" /> : <TableCard key={i} c={c} hot={i === hot} guess={boardGuessed.includes(i)} />))}
              {hotSlot >= 0 && (
                <span className="rt-hottag" data-m="hot" style={{ left: hotSlot * (lay.board.cw + lay.board.gap) + lay.board.cw / 2 }}>
                  역전
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
