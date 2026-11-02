import { useState } from "react";
import { CardPicker, CardRow } from "../../components/Cards";
import { getSet, NAMED_RANGES } from "../../data/charts";
import { useSettings } from "../../state/settings";
import { cardLabel, type Card } from "../../poker/cards";
import { equityVsHand, equityVsRange, type EquityResult } from "../../poker/equity";
import { categoryName, evaluate } from "../../poker/evaluator";
import { callEV, mdf, pct, requiredEquity } from "../../poker/odds";
import { FULL_RANGE, rangePercent } from "../../poker/range";
import { useCoach } from "../coach/CoachContext";

type Target = "hero" | "board" | "villain";
const STREET = ["프리플랍", "", "", "플랍", "턴", "리버"];

interface Result {
  eq: EquityResult;
  pot: number;
  bet: number;
  villainLabel: string;
}

export function CalcPage() {
  const [hero, setHero] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]);
  const [villainCards, setVillainCards] = useState<Card[]>([]);
  const [villainMode, setVillainMode] = useState<"range" | "hand">("range");
  const { chartSet } = useSettings();
  const set = getSet(chartSet);
  const [rangeId, setRangeId] = useState(
    (NAMED_RANGES.find((r) => r.id === `${set.id}/${set.stages[0].id}/rfi-btn:open`) ?? NAMED_RANGES[0]).id,
  );
  const rangeGroups = [...new Set(NAMED_RANGES.map((r) => r.group))];
  const [target, setTarget] = useState<Target>("hero");
  const [pot, setPot] = useState("10");
  const [bet, setBet] = useState("5");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const coach = useCoach();

  const selection = target === "hero" ? hero : target === "board" ? board : villainCards;
  const setSelection = target === "hero" ? setHero : target === "board" ? setBoard : setVillainCards;
  const max = target === "board" ? 5 : 2;
  const others = [hero, board, villainMode === "hand" ? villainCards : []]
    .filter((c) => c !== selection)
    .flat();

  const named = rangeId === "all" ? { label: "아무 핸드나 (100%)", range: FULL_RANGE } : NAMED_RANGES.find((r) => r.id === rangeId)!;

  function compute() {
    setError(null);
    if (hero.length !== 2) return setError("내 핸드 2장을 골라 주세요.");
    if (board.length === 1 || board.length === 2) return setError("보드는 0장(프리플랍) 또는 3~5장이어야 해요.");
    if (villainMode === "hand" && villainCards.length !== 2) return setError("상대 핸드 2장을 골라 주세요.");
    const p = Number(pot), b = Number(bet);
    if (!(p > 0) || !(b >= 0)) return setError("팟과 베팅 금액을 확인해 주세요.");
    setBusy(true);
    // Let the button repaint before the simulation blocks the thread.
    setTimeout(() => {
      try {
        const eq =
          villainMode === "hand"
            ? equityVsHand(hero, villainCards, board, 40000)
            : equityVsRange(hero, named.range, board, 25000);
        setResult({
          eq,
          pot: p,
          bet: b,
          villainLabel:
            villainMode === "hand"
              ? villainCards.map(cardLabel).join(" ")
              : `${named.label} (전체 핸드의 약 ${rangePercent(named.range).toFixed(1)}%)`,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }, 20);
  }

  function askCoach() {
    if (!result) return;
    const { eq, pot: p, bet: b } = result;
    const lines = [
      `게임: ${set.game}`,
      `스트리트: ${STREET[board.length]}`,
      `내 핸드: ${hero.map(cardLabel).join(" ")}`,
      board.length ? `보드: ${board.map(cardLabel).join(" ")}` : "",
      board.length >= 3 ? `현재 내 족보: ${categoryName(evaluate([...hero, ...board]))}` : "",
      `상대: ${result.villainLabel}`,
      villainMode === "range" ? "참고: 상대 레인지는 프리플랍 레인지 그대로 가정했어요(플랍 이후 행동으로 좁혀진 것은 반영 안 됨)." : "",
      `팟(상대 베팅 전): ${p}bb, 상대 베팅: ${b}bb`,
      `계산된 내 에퀴티: ${pct(eq.equity)} (승 ${pct(eq.win)}, 무 ${pct(eq.tie)}, ${eq.exact ? "정확 계산" : `시뮬레이션 ${eq.samples.toLocaleString()}회`})`,
    ];
    if (b > 0) {
      lines.push(
        `콜에 필요한 에퀴티(팟 오즈): ${pct(requiredEquity(p, b))}`,
        `MDF: ${pct(mdf(p, b))}`,
        `콜의 EV(폴드 대비): ${callEV(eq.equity, p, b).toFixed(2)}bb`,
      );
    }
    coach.open({
      id: `calc:${Date.now()}`,
      title: `${STREET[board.length]} 스팟 분석`,
      facts: lines.filter(Boolean).join("\n"),
      defaultQuestion:
        b > 0
          ? "이 숫자들을 바탕으로 콜/폴드를 어떻게 판단하면 되는지 쉽게 해설해줘."
          : "이 에퀴티가 어떤 의미인지, 이 상황에서 어떻게 생각하면 되는지 쉽게 해설해줘.",
    });
  }

  const b = Number(bet), p = Number(pot);
  return (
    <div className="page">
      <section className="card-box">
        <div className="slots">
          <button className={`slot ${target === "hero" ? "on" : ""}`} onClick={() => setTarget("hero")}>
            <span className="muted small">내 핸드</span>
            {hero.length ? <CardRow cards={hero} size="sm" /> : <span className="placeholder">2장 선택</span>}
          </button>
          <button className={`slot ${target === "board" ? "on" : ""}`} onClick={() => setTarget("board")}>
            <span className="muted small">보드 ({STREET[board.length] || "선택 중"})</span>
            {board.length ? <CardRow cards={board} size="sm" /> : <span className="placeholder">0~5장</span>}
          </button>
          {villainMode === "hand" && (
            <button className={`slot ${target === "villain" ? "on" : ""}`} onClick={() => setTarget("villain")}>
              <span className="muted small">상대 핸드</span>
              {villainCards.length ? <CardRow cards={villainCards} size="sm" /> : <span className="placeholder">2장 선택</span>}
            </button>
          )}
        </div>
        <CardPicker selected={selection} max={max} disabled={others} onChange={setSelection} />
        <div className="row-between small">
          <span className="muted">위 칸을 눌러 어떤 카드를 고를지 바꾸세요.</span>
          <button className="ghost small" onClick={() => setSelection([])}>
            지우기
          </button>
        </div>
      </section>

      <section className="card-box">
        <div className="seg small">
          <button className={villainMode === "range" ? "on" : ""} onClick={() => { setVillainMode("range"); if (target === "villain") setTarget("hero"); }}>
            상대 레인지
          </button>
          <button className={villainMode === "hand" ? "on" : ""} onClick={() => { setVillainMode("hand"); setTarget("villain"); }}>
            상대 핸드 지정
          </button>
        </div>
        {villainMode === "range" && (
          <select className="select" value={rangeId} onChange={(e) => setRangeId(e.target.value)}>
            <option value="all">아무 핸드나 (100%)</option>
            {rangeGroups.map((g) => (
              <optgroup key={g} label={g}>
                {NAMED_RANGES.filter((r) => r.group === g).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {rangePercent(r.range).toFixed(0)}%
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <div className="inputs">
          <label>
            팟 (bb)
            <input inputMode="decimal" value={pot} onChange={(e) => setPot(e.target.value)} />
          </label>
          <label>
            상대 베팅 (bb)
            <input inputMode="decimal" value={bet} onChange={(e) => setBet(e.target.value)} />
          </label>
        </div>
        {p > 0 && b > 0 && (
          <p className="muted small">
            베팅 크기: 팟의 {Math.round((b / p) * 100)}% · 콜에 필요한 에퀴티 {pct(requiredEquity(p, b))}
          </p>
        )}
        <button className="primary wide" onClick={compute} disabled={busy}>
          {busy ? "계산 중…" : "계산하기"}
        </button>
        {error && <div className="notice error">{error}</div>}
      </section>

      {result && (
        <section className="card-box">
          <div className="big-number">{pct(result.eq.equity)}</div>
          <div className="muted center small">
            내 에퀴티 · 승 {pct(result.eq.win)} / 무 {pct(result.eq.tie)} ·{" "}
            {result.eq.exact ? "정확 계산" : `시뮬레이션 ${result.eq.samples.toLocaleString()}회`}
          </div>
          {result.bet > 0 && (
            <table className="facts">
              <tbody>
                <tr>
                  <th>콜에 필요한 에퀴티</th>
                  <td>{pct(requiredEquity(result.pot, result.bet))}</td>
                </tr>
                <tr>
                  <th>콜의 EV (폴드 대비)</th>
                  <td>{callEV(result.eq.equity, result.pot, result.bet).toFixed(2)}bb</td>
                </tr>
                <tr>
                  <th>MDF (레인지 최소 방어율)</th>
                  <td>{pct(mdf(result.pot, result.bet))}</td>
                </tr>
              </tbody>
            </table>
          )}
          {result.bet > 0 && (
            <p className={`verdict ${result.eq.equity >= requiredEquity(result.pot, result.bet) ? "good" : "bad"}`}>
              {result.eq.equity >= requiredEquity(result.pot, result.bet)
                ? "숫자만 보면 콜이 이득이에요 (에퀴티 > 필요 에퀴티)."
                : "숫자만 보면 콜은 손해예요 (에퀴티 < 필요 에퀴티)."}
            </p>
          )}
          <p className="muted small">
            {villainMode === "range" &&
              "상대 레인지는 프리플랍 레인지 그대로예요. 실제로는 플랍 이후 행동에 따라 좁혀지니 참고용으로 보세요. "}
            남은 베팅이나 포지션(에퀴티 실현)은 반영되지 않았어요.
          </p>
          <button className="primary wide" onClick={askCoach}>
            AI 해설 요청
          </button>
        </section>
      )}
    </div>
  );
}
