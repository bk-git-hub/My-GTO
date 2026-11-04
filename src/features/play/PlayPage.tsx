import { useMemo, useState } from "react";
import { CardRow } from "../../components/Cards";
import { getSet } from "../../data/charts";
import { cardLabel, handClassOf } from "../../poker/cards";
import { equityVs } from "../../play/analysis";
import { heroNet, pot, toCall, type Game, type LogEntry, type Street } from "../../play/engine";
import { handFeatures } from "../../play/handInfo";
import { MODE_SET, STAGE_STACK, type PlayMode } from "../../play/policy";
import { heroAct, heroMoves, startHand, type Decision, type PlayState } from "../../play/table";
import { settingsStore, useSettings } from "../../state/settings";
import { recordAnswer } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";

const PUB_SET = getSet("pub");
/** How each mode's bots play, for the page note and the AI review. */
const BOT_TEXT: Record<PlayMode, string> = {
  pub: "상대는 펍아재 봇이에요. 프리플랍은 펍 토너먼트 차트, 플랍 이후는 패 강도 규칙(콜 많고 블러프 적은 펍 성향)으로 쳐요.",
  cash: "상대는 레귤러 봇이에요. 프리플랍은 6맥스 100bb 근사 GTO 차트, 플랍 이후는 패 강도 규칙(c벳·세미블러프가 많고 약한 패는 잘 접는 성향)으로 쳐요.",
};
const STREET_LABEL: Record<Street, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };
const GRADE_TEXT = { good: "좋은 선택", ok: "괜찮음", mistake: "실수", info: "참고" } as const;
const ACT_TEXT: Record<string, string> = { fold: "폴드", check: "체크", call: "콜", bet: "벳", raise: "레이즈", post: "블라인드" };
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);

function entryText(e: LogEntry): string {
  if (e.kind === "post") return `${e.seat} ${e.amount}`;
  if (e.kind === "fold" || e.kind === "check") return `${e.seat} ${ACT_TEXT[e.kind]}`;
  return `${e.seat} ${ACT_TEXT[e.kind]} ${r1(e.amount)}${e.allIn ? " 올인" : ""}`;
}

function streetLog(g: Game, street: Street): string {
  return g.log
    .filter((e) => e.street === street && e.kind !== "post" && !(e.kind === "fold" && street === "preflop" && !g.players[e.idx].hero))
    .map(entryText)
    .join(", ");
}

/** Plain-text hand history + decision analysis for the AI review. */
function reviewFacts(s: PlayState): string {
  const g = s.game;
  const set = getSet(MODE_SET[s.mode]);
  const stage = set.stages.find((x) => x.id === s.stageId)!;
  const hero = g.players[s.heroIdx];
  const lines = [
    `게임: ${set.game}`,
    s.mode === "cash"
      ? `스택: 모두 ${g.startStack}bb, 블라인드 0.5/1bb, 앤티 없음, ${g.players.length}인`
      : `스택 구간: ${stage.label} (모두 ${g.startStack}bb 시작, BB 앤티 1bb)`,
    `내 자리: ${hero.seat}, 내 핸드: ${hero.hole.map(cardLabel).join(" ")} (${handClassOf(hero.hole[0], hero.hole[1])})`,
    `상대 봇: ${BOT_TEXT[s.mode]} 솔버 아님.`,
  ];
  for (const st of ["preflop", "flop", "turn", "river"] as Street[]) {
    const acts = g.log.filter((e) => e.street === st && e.kind !== "post");
    if (!acts.length) continue;
    const boardN = st === "flop" ? 3 : st === "turn" ? 4 : st === "river" ? 5 : 0;
    const board = boardN ? ` [보드 ${g.board.slice(0, boardN).map(cardLabel).join(" ")}]` : "";
    lines.push(`${STREET_LABEL[st]}${board}: ${acts.map(entryText).join(", ")}`);
  }
  lines.push("", "내 결정 분석 (상대 레인지는 봇 규칙으로 좁힌 추정치, EV는 현재 스트리트 기준 근사):");
  for (const d of s.decisions) {
    lines.push(
      `- ${STREET_LABEL[d.street]} 팟 ${r1(d.pot)}bb, 콜 금액 ${r1(d.toCall)}bb, 필요 에퀴티 ${pct(d.reqEquity)}, 내 에퀴티 ${pct(d.equity)}, SPR ${r1(d.spr)} → 선택: ${d.chosenLabel} [${GRADE_TEXT[d.grade]}] ${d.summary}`,
    );
    if (d.chart) lines.push(`  차트: ${d.chart}`);
    const evs = d.options.filter((o) => o.ev !== null).map((o) => `${o.label} ${o.ev! >= 0 ? "+" : ""}${o.ev}bb`);
    if (evs.length) lines.push(`  선택지 EV: ${evs.join(", ")}`);
    for (const v of d.villains) if (v.breakdown) lines.push(`  ${v.seat} 추정 레인지: ${v.breakdown}`);
  }
  const net = heroNet(g);
  const shown = g.showdown
    ? g.players.filter((p) => !p.folded).map((p) => `${p.seat} ${p.hole.map(cardLabel).join(" ")}`).join(", ")
    : "쇼다운 없음";
  lines.push("", `결과: ${net >= 0 ? "+" : ""}${net}bb · ${shown}`);
  return lines.join("\n");
}

export function PlayPage() {
  const { playMode: mode } = useSettings();
  const [stage, setStage] = useState("deep");
  const [s, setS] = useState<PlayState>(() => startHand(mode, "deep"));
  const [hint, setHint] = useState(false);
  const coach = useCoach();
  const g = s.game;
  const hero = g.players[s.heroIdx];
  const moves = heroMoves(s);
  const last = s.decisions[s.decisions.length - 1];
  const heroTurn = !g.done && g.toAct === s.heroIdx;
  const call = heroTurn ? toCall(g, s.heroIdx) : 0;
  const potNow = pot(g);

  const hintEq = useMemo(() => {
    if (!hint || !heroTurn) return null;
    const acted = new Set(g.log.filter((e) => e.kind === "call" || e.kind === "raise" || e.kind === "bet").map((e) => e.idx));
    const opp = g.players
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i !== s.heroIdx && !p.folded && (g.street !== "preflop" || acted.has(i)));
    if (!opp.length) return null;
    return equityVs(hero.hole, g.board, opp.map(({ i }) => s.ranges[i]), 2000);
  }, [hint, heroTurn, s, g, hero.hole]);

  function newHand(st = stage, m = mode) {
    setS(startHand(m, st));
  }

  function switchMode(m: PlayMode) {
    if (m === mode) return;
    settingsStore.set((x) => ({ ...x, playMode: m }));
    newHand(stage, m);
  }

  function choose(key: string) {
    const m = moves.find((x) => x.key === key);
    if (!m) return;
    const next = heroAct(s, m);
    const d = next.decisions[next.decisions.length - 1];
    if (d.grade !== "info") recordAnswer(["play", `play:${s.stageId}`], d.grade !== "mistake");
    setS(next);
  }

  function review() {
    coach.open({
      id: `play:${s.heroIdx}:${g.log.length}:${hero.hole.join("-")}:${g.board.join("-")}`,
      title: `핸드 리뷰 · ${hero.seat} ${hero.hole.map(cardLabel).join("")}`,
      facts: reviewFacts(s),
      defaultQuestion: "이 핸드를 스트리트별로 리뷰해줘. 잘한 결정과 아쉬운 결정, 그리고 다음에 기억할 점을 정리해줘.",
    });
  }

  const feat = g.board.length ? handFeatures(hero.hole, g.board) : null;
  const net = g.done ? heroNet(g) : null;

  return (
    <div className="page">
      <div className="seg small">
        <button className={mode === "pub" ? "on" : ""} onClick={() => switchMode("pub")}>
          펍아재 (9인 토너먼트)
        </button>
        <button className={mode === "cash" ? "on" : ""} onClick={() => switchMode("cash")}>
          100bb 캐시 (6맥스)
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
            {PUB_SET.stages.map((st) => (
              <option key={st.id} value={st.id}>
                {st.label} · {STAGE_STACK[st.id]}bb
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small">6맥스 · 모두 100bb · 앤티 없음</span>
        )}
        <button className="ghost" onClick={() => newHand()}>
          새 핸드
        </button>
      </div>

      <section className="card-box">
        <div className="seats9">
          {g.players.map((p, i) => {
            const streetAct = [...g.log].reverse().find((e) => e.idx === i && e.street === g.street && e.kind !== "post");
            const reveal = p.hero || (g.showdown && !p.folded);
            return (
              <div
                key={p.seat}
                className={`seat9 ${p.hero ? "hero" : ""} ${p.folded ? "out" : ""} ${g.toAct === i ? "acting" : ""}`}
              >
                <div className="seat9-top">
                  <b>{p.seat}</b>
                  <span>{r1(p.stack)}</span>
                </div>
                <div className="seat9-cards">
                  {p.folded ? <span className="muted small">폴드</span> : reveal ? <CardRow cards={p.hole} size="sm" /> : <span className="card-back">🂠🂠</span>}
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
        {feat && !g.done && <div className="muted small center">내 패: {feat.label}</div>}
      </section>

      {heroTurn && (
        <section className="card-box">
          <div className="row-between small">
            <span>
              {hero.seat} 차례 · 팟 {r1(potNow)}
              {call > 0 ? ` · 콜 ${r1(call)} (필요 에퀴티 ${pct(call / (potNow + call))})` : ""}
            </span>
            <label className="hint-toggle">
              <input type="checkbox" checked={hint} onChange={(e) => setHint(e.target.checked)} /> 힌트
            </label>
          </div>
          {hint && <div className="muted small">상대 추정 레인지 대비 내 에퀴티: {pct(hintEq)}</div>}
          <div className="play-actions">
            {moves.map((m) => (
              <button key={m.key} className={`action ${m.kind}`} onClick={() => choose(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {g.done && (
        <section className={`card-box result ${net! > 0 ? "correct" : net! < 0 ? "wrong" : ""}`}>
          <div className="row-gap">
            <button className="primary next-btn" onClick={() => newHand()}>
              다음 핸드 →
            </button>
            <button className="ghost" onClick={review}>
              AI 핸드 리뷰
            </button>
          </div>
          <strong>
            {net! > 0 ? `+${net}bb 이겼어요` : net! < 0 ? `${net}bb 졌어요` : "본전"}
            {g.showdown ? " · 쇼다운" : ""}
          </strong>
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

      {last && <DecisionCard d={last} />}

          <div className="small">
            내 결정 {s.decisions.length}개:{" "}
            {s.decisions.map((d, i) => (
              <span key={i} className={`grade-chip ${d.grade}`}>
                {STREET_LABEL[d.street]} {d.chosenLabel} · {GRADE_TEXT[d.grade]}
              </span>
            ))}
          </div>

        </section>
      )}

      {(["preflop", "flop", "turn", "river"] as Street[]).some((st) => streetLog(g, st)) && (
        <section className="card-box small">
          {(["preflop", "flop", "turn", "river"] as Street[]).map((st) => {
            const text = streetLog(g, st);
            return text ? (
              <div key={st}>
                <b>{STREET_LABEL[st]}</b> {text}
              </div>
            ) : null;
          })}
        </section>
      )}

      <p className="muted small disclaimer">
        {BOT_TEXT[mode]} 채점은 이 봇 규칙으로 좁힌 상대 레인지 기준 EV이고 솔버 답이 아니에요. 체크 EV는 끝까지 체크다운한다고 가정한
        근사예요.
      </p>
    </div>
  );
}

function DecisionCard({ d }: { d: Decision }) {
  const cls = d.grade === "good" ? "correct" : d.grade === "ok" ? "mixed" : d.grade === "mistake" ? "wrong" : "";
  const evs = d.options.filter((o) => o.ev !== null);
  return (
    <section className={`card-box result ${cls}`}>
      <strong>
        {STREET_LABEL[d.street]} · {d.chosenLabel} → {GRADE_TEXT[d.grade]}
      </strong>
      <div className="small">{d.summary}</div>
      {d.chart && <div className="muted small">차트: {d.chart}</div>}
      {evs.length > 0 && (
        <table className="facts">
          <tbody>
            {evs
              .slice()
              .sort((a, b) => b.ev! - a.ev!)
              .map((o) => (
                <tr key={o.key} className={o.key === d.chosen ? "mine" : ""}>
                  <th>{o.label}</th>
                  <td>
                    {o.ev! >= 0 ? "+" : ""}
                    {o.ev}bb
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <div className="muted small">
        팟 {r1(d.pot)} · 콜 {r1(d.toCall)} · 필요 에퀴티 {pct(d.reqEquity)} · 내 에퀴티 {pct(d.equity)} · SPR {r1(d.spr)}
      </div>
      {d.villains.map((v) => (
        <div key={v.seat} className="muted small">
          {v.seat} 추정 레인지 {Math.round(v.share * 100)}%{v.breakdown ? ` · ${v.breakdown}` : ""}
        </div>
      ))}
    </section>
  );
}
