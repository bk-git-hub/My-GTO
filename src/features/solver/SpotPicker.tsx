import { useState } from "react";
import type { Catalog } from "../../presolve/format";
import { APP_STACKS, catalogStacks, DEFAULT_STACK, findPack, otherPacks, SPOT_ROWS, spotLabel, type PotKind, type SpotHit } from "./registry";
import { ScenarioPicker } from "./ScenarioPicker";
import { fmtBb } from "./view";

/** Flop classes a full pack covers (format.ts flopClasses). */
const FULL = 1755;
const PICK_KEY = "pubaj.solver.pick";

export interface SpotChoice {
  stack: number;
  pot: PotKind;
}

function loadPick(): SpotChoice {
  try {
    const j = JSON.parse(localStorage.getItem(PICK_KEY) ?? "null") as Partial<SpotChoice> | null;
    if (j && APP_STACKS.includes(j.stack as number) && (j.pot === "srp" || j.pot === "3bp")) return { stack: j.stack as number, pot: j.pot };
  } catch {
    /* no storage */
  }
  return { stack: DEFAULT_STACK, pot: "srp" };
}

function savePick(p: SpotChoice) {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(p));
  } catch {
    /* no storage */
  }
}

/**
 * The solver chart's packs as a grid of spots: stack and pot, then one row per seat. A row opens the pack's report; a
 * pack that is still being solved shows how many flops it has, one with no flop yet is shown as 준비 중. A pack whose
 * starting ranges include one the chart rates 낮음 says so. While no row of the chosen stack and pot has a flop yet (the
 * first days of the queue), the earlier packs below are shown opened, so the packs that work stay in sight.
 */
export function SpotPicker({ catalog, onPick, initial }: { catalog: Pick<Catalog, "packs" | "planned">; onPick: (id: string) => void; initial?: SpotChoice }) {
  const [pick, setPick] = useState<SpotChoice>(() => initial ?? loadPick());
  const set = (p: SpotChoice) => {
    setPick(p);
    savePick(p);
  };
  const stacks = catalogStacks(catalog);
  const others = otherPacks(catalog);
  const fmtInt = (n: number) => n.toLocaleString("en-US");
  const rows = SPOT_ROWS[pick.pot].map((row) => ({ row, hit: findPack(catalog, { stack: pick.stack, pot: pick.pot, ...row }) }));
  const anyFiles = rows.some((r) => r.hit?.kind === "pack");
  const anyLow = rows.some((r) => spotOf(r.hit)?.confidence === "low");
  return (
    <div className="page sv">
      <p className="muted small">계산된 헤즈업 플랍 전략이에요. 스택과 팟을 고르고 자리를 누르세요.</p>
      {stacks.length > 0 ? (
        <>
          <div className="seg" role="group" aria-label="스택">
            {APP_STACKS.map((s) => (
              <button key={s} className={pick.stack === s ? "on" : ""} aria-pressed={pick.stack === s} onClick={() => set({ ...pick, stack: s })}>
                {s}bb
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="팟">
            {(["srp", "3bp"] as const).map((k) => (
              <button key={k} className={pick.pot === k ? "on" : ""} aria-pressed={pick.pot === k} onClick={() => set({ ...pick, pot: k })}>
                {k === "srp" ? "싱글 레이즈" : "3벳 팟"}
              </button>
            ))}
          </div>
          {!anyFiles && others.length > 0 && <p className="notice small">아직 계산 중이에요. 그동안 아래 이전 차트 팩을 볼 수 있어요.</p>}
          <div className="sv-packs">
            {rows.map(({ row, hit }) => {
              const label = spotLabel({ pot: pick.pot, ...row });
              const key = `${row.raiser}-${row.caller}`;
              const low = spotOf(hit)?.confidence === "low" && <span className="sv-low">프리플랍 신뢰도 낮음</span>;
              if (!hit || hit.kind === "planned") {
                const pp = hit?.planned;
                return (
                  <button key={key} className="sv-spot off" disabled>
                    <span className="row-between">
                      <b>{label}</b>
                      <span className="sv-planned">준비 중</span>
                    </span>
                    {pp && (
                      <span className="muted small">
                        {potLine(pp.pot, pp.stack)}
                        {low}
                      </span>
                    )}
                  </button>
                );
              }
              const p = hit.pack;
              const done = p.flops >= FULL;
              return (
                <button key={key} className="sv-spot" onClick={() => onPick(p.id)}>
                  <span className="row-between">
                    <b>{label}</b>
                    <span className="small muted">{done ? "완료" : `플랍 ${fmtInt(p.flops)}/${fmtInt(FULL)}`}</span>
                  </span>
                  <span className="muted small">
                    {potLine(p.scenario.pot, p.scenario.stack)}
                    {low}
                  </span>
                  <span className="sv-progress" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, (p.flops / FULL) * 100).toFixed(1)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
          {anyLow && <p className="muted small">프리플랍 신뢰도 낮음: 시작 레인지가 된 프리플랍 차트가 덜 확실한 팟이에요. 플랍 전략은 그 레인지 기준이에요.</p>}
        </>
      ) : (
        <p className="notice small">계산된 차트 팩은 준비 중이에요.</p>
      )}
      {others.length > 0 && (
        <details className="sv-others" open={stacks.length === 0 || !anyFiles}>
          <summary>다른 팩 (이전 차트)</summary>
          <ScenarioPicker packs={others} onPick={onPick} />
        </details>
      )}
    </div>
  );
}

function potLine(pot: number, stack: number): string {
  return `팟 ${fmtBb(pot)}bb · 스택 ${fmtBb(stack)}bb · SPR ${fmtBb(stack / pot)}`;
}

const spotOf = (hit: SpotHit | null) => (hit ? (hit.kind === "pack" ? hit.pack.spot : hit.planned.spot) : undefined);
