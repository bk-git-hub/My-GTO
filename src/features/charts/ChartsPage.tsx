import { useMemo, useState } from "react";
import { describeStrategy, FreqBar, actionColor, strategyGradient } from "../../components/FreqBar";
import { SeatRow, SetPicker } from "../../components/SetPicker";
import { actionTotals, FOLD, getSet, KIND_LABEL, type Scenario } from "../../data/charts";
import { comboCount, gridHand, type HandClass } from "../../poker/cards";
import { useSettings } from "../../state/settings";
import { useCoach } from "../coach/CoachContext";

export function ChartsPage() {
  const { chartSet } = useSettings();
  const set = getSet(chartSet);
  const [stageId, setStageId] = useState(set.stages[0].id);
  const stage = set.stages.find((s) => s.id === stageId) ?? set.stages[0];
  const groups = useMemo(() => {
    const out = new Map<string, Scenario[]>();
    for (const s of stage.scenarios) {
      const label = KIND_LABEL[s.kind];
      out.set(label, [...(out.get(label) ?? []), s]);
    }
    return [...out.entries()];
  }, [stage]);
  const [group, setGroup] = useState(groups[0][0]);
  const list = groups.find(([g]) => g === group)?.[1] ?? groups[0][1];
  const [scenarioId, setScenarioId] = useState(list[0].id);
  const scenario = list.find((s) => s.id === scenarioId) ?? list[0];
  const [hand, setHand] = useState<HandClass | null>(null);
  const coach = useCoach();
  const totals = useMemo(() => actionTotals(scenario), [scenario]);

  function pickStage(id: string) {
    setStageId(id);
    setHand(null);
  }

  function askCoach(h: HandClass) {
    const s = scenario.strategy[h];
    coach.open({
      id: `chart:${scenario.id}:${h}`,
      title: `${scenario.title} · ${h}`,
      facts: [
        `게임: ${set.game}`,
        `스택 구간: ${stage.label} (${stage.stack}) — ${stage.description}`,
        `상황: ${scenario.title} — ${scenario.description}`,
        `핸드: ${h} (${comboCount(h)}콤보)`,
        `차트 빈도: ${describeStrategy(scenario, s)}`,
        `이 상황 전체: ${[...scenario.actions, FOLD].map((a) => `${a.label} ${(totals[a.key] * 100).toFixed(1)}%`).join(", ")} (전체 핸드 대비)`,
        `차트 출처: ${set.source}`,
      ].join("\n"),
      defaultQuestion: "이 상황에서 이 핸드를 왜 이렇게 플레이하는지 쉽게 설명해줘.",
    });
  }

  // Keep the selections valid when the set or stage changes.
  if (!set.stages.some((s) => s.id === stageId)) setStageId(set.stages[0].id);
  if (!groups.some(([g]) => g === group)) setGroup(groups[0][0]);

  return (
    <div className="page">
      <SetPicker />

      {set.stages.length > 1 && (
        <div className="seg">
          {set.stages.map((st) => (
            <button key={st.id} className={st.id === stage.id ? "on" : ""} onClick={() => pickStage(st.id)}>
              {st.label}
            </button>
          ))}
        </div>
      )}
      <p className="stage-note">
        <b>{stage.stack}</b> · {stage.description}
      </p>

      {groups.length > 1 && (
        <div className="seg small">
          {groups.map(([g]) => (
            <button key={g} className={g === group ? "on" : ""} onClick={() => { setGroup(g); setHand(null); }}>
              {g}
            </button>
          ))}
        </div>
      )}

      <div className="chips scroll">
        {list.map((s) => (
          <button
            key={s.id}
            className={`chip ${s.id === scenario.id ? "on" : ""}`}
            onClick={() => {
              setScenarioId(s.id);
              setHand(null);
            }}
          >
            {s.chip}
          </button>
        ))}
      </div>

      <section className="card-box">
        <h2>{scenario.title}</h2>
        <p className="muted">{scenario.description}</p>
        <SeatRow positions={set.positions} hero={scenario.hero} villains={scenario.villainSeats ?? (scenario.villain ? [scenario.villain] : [])} />
        <div className="legend">
          {[...scenario.actions, FOLD].map((a) => (
            <span key={a.key} className="legend-item">
              <i style={{ background: actionColor(a.color, a.key) }} />
              {a.label} {(totals[a.key] * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      </section>

      <div className="grid" role="grid">
        {Array.from({ length: 13 }, (_, r) =>
          Array.from({ length: 13 }, (_, c) => {
            const h = gridHand(r, c);
            const s = scenario.strategy[h];
            return (
              <button
                key={h}
                className={`cell ${hand === h ? "sel" : ""} ${s.fold >= 0.999 ? "folded" : ""}`}
                style={{ background: strategyGradient(scenario, s) }}
                onClick={() => setHand(h)}
                title={`${h}: ${describeStrategy(scenario, s)}`}
              >
                {h}
              </button>
            );
          }),
        )}
      </div>

      {hand ? (
        <section className="card-box">
          <div className="row-between">
            <h3>
              {hand} <span className="muted small">{comboCount(hand)}콤보</span>
            </h3>
            <button className="primary small" onClick={() => askCoach(hand)}>
              AI 해설 요청
            </button>
          </div>
          <FreqBar scenario={scenario} strategy={scenario.strategy[hand]} />
        </section>
      ) : (
        <p className="muted center small">칸을 누르면 핸드별 빈도와 AI 해설을 볼 수 있어요.</p>
      )}

      <p className="muted small disclaimer">
        {set.game}. {set.source}
      </p>
    </div>
  );
}
