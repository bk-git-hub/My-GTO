import { useState } from "react";
import { CardRow } from "../../components/Cards";
import { Choices } from "../../components/Choice";
import { describeStrategy, FreqBar, actionColor } from "../../components/FreqBar";
import { SeatRow, SetPicker } from "../../components/SetPicker";
import { getSet, scenarioActions } from "../../data/charts";
import { cardLabel } from "../../poker/cards";
import { useSettings } from "../../state/settings";
import { accuracy, recordAnswer, useStats } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";
import { StackQuiz } from "./StackQuiz";
import {
  generateEquity,
  generateOdds,
  generatePreflop,
  gradePreflop,
  type Grade,
  type MCQuestion,
  type PreflopQuestion,
} from "./generators";

type Mode = "preflop" | "stack" | "odds" | "equity";

export function QuizPage() {
  const [mode, setMode] = useState<Mode>("preflop");
  const stats = useStats();
  return (
    <div className="page">
      <div className="seg">
        <button className={mode === "preflop" ? "on" : ""} onClick={() => setMode("preflop")}>
          프리플랍
        </button>
        <button className={mode === "stack" ? "on" : ""} onClick={() => setMode("stack")}>
          레인지 암기
        </button>
        <button className={mode === "odds" ? "on" : ""} onClick={() => setMode("odds")}>
          팟 오즈·EV
        </button>
        <button className={mode === "equity" ? "on" : ""} onClick={() => setMode("equity")}>
          에퀴티
        </button>
      </div>
      <div className="statline">
        <span>정답률 {accuracy(stats.byKey[mode])}</span>
        <span>
          푼 문제 {stats.byKey[mode]?.attempts ?? 0}
        </span>
        <span>연속 정답 {stats.streak} (최고 {stats.bestStreak})</span>
      </div>
      {mode === "preflop" && <PreflopQuiz />}
      {mode === "stack" && <StackQuiz />}
      {mode === "odds" && <MCQuiz key="odds" statKey="odds" generate={generateOdds} />}
      {mode === "equity" && <MCQuiz key="equity" statKey="equity" generate={generateEquity} />}
    </div>
  );
}

const GRADE_TEXT: Record<Grade, string> = {
  correct: "정답!",
  mixed: "부분 정답 (혼합 빈도)",
  wrong: "오답",
};

function PreflopQuiz() {
  const { chartSet } = useSettings();
  const set = getSet(chartSet);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState<PreflopQuestion>(() => generatePreflop(chartSet, "all"));
  const [chosen, setChosen] = useState<string | null>(null);
  const stats = useStats();
  const coach = useCoach();

  // A different chart set was picked: start over with a question from it.
  if (q.scenario.setId !== set.id) {
    setQ(generatePreflop(set.id, "all"));
    setFilter("all");
    setChosen(null);
  }

  const s = q.scenario;
  const strategy = s.strategy[q.hand];
  const best = Math.max(...Object.values(strategy));
  const grade = chosen ? gradePreflop(strategy[chosen] ?? 0, best) : null;
  const stage = set.stages.find((x) => x.id === s.stageId)!;

  function next(f = filter) {
    setQ(generatePreflop(set.id, f));
    setChosen(null);
  }

  function answer(key: string) {
    if (chosen) return;
    setChosen(key);
    const g = gradePreflop(strategy[key] ?? 0, best);
    recordAnswer(["preflop", `preflop:${s.id}`], g !== "wrong");
  }

  function askCoach() {
    if (!chosen || !grade) return;
    const chosenLabel = scenarioActions(s).find((a) => a.key === chosen)?.label ?? chosen;
    coach.open({
      id: `quiz:${q.uid}`,
      title: `${s.title} · ${q.hand}`,
      facts: [
        `게임: ${set.game}`,
        `스택 구간: ${stage.label} (${stage.stack}) — ${stage.description}`,
        `상황: ${s.title}${s.description ? ` — ${s.description}` : ""}`,
        `내 핸드: ${q.cards.map(cardLabel).join(" ")} (${q.hand})`,
        `차트 빈도: ${describeStrategy(s, strategy)}`,
        `사용자의 선택: ${chosenLabel} → ${GRADE_TEXT[grade]}`,
        `차트 출처: ${set.source}`,
      ].join("\n"),
      defaultQuestion:
        grade === "correct"
          ? "정답이었는데, 왜 이게 맞는지 이유를 쉽게 정리해줘."
          : "내 선택이 왜 틀렸고 차트처럼 플레이하는 이유가 뭔지 쉽게 설명해줘.",
    });
  }

  return (
    <>
      <SetPicker />
      <select
        className="select"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          next(e.target.value);
        }}
      >
        <option value="all">전체</option>
        {set.stages.length > 1 &&
          set.stages.map((st) => (
            <option key={st.id} value={`stage:${st.id}`}>
              {st.label} ({st.stack}) 전체
            </option>
          ))}
        {set.stages.map((st) => (
          <optgroup key={st.id} label={`${st.label} · ${st.stack}`}>
            {st.scenarios.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title} (정답률 {accuracy(stats.byKey[`preflop:${x.id}`])})
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <section className="card-box quiz">
        <div className="muted small">
          {stage.label} · {stage.stack}
        </div>
        <h2>{s.title}</h2>
        {s.description && <p className="muted small">{s.description}</p>}
        <SeatRow positions={set.positions} hero={s.hero} villains={s.villainSeats ?? (s.villain ? [s.villain] : [])} />
        <div className="center">
          <CardRow cards={q.cards} size="lg" />
          <div className="muted small">{q.hand}</div>
        </div>

        <div className="actions">
          {scenarioActions(s).map((a) => (
            <button
              key={a.key}
              className={`action ${chosen === a.key ? "picked" : ""}`}
              style={a.key === "fold" ? undefined : { borderColor: actionColor(a.color) }}
              disabled={!!chosen}
              onClick={() => answer(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        {chosen && grade && (
          <div className={`result ${grade}`}>
            <strong>{GRADE_TEXT[grade]}</strong>
            <FreqBar scenario={s} strategy={strategy} />
            <div className="row-gap">
              <button className="primary" onClick={askCoach}>
                AI 해설 요청
              </button>
              <button className="ghost" onClick={() => next()}>
                다음 문제 →
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function MCQuiz({ statKey, generate }: { statKey: string; generate: () => MCQuestion }) {
  const [q, setQ] = useState<MCQuestion>(generate);
  const [picked, setPicked] = useState<number | null>(null);
  const coach = useCoach();

  function onPick(i: number) {
    setPicked(i);
    recordAnswer([statKey, `${statKey}:${q.topic}`], i === q.answer);
  }

  function askCoach() {
    if (picked === null) return;
    coach.open({
      id: `quiz:${q.uid}`,
      title: `${q.topic} 퀴즈`,
      facts: [
        q.facts,
        `문제: ${q.prompt}`,
        `보기: ${q.options.join(" / ")}`,
        `사용자의 답: ${q.options[picked]} → ${picked === q.answer ? "정답" : `오답 (정답: ${q.options[q.answer]})`}`,
      ].join("\n"),
      defaultQuestion:
        picked === q.answer
          ? "맞혔는데, 이 개념을 더 확실히 이해할 수 있게 쉽게 설명해줘."
          : "왜 틀렸는지, 이 계산이 어떤 의미인지 쉽게 설명해줘.",
    });
  }

  return (
    <section className="card-box quiz">
      <div className="muted small">{q.topic}</div>
      <p className="prompt">{q.prompt}</p>
      {(q.hero || q.board) && (
        <div className="spot-cards">
          {q.hero && (
            <div>
              <div className="muted small">나</div>
              <CardRow cards={q.hero} />
            </div>
          )}
          {q.board && (
            <div>
              <div className="muted small">보드</div>
              <CardRow cards={q.board} />
            </div>
          )}
          {q.villain && (
            <div>
              <div className="muted small">상대</div>
              <CardRow cards={q.villain} />
            </div>
          )}
        </div>
      )}
      <Choices options={q.options} answer={q.answer} picked={picked} onPick={onPick} />
      {picked !== null && (
        <div className={`result ${picked === q.answer ? "correct" : "wrong"}`}>
          <strong>{picked === q.answer ? "정답!" : `오답 — 정답은 ${q.options[q.answer]}`}</strong>
          <ol className="steps">
            {q.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <div className="row-gap">
            <button className="primary" onClick={askCoach}>
              AI 해설 요청
            </button>
            <button
              className="ghost"
              onClick={() => {
                setQ(generate());
                setPicked(null);
              }}
            >
              다음 문제 →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
