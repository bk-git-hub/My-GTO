import { useEffect, useMemo, useRef, useState } from "react";
import { CardRow } from "../../components/Cards";
import { getSet } from "../../data/charts";
import { cardLabel, handClassOf } from "../../poker/cards";
import { equityVs } from "../../play/analysis";
import { callPrice, heroNet, pot, toCall, winnablePot, type LogEntry, type Street } from "../../play/engine";
import { handFeatures } from "../../play/handInfo";
import { chartSourceText } from "../../play/computedChart";
import { foldOutFacts } from "../../play/foldOut";
import { packListText } from "../../play/packMatch";
import { badgeOf, isGto, PRESETS, presetOf, type SeatProfile } from "../../play/profile";
import { MODE_SET, PLAY_STAGES, type PlayMode } from "../../play/policy";
import { GRADE_MARK, heroAct, heroMoves, MODE_TABLE, runBots, startHand, tableKeys, type AiSource, type PlayState, type TableCtx } from "../../play/table";
import { settingsStore, useSettings } from "../../state/settings";
import { recordAnswer } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";
import { holdUpdates } from "../../pwa/update";
import { advance } from "./advance";
import { GRADE_TEXT, HandSummary, potText, referenceLine } from "./HandSummary";
import { packSource } from "./packSource";
import { badgeClass, mixText, TableSetup } from "./TableSetup";
import { engineIndex, physicalSeat, profilesFor, readTable, tableSettingsOf, tableStore, updateTable } from "./tableSettings";
import {
  addHand,
  chipResult,
  EMPTY_SESSION,
  handVerdict,
  missLine,
  sessionLine,
  STREET_LABEL,
  tableVerdict,
  verdictReviewLines,
  type SessionTotals,
} from "./verdict";

/** How the AI opponents play, for the page note and the AI review. */
export const BOT_TEXT =
  "상대 AI는 앱이 계산한 프리플랍 차트를 바탕으로 자리마다 정한 성향만큼 레인지를 넓히거나 좁혀요. 헤즈업 플랍은 맞는 솔버 팩이 있으면 솔버대로, 그 밖에는 근사 규칙으로 쳐요.";
const CASH_NOTE = "캐시 6맥스의 프리플랍은 손으로 만든 근사 차트예요 (솔버 아님).";
const ACT_TEXT: Record<string, string> = { fold: "폴드", check: "체크", call: "콜", bet: "벳", raise: "레이즈", post: "블라인드" };
/** The tag after an AI's action in the log: what it was based on ("+성향" when the seat's profile adjusted it). */
export const SRC_TAG: Record<AiSource, string> = { chart: "차트", cashChart: "캐시 차트", fallback: "기본 규칙", solver: "솔버", solverApprox: "솔버 근사", rule: "규칙" };
const PROFILE_TAG = "+성향";
/** The log's legend, by table: the cash table's preflop chart is hand-made, not computed. */
const srcLegend = (mode: PlayMode) =>
  `${mode === "cash" ? "(캐시 차트) 손으로 만든 근사 차트" : "(차트) 계산된 프리플랍 차트"} · (솔버) 솔버 팩 · (규칙) 근사 규칙 · (기본 규칙) 차트 없는 상황 · (${PROFILE_TAG}) 그 자리 성향만큼 조절`;
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);

function entryText(e: LogEntry, tag?: AiSource, prof?: SeatProfile | null): string {
  const t = tag ? ` (${SRC_TAG[tag]}${isGto(prof) ? "" : PROFILE_TAG})` : "";
  if (e.kind === "post") return `${e.seat} ${e.amount}`;
  if (e.kind === "fold" || e.kind === "check") return `${e.seat} ${ACT_TEXT[e.kind]}${t}`;
  return `${e.seat} ${ACT_TEXT[e.kind]} ${r1(e.amount)}${e.allIn ? " 올인" : ""}${t}`;
}

function streetLog(s: PlayState, street: Street): string {
  const g = s.game;
  return g.log
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.street === street && e.kind !== "post" && !(e.kind === "fold" && street === "preflop" && !g.players[e.idx].hero))
    .map(({ e, i }) => entryText(e, e.idx === s.heroIdx ? undefined : s.srcs?.[i], s.profiles?.[e.idx]))
    .join(", ");
}

/**
 * The muted line under the board: what the AIs and the grade use on this street, on one line (the pack's full title
 * and the reasons of an approximate match open under [왜?]).
 */
function sourceLine(s: PlayState): { text: string; why?: string[] } | null {
  const g = s.game;
  if (g.street === "preflop" || g.players[s.heroIdx].folded) return null;
  if (s.needs) return { text: "솔버 팩 여는 중…" };
  const m = s.post?.match;
  const foldedPre = new Set(g.log.filter((e) => e.street === "preflop" && e.kind === "fold").map((e) => e.idx));
  const multi = g.players.filter((_, i) => !foldedPre.has(i)).length >= 3;
  if (multi) return { text: "멀티웨이 · 솔버 없음 (근사)" };
  if (m && g.street !== "flop") return { text: "턴부터는 솔버 없음 · 근사" };
  if (s.post?.failed) return { text: "솔버 팩을 못 열어서 근사 · 솔버 팩은 인터넷 필요" };
  if (m) return { text: `${m.level === "exact" ? "솔버" : "솔버 근사"} · ${m.title}`, why: [m.title, ...m.reasons] };
  return { text: "헤즈업 · 맞는 팩 없음 (근사)" };
}

/** Plain-text hand history + decision analysis for the AI review. */
function reviewFacts(s: PlayState): string {
  const g = s.game;
  const hero = g.players[s.heroIdx];
  const lines =
    s.mode === "cash"
      ? [`게임: ${getSet(MODE_SET.cash).game}`, `스택: 모두 ${g.startStack}bb, 블라인드 0.5/1bb, 앤티 없음, ${g.players.length}인`]
      : [
          `게임: 홀덤펍 토너먼트 · ${g.players.length}인 · BB 앤티 1bb · 모두 같은 스택`,
          `스택 구간: ${PLAY_STAGES.find((x) => x.id === s.stageId)?.label ?? s.stageId} (모두 ${g.startStack}bb 시작)`,
        ];
  lines.push(
    `내 자리: ${hero.seat}, 내 핸드: ${hero.hole.map(cardLabel).join(" ")} (${handClassOf(hero.hole[0], hero.hole[1])})`,
    `상대 AI: ${BOT_TEXT}${s.mode === "cash" ? ` ${CASH_NOTE}` : ""}`,
  );
  if (s.profiles) {
    const seats = g.players
      .map((p, i) => ({ p, prof: s.profiles![i] }))
      .filter(({ p }) => !p.hero)
      .map(({ p, prof }) => `${p.seat} ${prof && presetOf(prof) ? PRESETS[presetOf(prof)!].label : `직접(루즈 ${prof?.loose ?? 0}, 공격 ${prof?.aggro ?? 0}, 콜 ${prof?.sticky ?? 0})`}`);
    lines.push(`상대 성향 (근사 모델, 차트에서 넓히거나 좁힘): ${seats.join(", ")}`);
  }
  for (const st of ["preflop", "flop", "turn", "river"] as Street[]) {
    const acts = g.log.map((e, i) => ({ e, i })).filter(({ e }) => e.street === st && e.kind !== "post");
    if (!acts.length) continue;
    const boardN = st === "flop" ? 3 : st === "turn" ? 4 : st === "river" ? 5 : 0;
    const board = boardN ? ` [보드 ${g.board.slice(0, boardN).map(cardLabel).join(" ")}]` : "";
    lines.push(`${STREET_LABEL[st]}${board}: ${acts.map(({ e, i }) => entryText(e, e.idx === s.heroIdx ? undefined : s.srcs?.[i], s.profiles?.[e.idx])).join(", ")}`);
  }
  if (s.post?.match) lines.push(`솔버 팩: ${s.post.match.title} (${s.post.match.level === "exact" ? "정확히 맞음" : `근사: ${s.post.match.reasons.join(", ")}`})`);
  lines.push("", "내 결정 분석 (상대 레인지는 AI 규칙으로 좁힌 추정치, EV는 현재 스트리트 기준 근사):");
  for (const d of s.decisions) {
    lines.push(
      `- ${STREET_LABEL[d.street]} ${potText(d, "bb")}, 콜 금액 ${r1(d.toCall)}bb, 필요 에퀴티 ${pct(d.reqEquity)}, 내 에퀴티 ${pct(d.equity)}, SPR ${r1(d.spr)} → 선택: ${d.chosenLabel} [${GRADE_TEXT[d.grade]}] ${d.summary}`,
    );
    lines.push(`  기준: ${referenceLine(d)}`);
    if (d.chartInfo) lines.push(...d.chartInfo.facts.map((f) => `  ${f}`));
    else if (d.chart) lines.push(`  차트: ${d.chart}`);
    if (d.pack) lines.push(`  솔버 팩: ${d.pack.title}${d.pack.reasons.length ? ` · 근사 이유: ${d.pack.reasons.join(", ")}` : ""}`);
    if (d.foldOut) lines.push(`  ${d.foldOut.text} (${foldOutFacts(d.foldOut).join(", ")})`);
    const evs = d.options.filter((o) => o.ev !== null).map((o) => `${o.label} ${o.ev! >= 0 ? "+" : ""}${o.ev}bb`);
    if (evs.length) lines.push(`  선택지 EV: ${evs.join(", ")}`);
    for (const v of d.villains) if (v.breakdown) lines.push(`  ${v.seat} 추정 레인지: ${v.breakdown}`);
  }
  const net = heroNet(g);
  const shown = g.showdown
    ? g.players.filter((p) => !p.folded).map((p) => `${p.seat} ${p.hole.map(cardLabel).join(" ")}`).join(", ")
    : "쇼다운 없음";
  // Decisions first: the coach should judge the play, not this one hand's chips.
  lines.push("", ...verdictReviewLines(s.decisions), `결과: ${net >= 0 ? "+" : ""}${net}bb · ${shown}`);
  const sources = new Set(s.decisions.flatMap((d) => (d.chartInfo?.source ? [d.chartInfo.source] : [])));
  if (sources.size) lines.push("", `프리플랍 차트 출처: ${chartSourceText(sources)}`);
  return lines.join("\n");
}

/** Deal a hand on the AI table: the button's seat from the settings, every opponent's profile. */
function deal(mode: PlayMode, stage: string, ctx: TableCtx): { s: PlayState; button: number } {
  const t = readTable();
  const n = MODE_TABLE[mode].seats.length;
  const b = t.button % n;
  const s = startHand(mode, stage, engineIndex(0, b, n), { profiles: profilesFor(t, b, n), ctx });
  return { s, button: b };
}

export function PlayPage() {
  const { playMode: mode } = useSettings();
  const src = useMemo(() => packSource(), []);
  const ctx = useMemo<TableCtx>(() => ({ oracle: src.oracle }), [src]);
  const table = tableSettingsOf(tableStore.use());
  const [stage, setStage] = useState("deep");
  const [first] = useState(() => deal(mode, "deep", ctx));
  const [s, setS] = useState<PlayState>(first.s);
  /** The button of the hand on screen (physical seat), so the next hand moves it on by one. */
  const [button, setButton] = useState(first.button);
  /** The states just before each of my decisions this hand (다시 이 상황). */
  const [history, setHistory] = useState<PlayState[]>([]);
  /** The finished hand a replay came from. */
  const [origin, setOrigin] = useState<{ s: PlayState; history: PlayState[] } | null>(null);
  const token = useRef(0);
  /** The action buttons, kept on screen when my turn comes (a flop decision sits below a phone's fold). */
  const actionsRef = useRef<HTMLDivElement>(null);
  // This visit's totals: mistakes over graded decisions, next to the chips (luck and skill).
  const [session, setSession] = useState<SessionTotals>(() => (first.s.game.done ? withHand(EMPTY_SESSION, first.s) : EMPTY_SESSION));
  const [hint, setHint] = useState(false);
  const [setup, setSetup] = useState(false);
  const [why, setWhy] = useState(false);
  const [packs, setPacks] = useState(() => src.packs());
  /** The page-load manifest load gave up (offline with nothing cached, or a slow line): say so, not "loading". */
  const [packsFailed, setPacksFailed] = useState(false);
  const coach = useCoach();
  const g = s.game;
  const hero = g.players[s.heroIdx];
  const moves = heroMoves(s, ctx);
  const loading = !!s.needs;
  const heroTurn = !g.done && g.toAct === s.heroIdx;
  const call = heroTurn ? toCall(g, s.heroIdx) : 0;
  const potNow = pot(g);
  const n = g.players.length;
  // A hand I've started acting in would be lost by a reload: no automatic app update until it ends.
  const midHand = !g.done && s.decisions.length > 0;
  useEffect(() => (midHand ? holdUpdates() : undefined), [midHand]);

  // My turn: if the first row of buttons is below the screen's edge, scroll down just enough to show it (never up,
  // never more), so the board stays in view and nothing moves when the buttons are already visible.
  useEffect(() => {
    if (!heroTurn) return;
    const b = actionsRef.current?.querySelector("button");
    if (!b || typeof window === "undefined") return;
    const over = b.getBoundingClientRect().bottom + 8 - window.innerHeight;
    if (over > 0) window.scrollBy({ top: over });
  }, [heroTurn, g.street, g.log.length]);

  // The next hand's button: one seat on from the hand dealt (idempotent, so a double effect does no harm).
  useEffect(() => {
    updateTable((t) => ({ ...t, button: (button + 1) % n }));
  }, [button, n]);

  useEffect(() => {
    src.prefetchManifest();
    let live = true;
    src
      .load({ kind: "manifest" }, 15000)
      .catch(() => false)
      .then((ok) => {
        if (!live) return;
        setPacks(src.packs());
        setPacksFailed(!ok && !src.packs());
      });
    return () => {
      live = false;
    };
  }, [src]);

  // Data the hand needs (a solver pack's manifest or flop file): load it, then let the AIs go on. advance never
  // rejects in practice; if it did, the hand goes on marked as a failed load rather than waiting forever.
  useEffect(() => {
    if (!s.needs) return;
    const tok = token.current;
    let live = true;
    const current = () => live && token.current === tok;
    advance(s, src, ctx, current)
      .catch(() => runBots({ ...s, needs: undefined, post: { match: s.post?.match ?? null, failed: s.needs!.kind } }, ctx))
      .then((next) => {
        if (next && current()) {
          show(next);
          setPacks(src.packs());
        }
      });
    return () => {
      live = false;
    };
  }, [s]);

  const hintEq = useMemo(() => {
    if (!hint || !heroTurn) return null;
    const acted = new Set(g.log.filter((e) => e.kind === "call" || e.kind === "raise" || e.kind === "bet").map((e) => e.idx));
    const opp = g.players
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i !== s.heroIdx && !p.folded && (g.street !== "preflop" || acted.has(i)));
    if (!opp.length) return null;
    return equityVs(hero.hole, g.board, opp.map(({ i }) => s.ranges[i]), 2000);
  }, [hint, heroTurn, s, g, hero.hole]);

  /** Show a hand; a finished one (bots can end it before I act) joins the session totals, unless it is a replay. */
  function show(next: PlayState) {
    setS(next);
    if (next.game.done && !next.replay) setSession((t) => withHand(t, next));
  }

  function newHand(st = stage, m = mode) {
    token.current++;
    // A new hand starts at the top (the 다음 핸드 button sits low on the page, under the summary).
    window.scrollTo({ top: 0 });
    const d = deal(m, st, ctx);
    setHistory([]);
    setOrigin(null);
    setWhy(false);
    setButton(d.button);
    show(d.s);
  }

  function switchMode(m: PlayMode) {
    if (m === mode) return;
    settingsStore.set((x) => ({ ...x, playMode: m }));
    newHand(stage, m);
  }

  function choose(key: string) {
    if (loading) return;
    const m = moves.find((x) => x.key === key);
    if (!m) return;
    const next = heroAct(s, m, ctx);
    const d = next.decisions[next.decisions.length - 1];
    if (d.grade !== "info" && !s.replay) recordAnswer(["play", `play:${s.stageId}`, ...tableKeys(d, s.stageId)], d.grade !== "mistake");
    setHistory((h) => [...h, s]);
    show(next);
  }

  function replay(k: number) {
    const at = history[k];
    if (!at) return;
    token.current++;
    if (!origin) setOrigin({ s, history });
    setHistory(history.slice(0, k));
    setWhy(false);
    // Through runBots: a solver pack file dropped from the cache since then is asked for again (s.needs).
    setS(runBots({ ...at, needs: undefined, replay: true }, ctx));
    // The replayed spot starts at the top (the banner, then the table), not mid-page where the summary was.
    window.scrollTo({ top: 0 });
  }

  function backToOrigin() {
    if (!origin) return;
    token.current++;
    setS(origin.s);
    setHistory(origin.history);
    setOrigin(null);
  }

  function review() {
    coach.open({
      id: `play:${s.heroIdx}:${g.log.length}:${hero.hole.join("-")}:${g.board.join("-")}${s.replay ? ":r" : ""}`,
      title: `핸드 리뷰 · ${hero.seat} ${hero.hole.map(cardLabel).join("")}`,
      facts: reviewFacts(s),
      defaultQuestion: "이 핸드를 스트리트별로 리뷰해줘. 잘한 결정과 아쉬운 결정, 그리고 다음에 기억할 점을 정리해줘.",
    });
  }

  const feat = g.board.length ? handFeatures(hero.hole, g.board) : null;
  const net = g.done ? heroNet(g) : null;
  const verdict = handVerdict(s.decisions);
  // The headline names what it graded; 참고 decisions are counted beside it (tableVerdict).
  const tv = tableVerdict(s.decisions, net);
  // "· 쇼다운" only when I was at the showdown, not when bots showed down after I folded.
  const chips = chipResult(net ?? 0, g.showdown && !hero.folded);
  const miss = missLine(s.decisions);
  const sessionText = session.hands >= 2 ? sessionLine(session) : null;
  const opponents = n - 1;
  const src0 = sourceLine(s);
  const last = s.decisions[s.decisions.length - 1];
  const btnIdx = g.players.findIndex((p) => p.seat === "BTN");
  const packText = packs ? packListText(packs) : packsFailed ? "솔버 팩 목록을 못 불러왔어요 · 다음 헤즈업 플랍에서 다시 시도 (인터넷 필요)" : "솔버 팩 목록 불러오는 중… (솔버 팩은 인터넷 필요)";
  // 바로 채점: my last decision's mark, at the top of the action card where the eyes are after a tap.
  const instantLine =
    table.instant && !g.done && last ? (
      <div className={`instant-line small ${last.grade}`}>
        <b>
          {GRADE_MARK[last.grade]} {STREET_LABEL[last.street]} {last.chosenLabel}
        </b>{" "}
        · {referenceLine(last)}
      </div>
    ) : null;

  return (
    <div className="page">
      <div className="seg small">
        <button className={mode === "pub" ? "on" : ""} onClick={() => switchMode("pub")}>
          펍 토너먼트 9인
        </button>
        <button className={mode === "cash" ? "on" : ""} onClick={() => switchMode("cash")}>
          캐시 6맥스
        </button>
      </div>
      <div className="filters">
        {mode === "pub" ? (
          <select
            className="select"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              newHand(e.target.value);
            }}
          >
            {PLAY_STAGES.map((st) => (
              <option key={st.id} value={st.id}>
                {st.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small cash-note">6맥스 · 모두 100bb · 앤티 없음</span>
        )}
        <button className={`ghost ${setup ? "on" : ""}`} onClick={() => setSetup(!setup)} aria-label={`테이블 설정 · ${mixText(table.seats.slice(0, opponents))}`}>
          테이블
        </button>
        <button className="ghost" onClick={() => newHand()}>
          새 핸드
        </button>
      </div>
      {setup && (
        <TableSetup
          opponents={opponents}
          mode={mode}
          posOf={(k) => g.players[engineIndex(k, button, n)]?.seat ?? ""}
          packText={packText}
          onClose={() => setSetup(false)}
        />
      )}

      {s.replay && (
        <div className="notice replay-banner small">
          <span>다시 이 상황 · 같은 카드 · 기록 안 남아요</span>
          {origin && (
            <button className="ghost small-btn" onClick={backToOrigin}>
              원래 핸드로
            </button>
          )}
        </div>
      )}

      <section className="card-box">
        <div className="seats9">
          {g.players.map((p, i) => {
            const streetAct = [...g.log].reverse().find((e) => e.idx === i && e.street === g.street && e.kind !== "post");
            const reveal = p.hero || (g.showdown && !p.folded);
            const prof = s.profiles?.[i];
            return (
              <div
                key={p.seat}
                className={`seat9 ${p.hero ? "hero" : ""} ${p.folded ? "out" : ""} ${g.toAct === i ? "acting" : ""}`}
                title={p.hero ? undefined : `${physicalSeat(i, button, n)}번 자리`}
              >
                <div className="seat9-top">
                  <b>
                    {p.seat}
                    {i === btnIdx && <i className="dchip">D</i>}
                  </b>
                  <span>{r1(p.stack)}</span>
                </div>
                <div className="seat9-cards">
                  {p.folded ? <span className="muted small">폴드</span> : reveal ? <CardRow cards={p.hole} size="sm" /> : <span className="card-back">🂠🂠</span>}
                  {!p.hero && s.profiles && <i className={badgeClass(prof)}>{badgeOf(prof)}</i>}
                </div>
                <div className="seat9-act">
                  {p.streetBet > 0 ? `${r1(p.streetBet)}bb` : ""}
                  {streetAct?.kind === "check" ? "체크" : ""}
                  {p.allIn ? " 올인" : ""}
                </div>
              </div>
            );
          })}
        </div>

        <div className="board-row">
          <div>
            <div className="muted small">{STREET_LABEL[g.street]}</div>
            {g.board.length ? <CardRow cards={g.board} /> : <span className="muted small">보드 없음</span>}
          </div>
          <div className="pot">
            <span className="muted small">팟</span>
            <b>{r1(potNow)}bb</b>
          </div>
        </div>
        {src0 && (
          <div className="source-line muted small">
            <span className="source-text">{src0.text}</span>
            {src0.why && src0.why.length > 0 && (
              <button className="link-btn" onClick={() => setWhy(!why)} aria-expanded={why}>
                왜?
              </button>
            )}
          </div>
        )}
        {why && src0?.why && <div className="muted small source-why">{src0.why.join(" · ")}</div>}
        {feat && !g.done && <div className="muted small center">내 패: {feat.label}</div>}
      </section>

      {heroTurn && (
        <section className="card-box">
          <div className="row-between small">
            <span>
              {hero.seat} 차례 · 팟 {r1(potNow)}
              {call > 0 ? ` · 콜 ${r1(call)} (필요 에퀴티 ${pct(callPrice(g, s.heroIdx))}${winnablePot(g, s.heroIdx) < potNow - 0.05 ? ", 내 스택을 넘는 칩 제외" : ""})` : ""}
            </span>
            <label className="hint-toggle">
              <input type="checkbox" checked={hint} onChange={(e) => setHint(e.target.checked)} /> 힌트
            </label>
          </div>
          {hint && <div className="muted small">상대 추정 레인지 대비 내 에퀴티: {pct(hintEq)}</div>}
          {instantLine}
          {loading && <div className="muted small">솔버 팩 여는 중…</div>}
          <div className="play-actions" ref={actionsRef}>
            {moves.map((m) => (
              <button key={m.key} className={`action ${m.kind}`} disabled={loading} onClick={() => choose(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
          <label className="hint-toggle small instant-toggle">
            <input type="checkbox" checked={!!table.instant} onChange={(e) => updateTable((t) => ({ ...t, instant: e.target.checked || undefined }))} /> 바로 채점
          </label>
        </section>
      )}

      {!heroTurn && instantLine}

      {!heroTurn && !g.done && loading && <div className="muted small center">솔버 팩 여는 중…</div>}

      {g.done && (
        <section className={`card-box result ${verdict.cls}`}>
          <div className="row-gap">
            <button className="primary next-btn" onClick={() => newHand()}>
              다음 핸드 →
            </button>
            <button className="ghost" onClick={review}>
              AI 핸드 리뷰
            </button>
          </div>
          <strong className="verdict-head">{tv.headline}</strong>
          <div className="verdict-lines">
            <div>
              결과 <b className={`net ${chips.tone}`}>{chips.amount}</b>
              {chips.showdown ? " · 쇼다운" : ""}
            </div>
            {miss && <div>{miss}</div>}
            {tv.scope && <div className="muted small">{tv.scope}</div>}
          </div>
          {tv.notes.map((x) => (
            <div key={x} className="verdict-note">
              {x}
            </div>
          ))}

          {s.decisions.length > 0 && <HandSummary key={`${g.log.length}:${s.decisions.length}:${s.replay ? 1 : 0}:${hero.hole.join("-")}`} decisions={s.decisions} onReplay={replay} />}

          {g.showdown && (
            <div className="small">
              {g.players
                .filter((p) => !p.folded)
                .map((p) => (
                  <div key={p.seat}>
                    {p.seat}: <CardRow cards={p.hole} size="sm" />
                  </div>
                ))}
            </div>
          )}

          {sessionText && <div className="verdict-session muted small">{sessionText}</div>}
        </section>
      )}

      {(["preflop", "flop", "turn", "river"] as Street[]).some((st) => streetLog(s, st)) && (
        <section className="card-box small">
          {(["preflop", "flop", "turn", "river"] as Street[]).map((st) => {
            const text = streetLog(s, st);
            return text ? (
              <div key={st}>
                <b>{STREET_LABEL[st]}</b> {text}
              </div>
            ) : null;
          })}
          <div className="muted small src-legend">{srcLegend(mode)}</div>
        </section>
      )}

      <p className="muted small disclaimer">
        {BOT_TEXT} {mode === "cash" ? `${CASH_NOTE} ` : ""}프리플랍은 GTO 차트로 채점하고(칩EV, ICM 미반영), 헤즈업 플랍은 맞는 솔버 팩으로
        채점해요. 그 밖의 결정(멀티웨이, 턴·리버, 팩 없는 팟)은 이 AI들 기준 EV를 참고로만 보여줘요. 성향 조절은 차트를 넓히고 좁히는 근사 모델이에요.
      </p>
    </div>
  );
}

function withHand(t: SessionTotals, hand: PlayState): SessionTotals {
  const { graded, mistakes } = handVerdict(hand.decisions);
  return addHand(t, { net: heroNet(hand.game), graded, mistakes });
}
