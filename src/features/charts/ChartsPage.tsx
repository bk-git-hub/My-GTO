import { useMemo, useState } from "react";
import { describeStrategy, FreqBar, strategyGradient } from "../../components/FreqBar";
import {
  GAME_LABEL,
  SCENARIOS,
  actionLabel,
  scenarioActions,
  type Scenario,
} from "../../data/preflop";
import { ALL_HANDS, comboCount, gridHand, type HandClass } from "../../poker/cards";
import { rangePercent } from "../../poker/range";
import { useCoach } from "../coach/CoachContext";

export function ChartsPage() {
  const [kind, setKind] = useState<Scenario["kind"]>("rfi");
  const [scenarioId, setScenarioId] = useState("rfi-utg");
  const [hand, setHand] = useState<HandClass | null>(null);
  const coach = useCoach();

  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const list = SCENARIOS.filter((s) => s.kind === kind);

  const totals = useMemo(() => {
    const out = { raise: 0, call: 0, fold: 0 };
    for (const h of ALL_HANDS) {
      const s = scenario.strategy[h];
      const n = comboCount(h);
      out.raise += s.raise * n;
      out.call += s.call * n;
      out.fold += s.fold * n;
    }
    return out;
  }, [scenario]);

  function pickKind(k: Scenario["kind"]) {
    setKind(k);
    setScenarioId(SCENARIOS.find((s) => s.kind === k)!.id);
    setHand(null);
  }

  function askCoach(h: HandClass) {
    const s = scenario.strategy[h];
    coach.open({
      id: `chart:${scenario.id}:${h}`,
      title: `${scenario.title} · ${h}`,
      facts: [
        `게임: ${GAME_LABEL}`,
        `상황: ${scenario.title} — ${scenario.description}`,
        `레이즈 사이즈: ${scenario.raiseLabel}`,
        `핸드: ${h} (${comboCount(h)}콤보)`,
        `차트 빈도(학습용 근사 차트): ${describeStrategy(scenario, s)}`,
        `이 상황의 전체 ${actionLabel(scenario, "raise")} 레인지: 전체 핸드의 약 ${rangePercent(scenario.raiseRange).toFixed(1)}%` +
          (scenario.kind === "vsOpen" ? `, 콜 레인지: 약 ${rangePercent(scenario.callRange).toFixed(1)}%` : ""),
      ].join("\n"),
      defaultQuestion: "이 상황에서 이 핸드를 왜 이렇게 플레이하는지 쉽게 설명해줘.",
    });
  }

  return (
    <div className="page">
      <div className="seg">
        <button className={kind === "rfi" ? "on" : ""} onClick={() => pickKind("rfi")}>
          오픈 (RFI)
        </button>
        <button className={kind === "vsOpen" ? "on" : ""} onClick={() => pickKind("vsOpen")}>
          오픈에 대응
        </button>
      </div>

      <div className="chips scroll">
        {list.map((s) => (
          <button
            key={s.id}
            className={`chip ${s.id === scenarioId ? "on" : ""}`}
            onClick={() => {
              setScenarioId(s.id);
              setHand(null);
            }}
          >
            {s.kind === "rfi" ? s.hero : `${s.hero} vs ${s.villain}`}
          </button>
        ))}
      </div>

      <section className="card-box">
        <h2>{scenario.title}</h2>
        <p className="muted">{scenario.description}</p>
        <div className="legend">
          {scenarioActions(scenario)
            .slice()
            .reverse()
            .map((a) => (
              <span key={a} className={`legend-item ${a}`}>
                <i />
                {a === "raise" ? scenario.raiseLabel : actionLabel(scenario, a)} {((totals[a] / 1326) * 100).toFixed(1)}%
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
                style={{ background: strategyGradient(s) }}
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
        {GAME_LABEL}. 이 차트는 솔버 정확값이 아닌 학습용 근사 차트예요. 직접 구한 솔버 결과로 바꾸려면
        <code> src/data/preflop.ts</code>의 레인지 문자열만 교체하면 돼요.
      </p>
    </div>
  );
}
