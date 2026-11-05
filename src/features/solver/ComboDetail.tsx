import { cardFromString, comboCount, type HandClass } from "../../poker/cards";
import { comboRows, type DecodedNode, type HandAggregate } from "../../presolve/format";
import { MiniCard, MixBar } from "./parts";
import { bestAction, evTolerance, fmtEv, pct } from "./view";

/** Hand-class detail at a node: the class mix, then every stored combo with its frequency and EV per action. */
export function ComboDetail({
  node,
  hand,
  agg,
  colors,
  who,
  unblocked,
  onClose,
}: {
  node: DecodedNode;
  hand: HandClass;
  agg: HandAggregate;
  colors: string[];
  who: string;
  /** Combos of the class not blocked by the board. */
  unblocked: number;
  onClose: () => void;
}) {
  const labels = node.actions.map((a) => a.label);
  const rows = comboRows(node, undefined, hand);
  // Near-equal EVs are ties (mixed actions have equal EVs at equilibrium): the more frequent action gets the mark.
  const tol = evTolerance(node.pot);
  const classBest = bestAction(agg.ev, agg.freq, tol);
  return (
    <section className="card-box sv-detail" aria-label={`${hand} 상세`}>
      <div className="row-between">
        <h3>
          {hand}{" "}
          <span className="muted small">
            {agg.combos}/{unblocked}콤보{unblocked < comboCount(hand) ? ` (보드 블록 ${comboCount(hand) - unblocked})` : ""}
          </span>
        </h3>
        <button className="ghost small" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      {agg.combos === 0 ? (
        <p className="muted small">이 노드에서 {who} 레인지에 {hand} 콤보가 없어요.</p>
      ) : (
        <>
          <MixBar freq={agg.freq} colors={colors} labels={labels} />
          <div className="sv-ctable" style={{ ["--n" as string]: labels.length }}>
            <div className="sv-crow head">
              <span>콤보</span>
              {labels.map((l, a) => (
                <span key={a}>
                  <i style={{ background: colors[a] }} />
                  {l}
                </span>
              ))}
            </div>
            <div className="sv-crow avg">
              <span>
                평균
                <small>EV {fmtEv(agg.evNode)}</small>
              </span>
              {labels.map((_, a) => (
                <span key={a} className={a === classBest ? "best" : ""}>
                  <b>{pct(agg.freq[a])}</b>
                  <small>{fmtEv(agg.ev[a])}</small>
                </span>
              ))}
            </div>
            {rows.map((r) => {
              const best = bestAction(r.ev, r.freq, tol);
              return (
                <div key={r.index} className="sv-crow">
                  <span className="sv-combo">
                    <span className="sv-mcs">
                      <MiniCard card={cardFromString(r.cards.slice(0, 2))} />
                      <MiniCard card={cardFromString(r.cards.slice(2, 4))} />
                    </span>
                    <small>
                      EV {fmtEv(r.evNode)}
                      {r.reach < 0.995 ? ` · 도달 ${pct(r.reach)}` : ""}
                    </small>
                  </span>
                  {r.freq.map((f, a) => (
                    <span key={a} className={`${a === best ? "best" : ""} ${f < 0.005 ? "zero" : ""}`}>
                      <b>{pct(f)}</b>
                      <small>{fmtEv(r.ev[a])}</small>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="muted small">
            위: 빈도 · 아래: 그 액션 후 EV(bb, 플랍 시작 기준 순이익). 테두리 = EV가 가장 높은 액션 (EV 차이가 {fmtEv(tol)}bb 이내면 동률로 보고 더 자주
            쓰는 쪽).
          </p>
        </>
      )}
    </section>
  );
}
