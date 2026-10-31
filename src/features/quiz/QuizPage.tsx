import { useState } from "react";
import { CardRow } from "../../components/Cards";
import { Choices } from "../../components/Choice";
import { describeStrategy, FreqBar } from "../../components/FreqBar";
import {
  GAME_LABEL,
  POSITIONS,
  SCENARIOS,
  actionLabel,
  scenarioActions,
  type ActionKey,
} from "../../data/preflop";
import { cardLabel } from "../../poker/cards";
import { accuracy, recordAnswer, useStats } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";
import {
  generateEquity,
  generateOdds,
  generatePreflop,
  gradePreflop,
  type Grade,
  type MCQuestion,
  type PreflopQuestion,
} from "./generators";

type Mode = "preflop" | "odds" | "equity";

export function QuizPage() {
  const [mode, setMode] = useState<Mode>("preflop");
  const stats = useStats();
  return (
    <div className="page">
      <div className="seg">
        <button className={mode === "preflop" ? "on" : ""} onClick={() => setMode("preflop")}>
          프리플랍
        </button>
        <button className={mode === "odds" ? "on" : ""} onClick={() => setMode("odds")}>
          팟 오즈·EV
        </button>
        <button className={mode === "equity" ? "on" : ""} onClick={() => setMode("equity")}>
          에퀴티 감각
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
      {mode === "odds" && <MCQuiz key="odds" statKey="odds" generate={generateOdds} />}
      {mode === "equity" && <MCQuiz key="equity" statKey="equity" generate={generateEquity} />}
    </div>
  );
}

const GRADE_TEXT: Record<Grade, string> = {
  correct: "정답!",
  mixed: "부분 정답 — 차트에서 섞어 쓰는(혼합) 플레이예요",
  wrong: "오답",
};

function PreflopQuiz() {
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState<PreflopQuestion>(() => generatePreflop("all"));
  const [chosen, setChosen] = useState<ActionKey | null>(null);
  const stats = useStats();
  const coach = useCoach();

  const strategy = q.scenario.strategy[q.hand];
  const best = Math.max(strategy.raise, strategy.call, strategy.fold);
  const grade = chosen ? gradePreflop(strategy[chosen], best) : null;

  function next(f = filter) {
    setQ(generatePreflop(f));
    setChosen(null);
  }

  function answer(a: ActionKey) {
    if (chosen) return;
    setChosen(a);
    const g = gradePreflop(strategy[a], best);
    recordAnswer(["preflop", `preflop:${q.scenario.id}`], g !== "wrong");
  }

  function askCoach() {
    if (!chosen || !grade) return;
    coach.open({
      id: `quiz:${q.uid}`,
      title: `${q.scenario.title} · ${q.hand}`,
      facts: [
        `게임: ${GAME_LABEL}`,
        `상황: ${q.scenario.title} — ${q.scenario.description}`,
        `레이즈 사이즈: ${q.scenario.raiseLabel}`,
        `내 핸드: ${q.cards.map(cardLabel).join(" ")} (${q.hand})`,
        `차트 빈도(학습용 근사 차트): ${describeStrategy(q.scenario, strategy)}`,
        `사용자의 선택: ${actionLabel(q.scenario, chosen)} → ${GRADE_TEXT[grade]}`,
      ].join("\n"),
      defaultQuestion:
        grade === "correct"
          ? "정답이었는데, 왜 이게 맞는지 이유를 쉽게 정리해줘."
          : "내 선택이 왜 틀렸고 차트처럼 플레이하는 이유가 뭔지 쉽게 설명해줘.",
    });
  }

  const s = q.scenario;
  return (
    <>
      <select
        className="select"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          next(e.target.value);
        }}
      >
        <option value="all">전체 시나리오 섞어서</option>
        {SCENARIOS.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title} (정답률 {accuracy(stats.byKey[`preflop:${x.id}`])})
          </option>
        ))}
      </select>

      <section className="card-box quiz">
        <h2>{s.title}</h2>
        <p className="muted small">{s.description}</p>
        <div className="table-seats">
          {POSITIONS.map((p) => (
            <span
              key={p}
              className={`seat ${p === s.hero ? "hero" : ""} ${p === s.villain ? "villain" : ""}`}
            >
              {p}
              {p === s.villain && <em>오픈</em>}
              {p === s.hero && <em>나</em>}
            </span>
          ))}
        </div>
        <div className="center">
          <CardRow cards={q.cards} size="lg" />
          <div className="muted small">{q.hand}</div>
        </div>

        <div className="actions">
          {scenarioActions(s).map((a) => (
            <button
              key={a}
              className={`action ${a} ${chosen === a ? "picked" : ""}`}
              disabled={!!chosen}
              onClick={() => answer(a)}
            >
              {a === "raise" ? `${actionLabel(s, a)} (${s.raiseLabel.replace(/^\S+\s/, "")})` : actionLabel(s, a)}
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
