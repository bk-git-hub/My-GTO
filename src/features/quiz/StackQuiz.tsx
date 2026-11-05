import { useState } from "react";
import { CardRow } from "../../components/Cards";
import { describeStrategy } from "../../components/FreqBar";
import { RangeGrid } from "../../components/RangeGrid";
import { SeatRow } from "../../components/SetPicker";
import { getSet } from "../../data/charts";
import { cardLabel } from "../../poker/cards";
import { recordQuiz } from "../../state/attempts";
import { accuracy, useStats } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";
import {
  QUIZ_ACTIONS,
  generateStackQuestion,
  gradeStack,
  statPrefix,
  type DrillMode,
  type QuizAction,
  type StackQuestion,
} from "./stackQuiz";

const SETS = { pub: getSet("pub"), cash: getSet("cash6") };
const SEATS: Record<DrillMode, string[]> = {
  pub: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB"],
  cash: ["UTG", "HJ", "CO", "BTN", "SB"],
};
const GRADE_TEXT = { correct: "정답", mixed: "부분 정답 (혼합 빈도)", wrong: "오답" } as const;
const fmt = (n: number) => n.toLocaleString("ko-KR");
const bbOf = (chips: number, bb: number) => {
  const v = chips / bb;
  return v >= 20 ? Math.round(v).toString() : v.toFixed(1);
};

/** Open / fold / shove drill: 펍아재 tournament stacks or 6-max 100bb cash. */
export function StackQuiz({
  initialMode = "pub",
  initialStage = "all",
  initialSeat = "all",
}: {
  initialMode?: DrillMode;
  initialStage?: string;
  initialSeat?: string;
}) {
  const [mode, setMode] = useState<DrillMode>(initialMode);
  const [stage, setStage] = useState(initialStage);
  const [seat, setSeat] = useState(initialSeat);
  const [q, setQ] = useState<StackQuestion>(() => generateStackQuestion(initialStage, initialSeat, initialMode));
  const [picked, setPicked] = useState<QuizAction | null>(null);
  const stats = useStats();
  const coach = useCoach();

  const set = SETS[q.mode];
  const prefix = statPrefix(q.mode);
  const result = picked ? gradeStack(q, picked) : null;
  const st = set.stages.find((s) => s.id === q.stageId)!;
  const actions = q.mode === "cash" ? QUIZ_ACTIONS.filter((a) => a.key !== "shove") : QUIZ_ACTIONS;

  function next(m = mode, stageF = stage, seatF = seat) {
    setQ(generateStackQuestion(stageF, seatF, m));
    setPicked(null);
  }

  function switchMode(m: DrillMode) {
    setMode(m);
    setStage("all");
    setSeat("all");
    next(m, "all", "all");
  }

  function answer(a: QuizAction) {
    if (picked) return;
    setPicked(a);
    const { grade, freqs } = gradeStack(q, a);
    const label = (k: QuizAction) => QUIZ_ACTIONS.find((x) => x.key === k)!.label;
    const offered = actions.map((x) => x.key);
    const bestKey = offered.reduce((b, k) => (freqs[k] > freqs[b] ? k : b), offered[0]);
    const freqText = offered.map((k) => `${label(k)} ${Math.round(freqs[k] * 100)}%`).join(" · ");
    const where = q.mode === "pub" ? `펍 ${st.label}` : "100bb 캐시";
    recordQuiz({
      kind: "stack",
      keys: [prefix, `${prefix}:${q.stageId}`, `${prefix}:${q.stageId}:${q.scenario.hero}`, `${prefix}:seat:${q.scenario.hero}`],
      spot: `stack:${q.mode}:${q.stageId}:${q.scenario.hero}:${q.hand}`,
      title: `${where} · ${q.scenario.hero} · ${q.hand}`,
      chosen: `${label(a)} (${Math.round(freqs[a] * 100)}%)`,
      correct: `${label(bestKey)} (${Math.round(freqs[bestKey] * 100)}%)`,
      grade,
      detail: [
        `게임: ${set.game}`,
        q.mode === "cash"
          ? "스택: 100bb"
          : `블라인드: Lv${q.level} ${fmt(q.sb)}/${fmt(q.bb)} (BB 앤티 ${fmt(q.bb)}), 내 스택 ${fmt(q.myChips)} (${bbOf(q.myChips, q.bb)}bb), 평균 ${fmt(q.avgChips)} (${bbOf(q.avgChips, q.bb)}bb)`,
        `포지션: ${q.scenario.hero} (RFI)`,
        `핸드: ${q.cards.map(cardLabel).join(" ")} (${q.hand})`,
        `적용 차트: ${st.label} (${st.stack}) ${q.scenario.title}`,
        `차트 빈도: ${freqText}`,
      ].join("\n"),
    });
  }

  function askCoach() {
    if (!picked || !result) return;
    const context =
      q.mode === "cash"
        ? [`게임: ${set.game}`, `스택: 100bb`]
        : [
            `게임: ${set.game}`,
            `블라인드: Lv${q.level} ${fmt(q.sb)}/${fmt(q.bb)} (BB 앤티 ${fmt(q.bb)})`,
            `내 스택: ${fmt(q.myChips)} (${bbOf(q.myChips, q.bb)}bb), 평균 스택: ${fmt(q.avgChips)} (${bbOf(q.avgChips, q.bb)}bb)`,
          ];
    coach.open({
      id: `stack:${q.uid}`,
      title: `${q.scenario.title} · ${q.hand}`,
      facts: [
        ...context,
        `포지션: ${q.scenario.hero} (RFI)`,
        `핸드: ${q.cards.map(cardLabel).join(" ")} (${q.hand})`,
        `적용 차트: ${st.label} (${st.stack}) ${q.scenario.title}`,
        `차트 빈도: ${describeStrategy(q.scenario, q.scenario.strategy[q.hand])}`,
        `이 자리 레인지: ${q.scenario.actions.map((a) => `${a.label} = ${a.range}`).join(" / ")}`,
        `사용자의 선택: ${QUIZ_ACTIONS.find((x) => x.key === picked)!.label} → ${GRADE_TEXT[result.grade]}`,
        `차트 출처: ${set.source}`,
      ].join("\n"),
      defaultQuestion:
        result.grade === "correct"
          ? "맞혔는데, 이 자리 레인지를 외우는 요령을 알려줘."
          : "왜 틀렸는지, 이 자리 레인지가 왜 이렇게 되는지 설명해줘.",
    });
  }

  const keyStats = stats.byKey[`${prefix}:${q.stageId}:${q.scenario.hero}`];
  return (
    <>
      <div className="seg small">
        <button className={mode === "pub" ? "on" : ""} onClick={() => switchMode("pub")}>
          펍아재 (토너먼트)
        </button>
        <button className={mode === "cash" ? "on" : ""} onClick={() => switchMode("cash")}>
          100bb 캐시
        </button>
      </div>

      <div className="filters">
        {mode === "pub" && (
          <select
            className="select"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              next(mode, e.target.value, seat);
            }}
          >
            <option value="all">모든 스택</option>
            {SETS.pub.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {accuracy(stats.byKey[`stack:${s.id}`])}
              </option>
            ))}
          </select>
        )}
        <select
          className="select"
          value={seat}
          onChange={(e) => {
            setSeat(e.target.value);
            next(mode, stage, e.target.value);
          }}
        >
          <option value="all">모든 자리</option>
          {SEATS[mode].map((p) => (
            <option key={p} value={p}>
              {p} · {accuracy(stats.byKey[stage === "all" ? `${statPrefix(mode)}:seat:${p}` : `${statPrefix(mode)}:${stage}:${p}`])}
            </option>
          ))}
        </select>
      </div>

      <section className="card-box quiz">
        {q.mode === "pub" ? (
          <div className="stack-info">
            <div>
              <span>Lv{q.level} 블라인드</span>
              <b>
                {fmt(q.sb)}/{fmt(q.bb)}
              </b>
              <span>앤티 {fmt(q.bb)}</span>
            </div>
            <div>
              <span>내 스택</span>
              <b>{bbOf(q.myChips, q.bb)}bb</b>
              <span>{fmt(q.myChips)}</span>
            </div>
            <div>
              <span>평균 스택</span>
              <b>{bbOf(q.avgChips, q.bb)}bb</b>
              <span>{fmt(q.avgChips)}</span>
            </div>
          </div>
        ) : (
          <div className="stack-info">
            <div>
              <span>게임</span>
              <b>6맥스 캐시</b>
              <span>앤티 없음</span>
            </div>
            <div>
              <span>내 스택</span>
              <b>100bb</b>
              <span>유효 스택</span>
            </div>
            <div>
              <span>오픈 사이즈</span>
              <b>2.5bb</b>
              <span>SB 3bb</span>
            </div>
          </div>
        )}
        <SeatRow positions={set.positions} hero={q.scenario.hero} villains={[]} />
        <div className="center">
          <CardRow cards={q.cards} size="lg" />
          <div className="muted small">{q.hand}</div>
        </div>

        <div className="actions">
          {actions.map((a) => (
            <button
              key={a.key}
              className={`action ${a.key} ${picked === a.key ? "picked" : ""}`}
              disabled={!!picked}
              onClick={() => answer(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        {picked && result && (
          <div className={`result ${result.grade}`}>
            <div className="row-gap">
              <button className="primary next-btn" onClick={() => next()}>
                다음 문제 →
              </button>
              <button className="ghost" onClick={askCoach}>
                AI 해설
              </button>
            </div>
            <strong>
              {GRADE_TEXT[result.grade]} — 오픈 {Math.round(result.freqs.open * 100)}%
              {q.mode === "pub" ? ` · 올인 ${Math.round(result.freqs.shove * 100)}%` : ""} · 폴드{" "}
              {Math.round(result.freqs.fold * 100)}%
            </strong>
            <div className="muted small">
              적용: {st.label}({st.stack}) {q.scenario.title} · 이 자리 정답률 {accuracy(keyStats)}
            </div>
            <div className="range-text">
              {q.scenario.actions.map((a) => (
                <div key={a.key}>
                  <b>{a.label}</b> <code>{a.range}</code>
                </div>
              ))}
              {q.scenario.actions.length > 1 && <span className="muted">겹치는 핸드는 위 줄이 우선이에요.</span>}
            </div>
            <RangeGrid scenario={q.scenario} selected={q.hand} compact />
          </div>
        )}
      </section>
    </>
  );
}
