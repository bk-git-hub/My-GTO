import { useState } from "react";
import { CardRow } from "../../components/Cards";
import { describeStrategy } from "../../components/FreqBar";
import { RangeGrid } from "../../components/RangeGrid";
import { SeatRow } from "../../components/SetPicker";
import { getSet } from "../../data/charts";
import { cardLabel } from "../../poker/cards";
import { accuracy, recordAnswer, useStats } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";
import {
  QUIZ_ACTIONS,
  generateStackQuestion,
  gradeStack,
  type QuizAction,
  type StackQuestion,
} from "./stackQuiz";

const SET = getSet("yajasu");
const SEATS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB"];
const GRADE_TEXT = { correct: "정답", mixed: "부분 정답 (혼합 빈도)", wrong: "오답" } as const;
const fmt = (n: number) => n.toLocaleString("ko-KR");
const bbOf = (chips: number, bb: number) => {
  const v = chips / bb;
  return v >= 20 ? Math.round(v).toString() : v.toFixed(1);
};

/** Open / fold / shove drill for the pub tournament ranges, with stack context. */
export function StackQuiz() {
  const [stage, setStage] = useState("all");
  const [seat, setSeat] = useState("all");
  const [q, setQ] = useState<StackQuestion>(() => generateStackQuestion("all", "all"));
  const [picked, setPicked] = useState<QuizAction | null>(null);
  const stats = useStats();
  const coach = useCoach();

  const result = picked ? gradeStack(q, picked) : null;
  const st = SET.stages.find((s) => s.id === q.stageId)!;

  function next(stageF = stage, seatF = seat) {
    setQ(generateStackQuestion(stageF, seatF));
    setPicked(null);
  }

  function answer(a: QuizAction) {
    if (picked) return;
    setPicked(a);
    const { grade } = gradeStack(q, a);
    recordAnswer(["stack", `stack:${q.stageId}`, `stack:${q.stageId}:${q.scenario.hero}`], grade !== "wrong");
  }

  function askCoach() {
    if (!picked || !result) return;
    coach.open({
      id: `stack:${q.uid}`,
      title: `${q.scenario.title} · ${q.hand}`,
      facts: [
        `게임: ${SET.game}`,
        `블라인드: Lv${q.level} ${fmt(q.sb)}/${fmt(q.bb)} (BB 앤티 ${fmt(q.bb)})`,
        `내 스택: ${fmt(q.myChips)} (${bbOf(q.myChips, q.bb)}bb), 평균 스택: ${fmt(q.avgChips)} (${bbOf(q.avgChips, q.bb)}bb)`,
        `포지션: ${q.scenario.hero} (RFI)`,
        `핸드: ${q.cards.map(cardLabel).join(" ")} (${q.hand})`,
        `적용 차트: ${st.label} (${st.stack}) ${q.scenario.title}`,
        `차트 빈도: ${describeStrategy(q.scenario, q.scenario.strategy[q.hand])}`,
        `이 자리 레인지: ${q.scenario.actions.map((a) => `${a.label} = ${a.range}`).join(" / ")}`,
        `사용자의 선택: ${QUIZ_ACTIONS.find((x) => x.key === picked)!.label} → ${GRADE_TEXT[result.grade]}`,
        `차트 출처: ${SET.source}`,
      ].join("\n"),
      defaultQuestion:
        result.grade === "correct"
          ? "맞혔는데, 이 스택과 자리에서 이 레인지를 외우는 요령을 알려줘."
          : "왜 틀렸는지, 이 스택에서 이 자리 레인지가 왜 이렇게 되는지 설명해줘.",
    });
  }

  const keyStats = stats.byKey[`stack:${q.stageId}:${q.scenario.hero}`];
  return (
    <>
      <div className="filters">
        <select
          className="select"
          value={stage}
          onChange={(e) => {
            setStage(e.target.value);
            next(e.target.value, seat);
          }}
        >
          <option value="all">모든 스택</option>
          {SET.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} · {accuracy(stats.byKey[`stack:${s.id}`])}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={seat}
          onChange={(e) => {
            setSeat(e.target.value);
            next(stage, e.target.value);
          }}
        >
          <option value="all">모든 자리</option>
          {SEATS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <section className="card-box quiz">
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
        <SeatRow positions={SET.positions} hero={q.scenario.hero} villains={[]} />
        <div className="center">
          <CardRow cards={q.cards} size="lg" />
          <div className="muted small">{q.hand}</div>
        </div>

        <div className="actions">
          {QUIZ_ACTIONS.map((a) => (
            <button
              key={a.key}
              className={`action ${a.key} ${picked === a.key ? "picked" : ""}`}
              style={a.key === "open" ? { borderColor: "var(--raise)" } : a.key === "shove" ? { borderColor: "var(--allin)" } : undefined}
              disabled={!!picked}
              onClick={() => answer(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        {picked && result && (
          <div className={`result ${result.grade}`}>
            <strong>
              {GRADE_TEXT[result.grade]} — 오픈 {Math.round(result.freqs.open * 100)}% · 올인{" "}
              {Math.round(result.freqs.shove * 100)}% · 폴드 {Math.round(result.freqs.fold * 100)}%
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
            <div className="row-gap">
              <button className="primary" onClick={askCoach}>
                AI 해설
              </button>
              <button className="ghost" onClick={() => next()}>
                다음 →
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
