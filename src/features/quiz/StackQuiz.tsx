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
  drillSeats,
  generateStackQuestion,
  gradeStack,
  questionActions,
  statKeys,
  statPrefix,
  type DrillMode,
  type DrillSpot,
  type QuizAction,
  type StackQuestion,
} from "./stackQuiz";

const SETS: Record<DrillMode, ReturnType<typeof getSet>> = { pub: getSet("pub"), cash: getSet("cash6"), nash: getSet("nash"), short: getSet("shortnash") };
const MODE_LABEL: Record<DrillMode, string> = { pub: "펍아재", cash: "100bb 캐시", nash: "푸시폴드", short: "숏스택" };
const SPOT_LABEL: Record<DrillSpot, string> = { rfi: "오픈 (RFI)", vs: "vs 오픈", mix: "섞어서" };
const NASH_SPOT_LABEL: Record<DrillSpot, string> = { rfi: "푸시", vs: "vs 올인 (콜)", mix: "섞어서" };
/** "UTG 오픈 1,500 (3bb)" or, in the Nash drill, "UTG 올인 10bb". */
function facingText(q: StackQuestion): string {
  if (q.scenario.kind === "vsShove") return `올인 ${q.openTo}bb`;
  return `오픈 ${q.mode === "pub" ? `${fmt(q.openTo! * q.bb)} (${q.openTo}bb)` : `${q.openTo}bb`}`;
}
/** Button label; facing an open, an all-in is a 3-bet shove. */
const actionLabel = (q: StackQuestion, a: QuizAction) => (a === "shove" && q.opener ? "3벳 올인" : QUIZ_ACTIONS.find((x) => x.key === a)!.label);
// "close" never comes up here (the drills use the hand-made sets, which have no close calls); listed for the type.
const GRADE_TEXT = { correct: "정답", close: "정답 (EV 거의 같음)", mixed: "부분 정답 (혼합 빈도)", wrong: "오답" } as const;
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
  initialSpot = "rfi",
}: {
  initialMode?: DrillMode;
  initialStage?: string;
  initialSeat?: string;
  initialSpot?: DrillSpot;
}) {
  const [mode, setMode] = useState<DrillMode>(initialMode);
  const [spot, setSpot] = useState<DrillSpot>(initialSpot);
  const [stage, setStage] = useState(initialStage);
  const [seat, setSeat] = useState(initialSeat);
  const [q, setQ] = useState<StackQuestion>(() => generateStackQuestion(initialStage, initialSeat, initialMode, initialSpot));
  const [picked, setPicked] = useState<QuizAction | null>(null);
  const stats = useStats();
  const coach = useCoach();

  const set = SETS[q.mode];
  const prefix = statPrefix(q.mode);
  const result = picked ? gradeStack(q, picked) : null;
  const st = set.stages.find((s) => s.id === q.stageId)!;
  const actions = questionActions(q);
  const seats = drillSeats(mode, spot);
  /** Stat key prefix for the filters: first-in and vs-open spots are tracked apart. */
  const keyBase = spot === "vs" ? `${statPrefix(mode)}:vs` : statPrefix(mode);

  function next(m = mode, stageF = stage, seatF = seat, sp = spot) {
    setQ(generateStackQuestion(stageF, seatF, m, sp));
    setPicked(null);
  }

  function switchMode(m: DrillMode) {
    setMode(m);
    setStage("all");
    setSeat("all");
    next(m, "all", "all");
  }

  function switchSpot(sp: DrillSpot) {
    setSpot(sp);
    const seatF = drillSeats(mode, sp).includes(seat) ? seat : "all";
    setSeat(seatF);
    next(mode, stage, seatF, sp);
  }

  function answer(a: QuizAction) {
    if (picked) return;
    setPicked(a);
    const { grade } = gradeStack(q, a);
    recordAnswer(statKeys(q), grade !== "wrong");
  }

  function askCoach() {
    if (!picked || !result) return;
    const context =
      q.mode === "cash"
        ? [`게임: ${set.game}`, `스택: 100bb`]
        : q.mode === "nash" || q.mode === "short"
          ? [`게임: ${set.game}`, `스택: 모두 ${q.myChips}bb, 블라인드 0.5/1bb, BB 앤티 1bb`]
          : [
            `게임: ${set.game}`,
            `블라인드: Lv${q.level} ${fmt(q.sb)}/${fmt(q.bb)} (BB 앤티 ${fmt(q.bb)})`,
            `내 스택: ${fmt(q.myChips)} (${bbOf(q.myChips, q.bb)}bb), 평균 스택: ${fmt(q.avgChips)} (${bbOf(q.avgChips, q.bb)}bb)`,
          ];
    const situation = q.opener ? `상황: ${q.opener} ${facingText(q)}, 사이 자리 폴드, 내 자리 ${q.hero}` : `포지션: ${q.hero} (RFI)`;
    coach.open({
      id: `stack:${q.uid}`,
      title: `${q.scenario.title} · ${q.hand}`,
      facts: [
        ...context,
        situation,
        `핸드: ${q.cards.map(cardLabel).join(" ")} (${q.hand})`,
        `적용 차트: ${st.label} (${st.stack}) ${q.scenario.title}`,
        `차트 빈도: ${describeStrategy(q.scenario, q.scenario.strategy[q.hand])}`,
        `이 자리 레인지: ${q.scenario.actions.map((a) => `${a.label} = ${a.range}`).join(" / ")}`,
        `사용자의 선택: ${actionLabel(q, picked)} → ${GRADE_TEXT[result.grade]}`,
        `차트 출처: ${set.source}`,
      ].join("\n"),
      defaultQuestion:
        result.grade === "correct"
          ? "맞혔는데, 이 자리 레인지를 외우는 요령을 알려줘."
          : "왜 틀렸는지, 이 자리 레인지가 왜 이렇게 되는지 설명해줘.",
    });
  }

  const keyStats = stats.byKey[q.opener ? `${prefix}:vs:${q.stageId}:${q.hero}` : `${prefix}:${q.stageId}:${q.hero}`];
  return (
    <>
      <div className="seg small">
        {(Object.keys(MODE_LABEL) as DrillMode[]).map((m) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => switchMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="seg small">
        {(Object.keys(SPOT_LABEL) as DrillSpot[]).map((sp) => (
          <button key={sp} className={spot === sp ? "on" : ""} onClick={() => switchSpot(sp)}>
            {(mode === "nash" ? NASH_SPOT_LABEL : SPOT_LABEL)[sp]}
          </button>
        ))}
      </div>

      <div className="filters">
        {mode !== "cash" && (
          <select
            className="select"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              next(mode, e.target.value, seat);
            }}
          >
            <option value="all">모든 스택</option>
            {SETS[mode].stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {accuracy(stats.byKey[`${keyBase}:${s.id}`])}
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
          {seats.map((p) => (
            <option key={p} value={p}>
              {p} · {accuracy(stats.byKey[stage === "all" ? `${keyBase}:seat:${p}` : `${keyBase}:${stage}:${p}`])}
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
        ) : q.mode === "nash" || q.mode === "short" ? (
          <div className="stack-info">
            <div>
              <span>블라인드</span>
              <b>0.5/1bb</b>
              <span>BB 앤티 1bb</span>
            </div>
            <div>
              <span>스택</span>
              <b>모두 {q.myChips}bb</b>
              <span>9인</span>
            </div>
            <div>
              <span>정답 기준</span>
              <b>내쉬</b>
              <span>{q.mode === "short" ? "오픈 2bb · 계산값" : "칩EV 계산값"}</span>
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
        {q.opener && (
          <div className="vs-open">
            <b>{q.opener}</b> {facingText(q)}
            <span className="muted"> · 내 자리 {q.hero}</span>
          </div>
        )}
        <SeatRow positions={set.positions} hero={q.hero} villains={q.opener ? [q.opener] : []} />
        <div className="center">
          <CardRow cards={q.cards} size="lg" />
          <div className="muted small">{q.hand}</div>
        </div>

        <div className="actions">
          {actions.map((a) => (
            <button key={a} className={`action ${a} ${picked === a ? "picked" : ""}`} disabled={!!picked} onClick={() => answer(a)}>
              {actionLabel(q, a)}
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
              {GRADE_TEXT[result.grade]} —{" "}
              {[...actions.slice(1), actions[0]].map((a) => `${actionLabel(q, a)} ${Math.round(result.freqs[a] * 100)}%`).join(" · ")}
            </strong>
            <div className="muted small">
              적용: {st.label}({st.stack}) {q.scenario.title}
              {q.scenario.hero !== "Hero" && !q.scenario.title.includes(q.hero) ? ` (${q.hero}도 같은 차트)` : ""} · 이 자리 정답률{" "}
              {accuracy(keyStats)}
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
