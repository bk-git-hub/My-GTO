import { useState, type PointerEvent, type ReactNode } from "react";
import { bbPart, bbText1, MINUS, seriesAt, signedText, type ChipSeries } from "./fastChips";
import { Bb } from "./FastResult";
import { holeClass, type LoggedHand } from "./handLog";

/**
 * 오늘 빠른 기록's chip run: one gold line over the session's hands (the section title names it, so no
 * legend), the start as a dashed baseline with its value, a hollow ring where 지금 스택 was typed, a dashed
 * jump where it disagreed with the count, the last point in gold. Inline SVG, no animation. Tap or drag
 * across it: a crosshair and that hand in the readout line under it (fixed height, nothing moves); the
 * list below is its table.
 */

const W = 320;
const H = 96;
const X0 = 8;
const X1 = 312;
const Y0 = 10;
const Y1 = 86;

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** A point's value: a stack ("50,000", "83.3bb") or a running total ("+3,000", "−4bb", "0"). */
function valueText(y: number, s: ChipSeries, signed: boolean): string {
  if (s.unit === "bb") {
    const r = Math.round(y * 10) / 10;
    if (!signed) return bbText1(r);
    return r === 0 ? "0bb" : `${r > 0 ? "+" : MINUS}${bbText1(Math.abs(r))}`;
  }
  const c = Math.round(y);
  if (!signed) return c.toLocaleString();
  return c === 0 ? "0" : signedText(c, "chips");
}

/** `title` names the run for screen readers (the section's title: "오늘 칩 흐름", a tournament's "칩 흐름"). */
export function ChipGraph({ series: s, hands, title = "오늘 칩 흐름" }: { series: ChipSeries; hands: LoggedHand[]; title?: string }) {
  const [tapped, setPick] = useState<number | null>(null);
  const n = hands.length;
  // A hand deleted since the tap: the crosshair stays on the graph.
  const pick = tapped === null ? null : Math.min(tapped, n);
  const base = s.absolute ? s.start : 0;
  const lo = Math.min(s.min, base);
  const hi = Math.max(s.max, base);
  const pad = (hi - lo || Math.max(Math.abs(hi), 1)) * 0.08;
  const ymin = lo - pad;
  const ymax = hi + pad;
  const sx = (x: number) => X0 + (n ? (x / n) * (X1 - X0) : 0);
  const sy = (y: number) => Y1 - ((y - ymin) / (ymax - ymin)) * (Y1 - Y0);
  const f1 = (v: number) => Math.round(v * 10) / 10;
  const line = (seg: ChipSeries["segments"][number]) => seg.map((p, i) => `${i ? "L" : "M"}${f1(sx(p.x))} ${f1(sy(p.y))}`).join(" ");
  const area = (seg: ChipSeries["segments"][number]) => `${line(seg)} L${f1(sx(seg[seg.length - 1].x))} ${f1(sy(base))} L${f1(sx(seg[0].x))} ${f1(sy(base))} Z`;
  const last = s.segments[s.segments.length - 1];
  const end = last[last.length - 1];
  const rel = !s.absolute;
  const high = valueText(s.max, s, rel);
  const low = valueText(s.min, s, rel);
  const summary = rel ? `0에서 · 최고 ${high} · 최저 ${low}` : `시작 ${valueText(s.start, s, false)} · 지금 ${valueText(s.end, s, false)} · 최고 ${high} · 최저 ${low}`;

  function at(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !n) return;
    const vx = ((e.clientX - r.left) / r.width) * W;
    setPick(Math.max(0, Math.min(n, Math.round(((vx - X0) / (X1 - X0)) * n))));
  }

  let readout: ReactNode = summary;
  if (pick !== null) {
    const v = seriesAt(s, pick);
    const h = pick >= 1 ? hands[pick - 1] : null;
    if (v !== null && h) {
      // The hand's chips in both units, the bb in its color: "+12,800 +25.6bb".
      const chips = h.net === null ? "결과 없음" : h.result === "fold" && !h.net ? "폴드" : signedText(h.net, "chips");
      const bb = h.net ? bbPart(h.net, h.level, true) : null;
      readout = (
        <>
          {`${pick}번째 · ${clock(h.createdAt)} ${h.seat} ${holeClass(h)} ${chips}`}
          {bb && (
            <>
              {" "}
              <Bb v={bb} />
            </>
          )}
          {` → ${rel ? `누적 ${valueText(v, s, true)}` : valueText(v, s, false)}`}
        </>
      );
    } else if (v !== null) readout = rel ? "시작 · 0" : `시작 ${valueText(v, s, false)}`;
  }

  return (
    <div className="chip-graph-box">
      <svg
        className="chip-graph"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: ${rel ? "0" : valueText(s.start, s, false)}에서 지금 ${valueText(s.end, s, rel)}, 최고 ${high}, 최저 ${low}`}
        onPointerDown={at}
        onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? at(e) : undefined)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setPick(null)}
      >
        {s.segments.map((seg, i) => (
          <path key={`a${i}`} className="cg-area" d={area(seg)} />
        ))}
        <line className="cg-base" x1={X0} x2={X1} y1={f1(sy(base))} y2={f1(sy(base))} />
        <text className="cg-base-label" x={X1} y={f1(sy(base)) - 3} textAnchor="end">
          {rel ? "0" : valueText(base, s, false)}
        </text>
        {s.jumps.map((j, i) => (
          <line key={`j${i}`} className="cg-jump" x1={f1(sx(j.x))} x2={f1(sx(j.x))} y1={f1(sy(j.from))} y2={f1(sy(j.to))} />
        ))}
        {s.segments.map((seg, i) => (
          <path key={`l${i}`} className="cg-line" d={line(seg)} />
        ))}
        {s.anchors.map((a, i) => (
          <circle key={`o${i}`} className="cg-anchor" cx={f1(sx(a.x))} cy={f1(sy(a.y))} r={4} />
        ))}
        {pick !== null && <line className="cg-cross" x1={f1(sx(pick))} x2={f1(sx(pick))} y1={Y0 - 6} y2={Y1 + 6} />}
        <circle className="cg-last" cx={f1(sx(end.x))} cy={f1(sy(end.y))} r={4} />
      </svg>
      <p className="cg-read" aria-live="polite">
        {readout}
      </p>
      {s.unknown > 0 && <p className="cg-note muted">결과 없는 핸드 {s.unknown}개는 0으로 셌어요</p>}
    </div>
  );
}
