import type { CatalogPack } from "../../presolve/format";
import { fmtBb, formatName, playerName, startStack } from "./view";

export type PickerPack = Pick<CatalogPack, "id" | "title" | "tier" | "scenario" | "flops">;

/** Pack cards: the packs that are not in the spot picker's grid (the earlier cash and pub-chart packs). */
export function ScenarioPicker({ packs, onPick }: { packs: PickerPack[]; onPick: (id: string) => void }) {
  return (
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
              {m.preflop ? `${m.preflop} · ` : ""}플랍 팟 {fmtBb(m.pot)}bb · 스택 {fmtBb(m.stack)}bb · 플랍 {p.flops}개
            </span>
          </button>
        );
      })}
    </div>
  );
}
