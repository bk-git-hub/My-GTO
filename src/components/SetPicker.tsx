import { chartSetId, chartSetMenu } from "../data/charts";
import { settingsStore, useSettings } from "../state/settings";

/** Chooses which chart set the charts and quizzes use (saved in settings). Listing a set never builds it. */
export function SetPicker() {
  const { chartSet } = useSettings();
  return (
    <label className="set-switch">
      <span className="muted small">차트</span>
      <select
        className="select"
        value={chartSetId(chartSet)}
        onChange={(e) => settingsStore.set((s) => ({ ...s, chartSet: e.target.value, chartSetPicked: true }))}
      >
        {chartSetMenu().map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SeatRow({ positions, hero, villains }: { positions: string[]; hero: string; villains: string[] }) {
  return (
    <div className="table-seats" style={{ ["--seats" as string]: positions.length }}>
      {positions.map((p) => (
        <span key={p} className={`seat ${p === hero ? "hero" : ""} ${villains.includes(p) ? "villain" : ""}`}>
          {p}
          {villains.includes(p) && <em>상대</em>}
          {p === hero && <em>나</em>}
        </span>
      ))}
    </div>
  );
}
