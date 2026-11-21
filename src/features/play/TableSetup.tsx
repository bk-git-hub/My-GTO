import { useState } from "react";
import { badgeOf, PRESET_IDS, PRESETS, presetOf, type SeatProfile, type Step2, type Sticky } from "../../play/profile";
import type { PlayMode } from "../../play/policy";
import { mixedSeats, seatName, tableSettingsOf, tableStore, updateTable } from "./tableSettings";

/** The CSS class of a profile's badge: gto (grey), pub (amber), tight (blue), aggro (red), custom (outlined). */
export const badgeClass = (p: SeatProfile | null | undefined) => `pbadge ${presetOf(p) ?? "custom"}`;

/** "상대: GTO 5 · 펍 3": the opponents' mix, in preset order, custom seats last. */
export function mixText(seats: readonly SeatProfile[]): string {
  const counts = new Map<string, number>();
  for (const p of seats) counts.set(badgeOf(p), (counts.get(badgeOf(p)) ?? 0) + 1);
  const order = [...PRESET_IDS.map((id) => PRESETS[id].badge), "직접"];
  return `상대: ${order.filter((b) => counts.has(b)).map((b) => `${b} ${counts.get(b)}`).join(" · ")}`;
}

const STEPS: Step2[] = [-2, -1, 0, 1, 2];
const STICKY: { v: Sticky; label: string }[] = [
  { v: 0, label: "보통" },
  { v: 1, label: "많이" },
  { v: 2, label: "아주 많이" },
];
const sign = (x: number) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : "0");

/**
 * The [테이블] card: every opponent's profile, a preset for all of them at once, a random mix, and per seat three
 * small controls (타이트↔루즈, 패시브↔공격, 콜). Applies from the next hand. `opponents`: 8 (9-handed) or 5 (6-max).
 * `posOf(k)`: the position physical seat k holds this hand ("UTG"), so a row can be found on the table.
 */
export function TableSetup({
  opponents,
  mode = "pub",
  posOf,
  packText,
  onClose,
}: {
  opponents: number;
  mode?: PlayMode;
  posOf?: (k: number) => string;
  packText: string;
  onClose: () => void;
}) {
  const t = tableSettingsOf(tableStore.use());
  const [open, setOpen] = useState<number | null>(null);
  const seats = t.seats.slice(0, opponents);

  const setSeat = (k: number, p: SeatProfile) => updateTable((x) => ({ ...x, seats: x.seats.map((q, i) => (i === k ? { ...p } : q)) }));
  const setAll = (p: SeatProfile) => updateTable((x) => ({ ...x, seats: x.seats.map((q, i) => (i < opponents ? { ...p } : q)) }));
  const mix = () => {
    const m = mixedSeats(opponents);
    updateTable((x) => ({ ...x, seats: x.seats.map((q, i) => (i < opponents ? m[i] : q)) }));
  };
  const cycle = (k: number) => {
    const id = presetOf(seats[k]);
    const next = id === null ? "gto" : PRESET_IDS[(PRESET_IDS.indexOf(id) + 1) % PRESET_IDS.length];
    setSeat(k, PRESETS[next].p);
  };

  return (
    <section className="card-box table-setup">
      <div className="row-between">
        <strong>테이블 · 상대 AI</strong>
        <button className="ghost small-btn setup-close" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="muted small setup-mix">{mixText(seats)}</div>
      <div className="setup-all">
        <span className="muted small">모두</span>
        <div className="chips">
          {PRESET_IDS.map((id) => (
            <button key={id} className="chip" onClick={() => setAll(PRESETS[id].p)}>
              {PRESETS[id].label}
            </button>
          ))}
          <button className="chip" onClick={mix}>
            섞기
          </button>
        </div>
      </div>
      <div className="setup-rows">
        {seats.map((p, k) => (
          <div key={k} className="setup-row">
            <div className="row-between">
              <span className="setup-seat">
                {seatName(k + 1, opponents)}
                {posOf?.(k + 1) ? <span className="muted setup-pos"> · 지금 {posOf(k + 1)}</span> : null}
              </span>
              <div className="row-gap">
                <button className={`${badgeClass(p)} big`} onClick={() => cycle(k)} aria-label={`${k + 1}번 자리 성향 바꾸기`}>
                  {presetOf(p) ? PRESETS[presetOf(p)!].label : "직접"}
                </button>
                <button className={`ghost small-btn ${open === k ? "on" : ""}`} onClick={() => setOpen(open === k ? null : k)}>
                  조절
                </button>
              </div>
            </div>
            {open === k && (
              <div className="setup-sliders">
                <Slider left="타이트" right="루즈" value={p.loose} onChange={(v) => setSeat(k, { ...p, loose: v })} />
                <Slider left="패시브" right="공격" value={p.aggro} onChange={(v) => setSeat(k, { ...p, aggro: v })} />
                <div className="slider-row">
                  <span className="slider-side">콜</span>
                  <div className="seg small slider-seg">
                    {STICKY.map((x) => (
                      <button key={x.v} className={p.sticky === x.v ? "on" : ""} onClick={() => setSeat(k, { ...p, sticky: x.v })}>
                        {x.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="muted small">
        다음 핸드부터 적용 · 채점은 늘 {mode === "cash" ? "캐시 차트" : "GTO 차트"}·솔버 기준 · 성향 조절은 근사 모델
        {mode === "cash" ? " · 캐시의 'GTO 차트'는 손으로 만든 근사 차트예요" : ""}
      </p>
      <p className="muted small">{packText}</p>
    </section>
  );
}

function Slider({ left, right, value, onChange }: { left: string; right: string; value: Step2; onChange: (v: Step2) => void }) {
  return (
    <div className="slider-row">
      <span className="slider-side">{left}</span>
      <div className="seg small slider-seg">
        {STEPS.map((v) => (
          <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)} aria-label={`${left} ${right} ${sign(v)}`}>
            {sign(v)}
          </button>
        ))}
      </div>
      <span className="slider-side">{right}</span>
    </div>
  );
}
