import { useState } from "react";
import { foldOutFacts } from "../../play/foldOut";
import { GRADE_MARK, SIDE_POT_TEXT, type Decision } from "../../play/table";
import { refMiss, STREET_LABEL } from "./verdict";

export const GRADE_TEXT = { good: "좋은 선택", ok: "괜찮음", mistake: "실수", info: "참고" } as const;
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);
/** "팟 19": the pot a call plays for, and the chips beyond my stack it leaves out ("팟 19 (내 스택을 넘는 40bb 제외)"). */
export const potText = (d: Decision, unit = "") => `팟 ${r1(d.pot - (d.sidePot ?? 0))}${unit}${d.sidePot ? ` (${SIDE_POT_TEXT(d.sidePot)})` : ""}`;

/** The pack's top action is not the one I took. */
const offTop = (d: Decision) => !!d.pack && d.pack.freq.reduce((b, f, i, a) => (f > a[b] ? i : b), 0) !== d.pack.chosen;

/** "벳 33%: 51%": an action and its frequency, kept apart so a bet size and a frequency never read as one. */
export const freqPart = (label: string, f: number | null | undefined) => `${label}: ${pct(f)}`;

/** The opponents' profiles are not in the grade (a pack or chart graded against GTO opponents). */
const VS_PROFILE = "상대 성향 미반영";

/**
 * The muted reference line of a decision row: what it was judged by. A tournament preflop decision with no computed
 * chart says so ("차트 없음 · 림프 팟"); the cash label is only for the cash table's hand-made chart.
 */
export function referenceLine(d: Decision): string {
  if (d.pack) {
    const f = d.pack.labels.map((l, i) => freqPart(l, d.pack!.freq[i])).join(" / ");
    const loss = d.pack.level === "approx" ? `손실 팟의 ${pct(d.pack.lossPct)}` : `손실 ${r1(d.pack.loss)}bb`;
    const vs = d.pack.reasons.includes(VS_PROFILE) ? ` · ${VS_PROFILE}` : "";
    return `솔버${d.pack.level === "approx" ? " 근사" : ""} · ${f} · ${loss}${vs}`;
  }
  if (d.reason) {
    const best = d.options.filter((o) => o.ev !== null).sort((a, b) => b.ev! - a.ev!)[0];
    return `${d.reason}${best ? ` · 이 AI들 기준 EV 최고: ${best.label.replace(/ ≈$/, "")} ≈` : ""}`;
  }
  if (d.chartInfo) {
    if (!d.chartInfo.source) return `차트 없음 · ${d.chartInfo.none ?? d.summary}`;
    const conf = d.chartInfo.confidence ? ` · 신뢰도 ${d.chartInfo.confidence}` : "";
    const near = d.chartInfo.tags.includes("EV 거의 같음") ? " · EV 거의 같음" : "";
    const vs = d.chartInfo.tags.some((t) => t.includes(VS_PROFILE)) ? ` · ${VS_PROFILE}` : "";
    return `차트 ${(d.chart ?? "").replace(/^솔버 /, "").replace(" — ", " · ")}${conf}${near}${vs}`;
  }
  if (d.chart) return `캐시 차트 (손으로 만든 근사) · ${d.chart}${d.vsProfile ? ` · ${VS_PROFILE}` : ""}`;
  return d.summary;
}

/**
 * The end-of-hand list of my decisions: street, action and mark, then what it was judged by; a row that deviates (✗,
 * △, not the solver's top action, or a 참고 move below the EV model's best) is tinted. Tapping a row opens its full
 * card; [다시 이 상황] replays the spot.
 */
export function HandSummary({ decisions, onReplay }: { decisions: Decision[]; onReplay?: (k: number) => void }) {
  const worst = decisions.findIndex((d) => d.grade === "mistake");
  const firstOk = decisions.findIndex((d) => d.grade === "ok");
  const [open, setOpen] = useState<number | null>(worst >= 0 ? worst : firstOk >= 0 ? firstOk : decisions.length === 1 ? 0 : null);
  return (
    <div className="hand-summary">
      <b className="small">이번 핸드 내 결정 {decisions.length}개</b>
      {decisions.map((d, k) => {
        const dev = d.grade === "mistake" || d.grade === "ok" || offTop(d) || refMiss(d);
        return (
          <div key={k} className={`sum-row ${d.grade} ${dev ? "dev" : ""}`}>
            <button className="sum-main" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
              <span className="sum-line">
                <span>
                  {STREET_LABEL[d.street]} · {d.chosenLabel}
                </span>
                <span className={`sum-mark ${d.grade}`}>{GRADE_MARK[d.grade]}</span>
              </span>
              <span className="sum-ref">{referenceLine(d)}</span>
              {d.foldOut && <span className="sum-ref">{d.foldOut.text}</span>}
            </button>
            {onReplay && (
              <button className="ghost small-btn replay-btn" onClick={() => onReplay(k)}>
                다시 이 상황
              </button>
            )}
            {open === k && <DecisionCard d={d} />}
          </div>
        );
      })}
    </div>
  );
}

export function DecisionCard({ d }: { d: Decision }) {
  const cls = d.grade === "good" ? "correct" : d.grade === "ok" ? "mixed" : d.grade === "mistake" ? "wrong" : "";
  const evs = d.options.filter((o) => o.ev !== null);
  return (
    <section className={`card-box result ${cls}`}>
      <strong>
        {STREET_LABEL[d.street]} · {d.chosenLabel} → {GRADE_TEXT[d.grade]}
      </strong>
      <div className="small">{d.summary}</div>
      {/* A decision with no computed chart already says why in its summary. */}
      {d.chart && d.chartInfo?.source !== null && <div className="muted small">차트: {d.chart}</div>}
      {d.chartInfo && d.chartInfo.tags.length > 0 && <div className="muted small">{d.chartInfo.tags.join(" · ")}</div>}
      {!d.chartInfo && d.vsProfile && <div className="muted small">채점: 캐시 차트 기준 · {VS_PROFILE}</div>}
      {d.pack && (
        <>
          <div className="muted small">
            솔버 팩: {d.pack.title}
            {d.pack.level === "approx" ? " (근사)" : ""}
            {d.pack.reasons.length ? ` · ${d.pack.reasons.join(" · ")}` : ""}
          </div>
          <table className="facts">
            <tbody>
              <tr>
                <th>솔버 액션</th>
                <td>빈도</td>
                <td>EV{d.pack.level === "approx" ? " ≈" : ""}</td>
              </tr>
              {d.pack.labels.map((l, i) => (
                <tr key={i}>
                  <th>{l}</th>
                  <td>{pct(d.pack!.freq[i])}</td>
                  <td>{d.pack!.ev[i] === null ? "-" : `${r1(d.pack!.ev[i]!)}bb`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">EV는 플랍 시작부터 이 핸드가 가져갈 몫(bb){d.pack.level === "approx" ? " · 팩 단위를 실제 팟 크기로 환산" : ""}</div>
        </>
      )}
      {!d.pack && evs.length > 0 && (
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
      {d.foldOut && (
        <div className="muted small">
          {d.foldOut.text} · {foldOutFacts(d.foldOut).join(" · ")}
        </div>
      )}
      <div className="muted small">
        {potText(d)} · 콜 {r1(d.toCall)} · 필요 에퀴티 {pct(d.reqEquity)} · 내 에퀴티 {pct(d.equity)} · SPR {r1(d.spr)}
      </div>
      {d.villains.map((v) => (
        <div key={v.seat} className="muted small">
          {v.seat} 추정 레인지 {Math.round(v.share * 100)}%{v.breakdown ? ` · ${v.breakdown}` : ""}
        </div>
      ))}
    </section>
  );
}
