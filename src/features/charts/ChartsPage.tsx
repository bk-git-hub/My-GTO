import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { closeFact, CloseNote, describeStrategy, FreqBar, actionColor } from "../../components/FreqBar";
import { RangeGrid } from "../../components/RangeGrid";
import { SeatRow, SetPicker } from "../../components/SetPicker";
import { SolverSkeleton } from "../../components/SolverSkeleton";
import {
  actionTotals,
  displayChips,
  getSet,
  heroFilterSeats,
  inReach,
  isHeavyClose,
  KIND_LABEL,
  legendActions,
  reachOf,
  reachShare,
  reachTotals,
  type Scenario,
} from "../../data/charts";
import { bigPairCloseNote, cautionFacts, cautionLines, flagLines, SOLVER_ID } from "../../data/sets/preflop";
import { useSolver } from "../../data/useSolver";
import { comboCount, type HandClass } from "../../poker/cards";
import { useSettings } from "../../state/settings";
import { useCoach } from "../coach/CoachContext";

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
// Reach above 0 never shows as "0%", which would read as "never gets here" (that is what the dimmed cells say).
/** The share of all hands that reach the spot. */
const reachPct = (x: number) => (x > 0 && x < 0.0005 ? "0.1% 미만" : pct1(x));
/** How often one hand reaches the spot. */
const handReachPct = (x: number) => (x > 0 && x < 0.005 ? "1% 미만" : `${Math.round(x * 100)}%`);

/** The solver set's stages are chunks loaded on first use (docs §6.3): a skeleton under the set picker until then. */
export function ChartsPage() {
  const { chartSet } = useSettings();
  const solver = useSolver(chartSet === SOLVER_ID);
  if (solver.status !== "ready")
    return (
      <div className="page">
        <SetPicker />
        <SolverSkeleton {...solver} />
      </div>
    );
  return <ChartsView />;
}

function ChartsView() {
  const { chartSet } = useSettings();
  const set = getSet(chartSet);
  const [stageId, setStageId] = useState(set.stages[0].id);
  const stage = set.stages.find((s) => s.id === stageId) ?? set.stages[0];
  // The depth row (docs §6.8): only for a set whose every stage has a depth; null keeps the plain stage row.
  const depths = useMemo(() => {
    if (set.stages.length < 2 || set.stages.some((s) => s.depth === undefined)) return null;
    return [...new Set(set.stages.map((s) => s.depth!))].sort((a, b) => b - a);
  }, [set]);
  const atDepth = depths ? set.stages.filter((s) => s.depth === stage.depth) : [];
  const [stageByDepth, setStageByDepth] = useState<Record<number, string>>({});
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
  // A big group (the solver set's 30–70 spots per kind) is filtered by hero seat. The seat picked is kept per
  // set; a group where that seat never acts shows its first seat instead.
  const seats = useMemo(() => heroFilterSeats(set, list), [set, list]);
  const [seatBySet, setSeatBySet] = useState<Record<string, string>>({});
  const seat = seats.includes(seatBySet[set.id]) ? seatBySet[set.id] : seats[0];
  const shown = useMemo(() => (seats.length ? list.filter((s) => s.hero === seat) : list), [list, seats, seat]);
  const chipTexts = useMemo(() => displayChips(shown), [shown]);
  const [scenarioId, setScenarioId] = useState(list[0].id);
  const scenario = shown.find((s) => s.id === scenarioId) ?? shown[0];
  const [hand, setHand] = useState<HandClass | null>(null);
  const coach = useCoach();
  // Deep in a line (reachRange set) the totals are shares of the hands that get here, not of all 1326 combos.
  const reach = scenario.reachRange ? reachShare(scenario) : null;
  const totals = useMemo(() => (scenario.reachRange ? reachTotals(scenario) : actionTotals(scenario)), [scenario]);
  // The solver set's close calls and known-artifact cautions (docs §6.9, §6.10); nothing for the hand-made sets.
  const cautions = useMemo(() => cautionLines(scenario), [scenario]);
  const closeCount = scenario.close ? Object.keys(scenario.close).length : 0;
  const heavyClose = useMemo(() => isHeavyClose(scenario), [scenario]);
  // The chip row is remounted for each list (key below), so it starts scrolled to its start. Coming back to a group or
  // seat brings its earlier pick back, which can sit past the right edge: scroll that chip into view once per list.
  const chipsKey = `${set.id}/${stage.id}/${group}/${seat ?? ""}`;
  const chipsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = chipsRef.current;
    const on = row?.querySelector<HTMLElement>(".chip.on");
    if (!row || !on) return;
    const r = row.getBoundingClientRect();
    const c = on.getBoundingClientRect();
    if (c.left < r.left || c.right > r.right) row.scrollLeft += c.left - r.left - 12;
  }, [chipsKey]);

  function pickStage(id: string) {
    setStageId(id);
    setHand(null);
    const d = set.stages.find((s) => s.id === id)?.depth;
    if (d !== undefined) setStageByDepth((m) => ({ ...m, [d]: id }));
  }

  /** A depth opens on the size last picked there, else its first stage. */
  function pickDepth(d: number) {
    const remembered = stageByDepth[d];
    const st = set.stages.find((s) => s.id === remembered && s.depth === d) ?? set.stages.find((s) => s.depth === d);
    if (st) pickStage(st.id);
  }

  function pickSeat(p: string) {
    setSeatBySet((m) => ({ ...m, [set.id]: p }));
    setHand(null);
  }

  function askCoach(h: HandClass) {
    const s = scenario.strategy[h];
    const all = legendActions(scenario).map((a) => `${a.label} ${(totals[a.key] * 100).toFixed(1)}%`).join(", ");
    const close = closeFact(scenario, h, stage.closeEps);
    const caveat = bigPairCloseNote(scenario, h);
    coach.open({
      id: `chart:${scenario.id}:${h}`,
      title: `${scenario.title} · ${h}`,
      facts: [
        `게임: ${set.game}`,
        `스택 구간: ${stage.label} (${stage.stack}) — ${stage.description}`,
        `상황: ${scenario.title}${scenario.description ? ` — ${scenario.description}` : ""}`,
        `핸드: ${h} (${comboCount(h)}콤보)`,
        ...(reach === null ? [] : [`이 핸드가 여기까지 오는 빈도: ${handReachPct(reachOf(scenario, h))}`]),
        `차트 빈도: ${describeStrategy(scenario, s)}`,
        ...(close ? [close] : []),
        ...(caveat ? [`모델 한계: ${caveat}`] : []),
        ...cautionFacts(scenario, h, true),
        reach === null
          ? `이 상황 전체: ${all} (전체 핸드 대비)`
          : `이 상황 전체: ${all}, 도달 레인지 ${reachPct(reach)} (도달 핸드 대비)`,
        `차트 출처: ${set.source}`,
      ].join("\n"),
      defaultQuestion: "이 상황에서 이 핸드를 왜 이렇게 플레이하는지 쉽게 설명해줘.",
    });
  }

  // Keep the selections valid when the set or stage changes.
  if (!set.stages.some((s) => s.id === stageId)) setStageId(set.stages[0].id);
  if (!groups.some(([g]) => g === group)) setGroup(groups[0][0]);
  const handOut = hand !== null && !inReach(scenario, hand);

  return (
    <div className="page">
      <SetPicker />

      {depths ? (
        // A set whose stages all carry a depth (the solver set): one button per depth, deepest first, and at a depth
        // with several stages a smaller row of their sizes (100bb: 오픈 2.2bb | 펍 사이즈 오픈 3bb). Docs §6.8.
        <>
          <div className={`seg depth-row${depths.length > 5 ? " many" : ""}`} aria-label="스택">
            {depths.map((d) => (
              <button key={d} className={d === stage.depth ? "on" : ""} onClick={() => pickDepth(d)}>
                {d}bb
              </button>
            ))}
          </div>
          {atDepth.length > 1 && (
            <div className="seg small size-row" aria-label="오픈 사이즈">
              {atDepth.map((st) => (
                <button key={st.id} className={st.id === stage.id ? "on" : ""} onClick={() => pickStage(st.id)}>
                  {st.sizeLabel ?? st.label}
                </button>
              ))}
            </div>
          )}
        </>
      ) : set.stages.length > 5 ? (
        <select className="select" value={stage.id} onChange={(e) => pickStage(e.target.value)}>
          {set.stages.map((st) => (
            <option key={st.id} value={st.id}>
              {st.label}
            </option>
          ))}
        </select>
      ) : (
        set.stages.length > 1 && (
          <div className="seg stage-row">
            {set.stages.map((st) => (
              <button key={st.id} className={st.id === stage.id ? "on" : ""} onClick={() => pickStage(st.id)}>
                {st.label}
              </button>
            ))}
          </div>
        )
      )}
      <p className="stage-note">
        <b>{stage.stack}</b> · {stage.description}
      </p>

      {groups.length > 1 && (
        // More than 6 kinds (the solver's 35bb stage has 7) scroll sideways instead of breaking every label.
        <div className={`seg small kind-row${groups.length > 6 ? " many" : ""}`}>
          {groups.map(([g]) => (
            <button key={g} className={g === group ? "on" : ""} onClick={() => { setGroup(g); setHand(null); }}>
              {g}
            </button>
          ))}
        </div>
      )}

      {seats.length > 0 && (
        <div className="seg small seat-filter" aria-label="내 자리">
          {seats.map((p) => (
            <button key={p} className={p === seat ? "on" : ""} onClick={() => pickSeat(p)}>
              {p}
            </button>
          ))}
        </div>
      )}

      {/* A new list starts scrolled to its start (the effect above then brings an earlier pick into view); otherwise a
          seat or group switch keeps the old row's sideways scroll and the selected chip can sit off-screen. */}
      <div className="chips scroll" key={chipsKey} ref={chipsRef}>
        {shown.map((s, i) => (
          <button
            key={s.id}
            className={`chip ${s.id === scenario.id ? "on" : ""}`}
            onClick={() => {
              setScenarioId(s.id);
              setHand(null);
            }}
          >
            {chipTexts[i]}
          </button>
        ))}
      </div>

      <section className="card-box">
        <h2>{scenario.title}</h2>
        {scenario.description && <p className="muted">{scenario.description}</p>}
        {cautions.length > 0 && (
          // Collapsed: two open lines push the grid 120–135px down a phone screen. The picked hand's own caution
          // shows in its hand card.
          // Keyed by spot: an open row would otherwise stay open on the next flagged spot.
          <details className="cautions" key={scenario.id}>
            <summary>알려진 한계 {cautions.length}개</summary>
            {cautions.map((c) => (
              <p key={c}>{c}</p>
            ))}
          </details>
        )}
        <SeatRow positions={set.positions} hero={scenario.hero} villains={scenario.villainSeats ?? (scenario.villain ? [scenario.villain] : [])} />
        <div className="legend">
          {legendActions(scenario).map((a) => (
            <span key={a.key} className="legend-item">
              <i style={{ background: actionColor(a.color, a.key) }} />
              {a.label} {(totals[a.key] * 100).toFixed(1)}%
            </span>
          ))}
          {reach !== null && (
            <span className="legend-item">
              <i className="out" />
              도달 레인지 {reachPct(reach)}
            </span>
          )}
          {closeCount > 0 && (
            <span className="legend-item">
              <i className="close" />
              EV 거의 같음
            </span>
          )}
        </div>
        {reach !== null && <p className="muted small">비율은 여기까지 온 핸드 기준이에요. 빗금 칸은 앞에서 이 라인으로 오지 않는 핸드예요.</p>}
        {heavyClose && <p className="muted small">표시된 칸이 많아요: 이 스팟은 액션끼리 EV 차이가 작은 핸드가 많아요.</p>}
      </section>

      <RangeGrid scenario={scenario} selected={hand} onPick={setHand} />

      {hand ? (
        <section className="card-box">
          <div className="row-between">
            <h3>
              {hand} <span className="muted small">{comboCount(hand)}콤보</span>
              {reach !== null && !handOut && reachOf(scenario, hand) < 1 && (
                <span className="muted small"> · 도달 {handReachPct(reachOf(scenario, hand))}</span>
              )}
            </h3>
            {!handOut && (
              <button className="primary small" onClick={() => askCoach(hand)}>
                AI 해설 요청
              </button>
            )}
          </div>
          {handOut ? (
            <p className="muted small">이 핸드는 앞선 내 액션에서 이 라인으로 오지 않아요.</p>
          ) : (
            <>
              <FreqBar scenario={scenario} strategy={scenario.strategy[hand]} />
              <CloseNote scenario={scenario} hand={hand} eps={stage.closeEps} />
              {bigPairCloseNote(scenario, hand) && <p className="flag-note">{bigPairCloseNote(scenario, hand)}</p>}
              {flagLines(scenario, hand).map((l) => (
                <p key={l} className="flag-note">
                  {l}
                </p>
              ))}
            </>
          )}
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
