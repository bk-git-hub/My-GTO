import type { PackEntry } from "../../presolve/format";
import { fmtBb, formatName, playerName, startStack } from "./view";

/** The list of packs (scenarios) in the manifest. */
export function ScenarioPicker({ packs, onPick }: { packs: PackEntry[]; onPick: (id: string) => void }) {
  return (
    <div className="page sv">
      <p className="muted small">
        미리 계산한 헤즈업 플랍 전략이에요. 시나리오를 고르면 플랍별 리포트를 보고, 플랍을 눌러 핸드별 전략과 EV를 볼 수 있어요.
      </p>
      <div className="sv-packs">
        {packs.map((p) => {
          const m = p.scenario;
          const start = startStack(p.id);
          return (
            <button key={p.id} className="sv-pack" onClick={() => onPick(p.id)}>
              <span className="row-between">
                <b>{p.title}</b>
                <span className={`sv-tier ${p.tier}`}>{p.tier === "pro" ? "Pro" : "무료"}</span>
              </span>
              <span className="sv-tags">
                <span className="sv-tag">{formatName(m)}</span>
                {start !== null && <span className="sv-tag">{start}bb</span>}
                <span className="sv-tag">
                  {playerName(m, 0)} vs {playerName(m, 1)}
                </span>
              </span>
              <span className="muted small">
                {m.preflop ? `${m.preflop} · ` : ""}플랍 팟 {fmtBb(m.pot)}bb · 스택 {fmtBb(m.stack)}bb · 플랍 {p.files.length}개
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
