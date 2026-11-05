import { useEffect, useMemo, useState } from "react";
import { CardPicker } from "../../components/Cards";
import { handClassOf, RANKS, SUITS, SUIT_SYMBOL, type Card } from "../../poker/cards";
import { countOuts } from "../../poker/equity";
import { legal, pot, toCall, type Game, type Street } from "../../play/engine";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import { analyseHand, cardText, parseCardText, type HandAnalysis, type StreetView } from "./handAnalysis";
import { levelInfo, LOG_STREET_LABEL, RESULT_LABEL, stackBb, tableOf, type LoggedHand, type Result } from "./handLog";
import { amountLabel, applyStep, baseStack, buttonSeat, positionsFor, raiseVerb, sizeOptions, skipTo, streetLines, TABLE_SIZES, undoSteps, upcoming, type LogStep } from "./recorder";

/**
 * Recording a hand on a picture of the table: table size and my seat, my cards as text,
 * then every seat's action street by street (unpressed seats fold, or check when nobody bet),
 * and at the end a run-out with each player's equity on every street.
 */

type FlowStep = "setup" | "hand" | "play" | "result";
const NEED: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);

export function TableFlow({ h, onChange, onReview, onClose }: { h: LoggedHand; onChange: (h: LoggedHand) => void; onReview: (h: LoggedHand, extra: string) => void; onClose: () => void }) {
  const [step, setStep] = useState<FlowStep>(() => (!h.seat ? "setup" : h.hole.length < 2 ? "hand" : "play"));
  const set = (patch: Partial<LoggedHand>) => onChange({ ...h, ...patch });
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const fmt = (bb: number) => amountLabel(bb, bbChips);

  // Light replay for recording (no grading); the result screen runs the full analysis.
  const live = useMemo(() => analyseHand(h, { iterations: 2000 }), [h]);
  const done = live.game.done;
  const street = live.game.street;

  const tabs: [FlowStep, string, boolean][] = [
    ["setup", "테이블", true],
    ["hand", "핸드", !!h.seat],
    ["play", step === "play" && !done ? LOG_STREET_LABEL[street] : "액션", !!h.seat && h.hole.length === 2],
    ["result", "결과", done],
  ];

  return (
    <div className="flow">
      <div className="flow-steps">
        {tabs.map(([id, label, enabled]) => (
          <button key={id} type="button" className={step === id ? "on" : ""} disabled={!enabled} onClick={() => setStep(id)}>
            {label}
          </button>
        ))}
        <button type="button" className="flow-close" onClick={onClose} aria-label="목록으로">
          ✕
        </button>
      </div>
      {step === "setup" && <SetupStep h={h} set={set} fmt={fmt} onNext={() => setStep(h.hole.length === 2 ? "play" : "hand")} />}
      {step === "hand" && <HandStep h={h} set={set} onNext={() => setStep("play")} />}
      {step === "play" && <PlayStep h={h} set={set} fmt={fmt} a={live} onResult={() => setStep("result")} />}
      {step === "result" && <ResultStep h={h} set={set} fmt={fmt} onReview={onReview} />}
    </div>
  );
}

// ───────────── ① table size and seat ─────────────

function SetupStep({ h, set, fmt, onNext }: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; fmt: (bb: number) => string; onNext: () => void }) {
  const seats = positionsFor(h.players);
  const bb = stackBb(h);
  const base = baseStack(tableOf(h));
  const [stacksOpen, setStacksOpen] = useState(Object.keys(h.stacks).length > 0);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const pickPlayers = (n: number) => {
    const next = positionsFor(n);
    // A new table size changes the seats: keep my seat only if it still exists, and start the actions over.
    set({ players: n, seat: next.includes(h.seat) ? h.seat : "", steps: [], stacks: {} });
  };
  return (
    <div className="flow-body">
      <div className="flow-label">몇 인 테이블?</div>
      <div className="flow-chips">
        {TABLE_SIZES.map((n) => (
          <button key={n} type="button" className={h.players === n ? "on" : ""} onClick={() => pickPlayers(n)}>
            {n}인
          </button>
        ))}
      </div>
      <div className="flow-label">
        내 포지션 <small>{h.seat || "테이블에서 자리를 눌러도 돼요"}</small>
      </div>
      <div className="flow-chips tight">
        {seats.map((s) => (
          <button key={s} type="button" className={h.seat === s ? "on" : ""} onClick={() => set({ seat: s, steps: h.seat === s ? h.steps : [] })}>
            {s}
          </button>
        ))}
      </div>
      <RaceTable
        seats={seats}
        hero={h.seat}
        button={buttonSeat(h.players)}
        stacks={Object.fromEntries(seats.map((s) => [s, fmt(s === h.seat ? base : (h.stacks[s] ?? base))]))}
        onSeat={(s) => set({ seat: s, steps: h.seat === s ? h.steps : [] })}
        compact
      />
      <div className="flow-form">
        <label className="flow-row">
          <span>블라인드</span>
          <select className="select" value={h.level ?? ""} onChange={(e) => set({ level: e.target.value ? Number(e.target.value) : null })}>
            <option value="">레벨 모름 (bb로 입력)</option>
            {BLIND_LEVELS.map(([lv, sb, big]) => (
              <option key={lv} value={lv}>
                Lv{lv} · {sb.toLocaleString()}/{big.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <label className="flow-row">
          <span>
            내 스택 {bb !== null && <small>= {bb}bb</small>}
          </span>
          <ChipsInput value={h.stack} unit="chips" onChange={(stack) => set({ stack })} placeholder={bbChips ? "칩 (예: 32,000)" : "칩 · 레벨을 고르면 bb 계산"} />
        </label>
        <label className="flow-row toggle">
          <span>BB 앤티 (BB가 1bb 더 냄)</span>
          <input type="checkbox" checked={h.bbAnte} onChange={(e) => set({ bbAnte: e.target.checked, steps: [] })} />
        </label>
        <button type="button" className="flow-row link" onClick={() => setStacksOpen(!stacksOpen)}>
          <span>다른 자리 스택</span>
          <b>{Object.keys(h.stacks).length ? `${Object.keys(h.stacks).length}자리 따로` : "모두 나와 같게"} ▾</b>
        </button>
        {stacksOpen && (
          <div className="flow-stacks">
            {seats
              .filter((s) => s !== h.seat)
              .map((s) => (
                <label key={s}>
                  {s}
                  <ChipsInput
                    value={h.stacks[s] !== undefined ? (bbChips ? Math.round(h.stacks[s] * bbChips) : h.stacks[s]) : null}
                    unit={bbChips ? "chips" : "bb"}
                    placeholder={fmt(base)}
                    onChange={(v) => {
                      const stacks = { ...h.stacks };
                      if (v && v > 0) stacks[s] = bbChips ? v / bbChips : v;
                      else delete stacks[s];
                      set({ stacks });
                    }}
                  />
                </label>
              ))}
          </div>
        )}
      </div>
      <button type="button" className="primary wide" disabled={!h.seat} onClick={onNext}>
        다음: 내 핸드 →
      </button>
    </div>
  );
}

// ───────────── ② my cards ─────────────

function HandStep({ h, set, onNext }: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; onNext: () => void }) {
  const taken = [...h.board, ...h.showdowns.flatMap((s) => s.cards)];
  return (
    <div className="flow-body">
      <div className="flow-summary">
        <b>{h.players}인</b> · 내 자리 <b>{h.seat}</b>
      </div>
      <CardText
        label="내 핸드"
        cards={h.hole}
        max={2}
        taken={taken}
        onChange={(hole) => set({ hole })}
        autoFocus
        hint={h.hole.length === 2 ? `${handClassOf(h.hole[0], h.hole[1])}` : undefined}
      />
      <button type="button" className="primary wide" disabled={h.hole.length !== 2} onClick={onNext}>
        다음: 액션 기록 →
      </button>
    </div>
  );
}

// ───────────── ③ recording ─────────────

function PlayStep({ h, set, fmt, a, onResult }: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; fmt: (bb: number) => string; a: HandAnalysis; onResult: () => void }) {
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
  const lines = streetLines(g, fmt);
  const current = lines.find((l) => l.street === g.street);
  const earlier = lines.filter((l) => l.street !== g.street || g.done);
  const [custom, setCustom] = useState("");
  const [fixBoard, setFixBoard] = useState(false);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const verb = raiseVerb(g);

  // Bubbles: each seat's latest action this street, numbered like the order chips below the table.
  const bubbles: Record<string, Bubble> = {};
  {
    let n = 0, raised = false;
    const invested = new Set<number>();
    for (const e of g.log) {
      if (e.kind === "call" || e.kind === "bet" || e.kind === "raise") invested.add(e.idx);
      if (e.street !== g.street || e.kind === "post") continue;
      if (e.kind === "fold") {
        if (invested.has(e.idx) || g.players[e.idx].hero) n++;
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

  function raiseTo(to: number) {
    if (!actor) return;
    push({ s: actor.seat, k: "raise", to });
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
          <span>내 에퀴티</span>
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
        button={buttonSeat(h.players)}
        stacks={Object.fromEntries(g.players.map((p) => [p.seat, fmt(p.stack)]))}
        bubbles={bubbles}
        turn={actor?.seat}
        out={folded}
        board={boardSlots(h.board, g.done ? 5 : need)}
        pot={`팟 ${fmt(potNow)}`}
        heroCards={h.hole}
        onSeat={(s) => actor && s !== actor.seat && next.includes(s) && push(...skipTo(g, s))}
      />
      {current && current.actions.length > 0 && (
        <div className="flow-order">
          {current.actions.map((t, i) => (
            <span key={i}>
              <i>{i + 1}</i>
              {t}
            </span>
          ))}
          {actor && <span className="now">{actor.seat === h.seat ? `${actor.seat}(나)` : actor.seat} 차례</span>}
        </div>
      )}
      {boardMissing && (
        // Only this street's new card(s): typing the turn card never touches the flop.
        <CardText
          key={g.street}
          label={`${LOG_STREET_LABEL[g.street as keyof typeof LOG_STREET_LABEL]} 카드`}
          cards={h.board.slice(need === 3 ? 0 : need - 1, need)}
          max={need === 3 ? 3 : 1}
          taken={[...h.hole, ...h.board.slice(0, need === 3 ? 0 : need - 1), ...h.showdowns.flatMap((s) => s.cards)]}
          onChange={(cards) => set({ board: [...h.board.slice(0, need === 3 ? 0 : need - 1), ...cards] })}
          placeholder={g.street === "flop" ? "예) Kd9d2s" : g.street === "turn" ? "턴 한 장 예) 6c" : "리버 한 장 예) Qd"}
          autoFocus
          compact
        />
      )}
      {!boardMissing && h.board.length > 0 && (
        <button type="button" className="ghost small" onClick={() => setFixBoard(!fixBoard)}>
          보드 고치기
        </button>
      )}
      {fixBoard && !boardMissing && (
        <CardText
          label="보드 전체"
          cards={h.board}
          max={5}
          taken={[...h.hole, ...h.showdowns.flatMap((s) => s.cards)]}
          onChange={(cards) => set({ board: cards })}
          compact
        />
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
            <b>
              {actor.seat}
              {actor.hero ? " (나)" : ""} 차례
            </b>
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
              <button type="button" className="allin" onClick={() => raiseTo(L.maxRaiseTo)}>
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
                {[...sizeOptions(g), potSized(g)].filter(uniqueTo).map((o) => (
                  <button key={o.to} type="button" onClick={() => raiseTo(o.to)}>
                    {o.label || `${verb}`}
                    <small>{fmt(o.to)}</small>
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
              <small>내 차례까지</small>
            </button>
          </div>
          <div className="flow-tip">자리를 누르면 그 자리로 넘어가요. 그 사이 자리는 {L.canCheck ? "체크" : "폴드"}로 채워져요.</div>
        </div>
      ) : null}
    </div>
  );
}

/** Board for a street: its cards, empty slots for ones not entered yet, nothing for later streets. */
/** Postflop grading line: my option's EV next to the best one (bot-response model, this street only). */
function evLine(d: { options: { key: string; label: string; ev: number | null }[]; chosen: string }, chipsIn: (s: string) => string): string {
  const evs = d.options.filter((o) => o.ev !== null) as { key: string; label: string; ev: number }[];
  if (!evs.length) return "";
  const best = evs.reduce((x, y) => (y.ev > x.ev ? y : x));
  const mine = evs.find((o) => o.key === d.chosen);
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 10) / 10}bb`;
  const same = mine && mine.key === best.key;
  return `EV(이번 스트리트, 펍아재 봇 반응 가정): ${mine ? `내 선택 ${sign(mine.ev)}` : ""}${same ? " · 가장 높음" : ` · 최고 ${chipsIn(best.label)} ${sign(best.ev)}`}`;
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

function ResultStep({ h, set, fmt, onReview }: { h: LoggedHand; set: (p: Partial<LoggedHand>) => void; fmt: (bb: number) => string; onReview: (h: LoggedHand, extra: string) => void }) {
  const [a, setA] = useState<HandAnalysis | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const seats = positionsFor(h.players);
  const bbChips = levelInfo(h.level)?.bb ?? null;

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
    if (h.net !== net || h.result !== result) set({ net, result });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a]);
  useEffect(() => {
    if (!playing || !a) return;
    if (at >= a.streets.length - 1) return setPlaying(false);
    const t = setTimeout(() => setAt((x) => x + 1), 1300);
    return () => clearTimeout(t);
  }, [playing, at, a]);

  if (!a) return <div className="flow-body"><div className="flow-wait">승률 계산 중…</div></div>;
  const views = a.streets;
  const v = views[Math.min(at, views.length - 1)];
  const heroEq = (x: StreetView) => x.known.find((k) => k.seat === h.seat)?.equity ?? null;
  const leadOf = (x: StreetView) => (heroEq(x) === null ? null : heroEq(x)! >= Math.max(...x.known.map((k) => k.equity)) - 1e-9);
  const prev = at > 0 ? views[at - 1] : null;
  const flipped = prev && leadOf(prev) !== null && leadOf(v) !== null && leadOf(prev) !== leadOf(v);
  const decisions = a.decisions.filter((d) => d.street === v.street);
  const chipLines = new Map(streetLines(a.game, fmt).map((l) => [l.street, l.actions]));
  /** Option labels from the grader are in bb: show their amounts in chips (percentages stay). */
  const chipsIn = (label: string) =>
    label.replace(/(\d+(?:\.\d+)?)(?![\d%.])/g, (m) => (bbChips ? (Math.round((Number(m) * bbChips) / 100) * 100).toLocaleString() : fmt(Number(m))));
  const sdSeats = a.showdownSeats;
  const known = new Map(h.showdowns.filter((s) => s.seat).map((s) => [s.seat, s]));
  const net = a.heroNet;

  // Hands on the table at this street: me, the cards I saw, and face-down for live players I didn't see.
  const hands: Record<string, HandShow> = {};
  for (const seat of v.street === "preflop" ? v.endLive : v.live) {
    const k = v.known.find((x) => x.seat === seat);
    const isHero = seat === h.seat;
    const cards = isHero ? h.hole : known.get(seat)?.cards ?? [];
    const last = at === views.length - 1;
    if (k) {
      const best = Math.max(...v.known.map((x) => x.equity));
      const cls = last && v.board?.length === 5 ? (k.equity >= best - 1e-9 ? "win" : "lose") : k.equity >= best - 1e-9 ? "lead" : "behind";
      const text = last && v.board?.length === 5 ? (k.equity >= 0.999 ? "승" : k.equity > 0.001 ? `찹 ${pct(k.equity)}` : "패") : pct(k.equity);
      hands[seat] = { cards, label: `${seat}${isHero ? "(나)" : ""}`, badge: text, cls };
    } else if (cards.length === 2) {
      hands[seat] = { cards, label: `${seat}${isHero ? "(나)" : ""}`, badge: v.estimate !== null && isHero ? `추정 ${pct(v.estimate)}` : "-", cls: "unknown" };
    } else if (!isHero) {
      hands[seat] = { cards: [], label: seat, badge: "?", cls: "unknown" };
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
    const did = streetLines(a.game, fmt)
      .flatMap((l) => l.actions.filter((x) => x.startsWith(`${seat} `)).map((x) => `${LOG_STREET_LABEL[l.street as keyof typeof LOG_STREET_LABEL]} ${x.slice(seat.length + 1)}`))
      .join(", ");
    set({ showdowns: [...rest, { ...cur, ...patch, did: cur.did || did }] });
  };

  const summary = () => {
    const eqLine = views.map((x) => `${LOG_STREET_LABEL[x.street as keyof typeof LOG_STREET_LABEL]} ${heroEq(x) !== null ? pct(heroEq(x)) : `추정 ${pct(x.estimate)}`}`).join(" → ");
    const dec = a.decisions.map((d) => {
      const grade = { good: "좋은 선택", ok: "괜찮음", mistake: "실수", info: "참고" }[d.decision.grade];
      return `- ${LOG_STREET_LABEL[d.street as keyof typeof LOG_STREET_LABEL]} ${d.decision.chosenLabel}: 필요 ${pct(d.decision.reqEquity)} · 그때 추정 ${pct(d.decision.equity)} · 실제 ${pct(d.actual)} [${grade}] ${d.decision.summary}${d.decision.chart ? ` (차트: ${d.decision.chart})` : ""}`;
    });
    return ["", "스트리트별 내 승률 (공개된 패 기준, 없으면 추정 레인지 기준):", eqLine, "", "내 결정 채점 (금액은 bb, 상대 레인지는 액션으로 좁힌 추정):", ...dec].join("\n");
  };

  return (
    <div className="flow-body">
      {sdSeats.length > 0 && (
        <div className="flow-sd">
          {sdSeats.map((seat) => (
            <div key={seat} className="flow-sd-row">
              <b>{seat}</b>
              <CardText
                cards={known.get(seat)?.cards ?? []}
                max={2}
                taken={[...h.hole, ...h.board, ...h.showdowns.filter((s) => s.seat !== seat).flatMap((s) => s.cards)]}
                onChange={(cards) => setShowdown(seat, { cards })}
                placeholder="상대 핸드 예) KcQc"
                compact
                inline
              />
              <input className="flow-nick" list="log-villain-names" value={known.get(seat)?.name ?? ""} onChange={(e) => setShowdown(seat, { name: e.target.value })} placeholder="별명" />
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
        button={buttonSeat(h.players)}
        stacks={{}}
        out={seats.filter((s) => !v.live.includes(s))}
        board={boardSlots(h.board, NEED[v.street])}
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
            <em>{d.decision.chart ?? evLine(d.decision, chipsIn)}</em>
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
        {net !== null ? (
          <div className={`net ${net > 0 ? "win" : net < 0 ? "lose" : ""}`}>
            {net > 0 ? "+" : ""}
            {fmt(net)}
            <small>
              {bbChips ? `${net > 0 ? "+" : ""}${net}bb · ` : ""}
              {a.game.showdown ? "쇼다운" : "상대 폴드"}
            </small>
          </div>
        ) : (
          <div className="net unknown">
            결과
            <small>상대 핸드를 넣으면 자동 계산</small>
            <span className="flow-result-chips">
              {(Object.keys(RESULT_LABEL) as Result[]).map((r) => (
                <button key={r} type="button" className={h.result === r ? "on" : ""} onClick={() => set({ result: h.result === r ? null : r })}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
            </span>
          </div>
        )}
        <button type="button" className="go" onClick={() => onReview(net !== null ? { ...h, net: bbChips ? Math.round(net * bbChips) : net, result: net > 0 ? "win" : net < 0 ? "lose" : "chop" } : h, summary())}>
          AI 리뷰
        </button>
      </div>
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
}

/** Racetrack table: seats spaced evenly along the rail, me at the bottom, then clockwise in action order. */
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
  compact?: boolean;
}) {
  const { seats, hero, button, stacks, bubbles = {}, turn, out = [], board, hot = -1, pot: potText, hands = {}, heroCards, onSeat, compact } = props;
  const W = 358, RW = compact ? 226 : 240, RH = compact ? 318 : 350, H = RH + 56;
  const cx = W / 2, cy = H / 2, left = cx - RW / 2, top = cy - RH / 2, r = RW / 2;
  const a = RW / 2 - 7, hh = (RH - RW) / 2, arc = Math.PI * a, P = 2 * arc + 4 * hh;
  const at = (s: number): [number, number, number, number] => {
    s = ((s % P) + P) % P;
    const seg = [arc / 2, 2 * hh, arc, 2 * hh, arc / 2];
    const polar = (oy: number, deg: number): [number, number, number, number] => [cx + a * Math.cos((deg * Math.PI) / 180), oy + a * Math.sin((deg * Math.PI) / 180), cx, oy];
    let t = s;
    if (t < seg[0]) return polar(cy + hh, 90 + (t / seg[0]) * 90);
    t -= seg[0];
    if (t < seg[1]) return [cx - a, cy + hh - t, cx, cy + hh - t];
    t -= seg[1];
    if (t < seg[2]) return polar(cy - hh, 180 + (t / seg[2]) * 180);
    t -= seg[2];
    if (t < seg[3]) return [cx + a, cy - hh + t, cx, cy - hh + t];
    t -= seg[3];
    return polar(cy + hh, (t / seg[4]) * 90);
  };
  const heroIdx = Math.max(0, seats.indexOf(hero || seats[seats.length - 1]));
  const order = [...seats.slice(heroIdx), ...seats.slice(0, heroIdx)];
  const X = (x: number) => `${(x / W) * 100}%`;
  const Y = (y: number) => `${(y / H) * 100}%`;
  return (
    <div className="rt-table" style={{ aspectRatio: `${W} / ${H}` }}>
      <div className="rt-rail" style={{ left: X(left), top: Y(top), width: X(RW), height: Y(RH), borderRadius: `${r}px / ${r}px` }} />
      <div className="rt-felt" style={{ left: X(left + 14), top: Y(top + 14), width: X(RW - 28), height: Y(RH - 28), borderRadius: `${r - 14}px` }} />
      <div className="rt-betline" style={{ left: X(left + 48), top: Y(top + 48), width: X(RW - 96), height: Y(RH - 96), borderRadius: `${r - 48}px` }} />
      <div className="rt-logo" style={{ top: Y(cy + RH / 2 - 112) }}>
        PubAJ
      </div>
      {order.map((seat, k) => {
        const [x, y, ox, oy] = at((k * P) / order.length);
        const isHero = seat === hero;
        const hand = hands[seat];
        const b = bubbles[seat];
        const L = Math.hypot(ox - x, oy - y) || 1;
        const ux = (ox - x) / L, uy = (oy - y) / L;
        const side = Math.abs(ux) > 0.75;
        const d = side ? 36 : 58;
        const bx = x + ux * d, by = y + uy * d;
        const shift = side ? (ux < 0 ? "translate(-100%,-50%)" : "translate(0,-50%)") : "translate(-50%,-50%)";
        const clickable = !!onSeat;
        return (
          <div key={seat}>
            {hand ? (
              <div className={`rt-hand ${hand.cls}`} style={{ left: X(x + ux * 16), top: Y(y + uy * 16) }}>
                <div className="cards">{hand.cards.length ? hand.cards.map((c) => <TableCard key={c} c={c} />) : [0, 1].map((i) => <span key={i} className="rt-card back" />)}</div>
                <div className="rt-eq">
                  <small>{hand.label}</small>
                  {hand.badge}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={["rt-seat", isHero ? "hero" : "", turn === seat ? "turn" : "", out.includes(seat) ? "out" : "", clickable ? "click" : ""].join(" ")}
                style={{ left: X(x), top: Y(y) }}
                onClick={() => onSeat?.(seat)}
              >
                {turn === seat && <span className="tag">차례</span>}
                <b>{seat}</b>
                {stacks[seat] && <i>{stacks[seat]}</i>}
                {isHero && <span className="me">나</span>}
              </button>
            )}
            {b && !hand && (
              <div className={`rt-bub ${b.cls}`} style={{ left: X(bx), top: Y(by), transform: shift }}>
                <em>{b.num}</em>
                <span>{b.verb}</span>
                {b.amount && <b>{b.amount}</b>}
              </div>
            )}
            {seat === button && !hand && (() => {
              const [dx, dy, dox, doy] = at((k * P) / order.length + P / order.length / 2);
              const dl = Math.hypot(dox - dx, doy - dy) || 1;
              return <div className="rt-dealer" style={{ left: X(dx + ((dox - dx) / dl) * 14), top: Y(dy + ((doy - dy) / dl) * 14) }}>D</div>;
            })()}
            {isHero && heroCards && heroCards.length === 2 && !hand && (
              <div className="rt-herocards" style={{ left: X(x + 50), top: Y(y + 2) }}>
                {heroCards.map((c) => (
                  <TableCard key={c} c={c} small />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {(potText || board) && (
        <div className="rt-center" style={{ top: Y(cy - 4) }}>
          {potText && <div className="rt-pot">{potText}</div>}
          {board && (
            <div className="rt-board">
              {board.map((c, i) => (c === undefined ? null : c === null ? <span key={i} className="rt-card empty" /> : <TableCard key={i} c={c} hot={i === hot} />))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TableCard({ c, small, hot }: { c: Card; small?: boolean; hot?: boolean }) {
  const suit = SUITS[c & 3];
  return (
    <span className={`rt-card s-${suit} ${small ? "small" : ""} ${hot ? "hot" : ""}`}>
      {RANKS[c >> 2]}
      <small>{SUIT_SYMBOL[suit]}</small>
    </span>
  );
}

// ───────────── inputs ─────────────

/** Cards as text ("AdTd") with a rank/suit keypad; a 52-card table is one tap away. */
function CardText(props: { label?: string; cards: Card[]; max: number; taken: Card[]; onChange: (cards: Card[]) => void; placeholder?: string; hint?: string; autoFocus?: boolean; compact?: boolean; inline?: boolean }) {
  const { label, cards, max, taken, onChange, placeholder, hint, autoFocus, compact, inline } = props;
  const [text, setText] = useState(() => cardText(cards));
  const [picker, setPicker] = useState(false);
  const [keys, setKeys] = useState(!inline);
  // Keep the text in step when the cards change elsewhere (picker, undo).
  useEffect(() => {
    if (parseCardText(text, max, taken).cards.join() !== cards.join()) setText(cardText(cards));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.join()]);
  const parsed = parseCardText(text, max, taken);
  const update = (t: string) => {
    setText(t);
    const p = parseCardText(t, max, taken);
    if (!p.error && p.cards.join() !== cards.join()) onChange(p.cards);
  };
  return (
    <div className={`cardtext ${compact ? "compact" : ""} ${inline ? "inline" : ""}`}>
      {label && <div className="flow-label">{label}</div>}
      <div className={`cardtext-field ${parsed.error ? "bad" : parsed.cards.length === max ? "ok" : ""}`}>
        <input
          value={text}
          onChange={(e) => update(e.target.value)}
          onFocus={() => setKeys(true)}
          placeholder={placeholder ?? (max === 2 ? "예) AdTd" : "카드")}
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="none"
        />
        <span className="parsed">
          {parsed.cards.map((c) => (
            <TableCard key={c} c={c} small />
          ))}
        </span>
      </div>
      {parsed.error ? <div className="cardtext-msg bad">{parsed.error}</div> : hint ? <div className="cardtext-msg">{hint}</div> : null}
      {keys && (
        <div className="cardkeys">
          <div className="ranks">
            {"AKQJT98765432".split("").map((k) => (
              <button key={k} type="button" onClick={() => update(text + k)}>
                {k}
              </button>
            ))}
          </div>
          <div className="suits">
            {SUITS.split("").map((s) => (
              <button key={s} type="button" className={`s-${s}`} onClick={() => update(text + s)}>
                {SUIT_SYMBOL[s]}
                <small>{s}</small>
              </button>
            ))}
            <button type="button" onClick={() => update(text.slice(0, -1))} aria-label="지우기">
              ⌫
            </button>
            <button type="button" onClick={() => setPicker(!picker)}>
              표
            </button>
          </div>
        </div>
      )}
      {picker && (
        <CardPicker
          selected={cards}
          max={max}
          disabled={taken}
          onChange={(cs) => {
            onChange(cs);
            setText(cardText(cs));
          }}
        />
      )}
    </div>
  );
}

/** A chip count with thousands separators, or a bb amount. */
function ChipsInput({ value, onChange, placeholder, unit }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; unit: "chips" | "bb" }) {
  const chips = unit === "chips";
  return (
    <input
      inputMode={chips ? "numeric" : "decimal"}
      value={value === null ? "" : chips ? value.toLocaleString() : String(value)}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value.replace(chips ? /[^0-9]/g : /[^0-9.]/g, "");
        onChange(raw ? Number(raw) : null);
      }}
    />
  );
}
