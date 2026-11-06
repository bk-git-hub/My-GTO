import { useState } from "react";
import { levelInfo, shoveBb, type LoggedHand } from "./handLog";
import { ChipRow, ChipsInput } from "./inputs";
import {
  ACTION_LABEL,
  openPresets,
  PRE_ACTIONS,
  PRE_STAGES,
  preRows,
  STAGE_LABEL,
  stageOf,
  THREE_BET_PRESETS,
  threeBetBb,
  threeBetShown,
  withAction,
  type PreAction,
  type PreSize,
  type PreStage,
  type QuickPre,
} from "./quickPre";

const sizeLabel = (x: PreSize, unit: string) => (x === "allin" ? "올인" : `${x}${unit}`);
const chipsOf = (bb: number, bbChips: number) => Math.round(bb * bbChips).toLocaleString();

/**
 * The quick screen's preflop block, one row each: the stack stage (on the label line), my action, the
 * open's size, who opened, my 3-bet. Rows after the action show only when they apply to it.
 * `onChange` gets the block as edited; the screen tidies it (stage, seats) as it saves.
 */
export function QuickPreBlock({ h, bb, last, seats, onChange }: { h: LoggedHand; bb: number | null; last: PreStage | null; seats: string[]; onChange: (pre: QuickPre) => void }) {
  const p: QuickPre = h.quickPre ?? {};
  const stage = stageOf(h.quickPre, bb, last);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const rows = preRows(p);
  const presets = openPresets(stage, p.action);
  /**
   * The bb field stays once it is in use (직접 tapped, focused, or a typed size when the hand opened),
   * until a size chip is tapped: typing through a preset's value ("2.5" → "2.") or clearing it must not
   * swap it for a chip mid-edit. Without that, it shows only for a size that isn't a chip here.
   */
  const [custom, setCustom] = useState(() => p.openBb !== undefined && !presets.includes(p.openBb));
  /** 직접 was just tapped: the new field takes the focus. */
  const [focusTyped, setFocusTyped] = useState(false);
  const typedSize = custom || (p.openBb !== undefined && !presets.includes(p.openBb));
  const put = (patch: Partial<QuickPre>) => onChange({ ...p, stage, ...patch });
  const openers = seats.filter((s) => s !== h.seat);
  const cap = shoveBb(h);
  const tb = threeBetBb(p);
  const tbShown = threeBetShown(p, cap);

  const pickOpen = (x: PreSize) => {
    setCustom(false);
    if (x === "allin") put({ openAllIn: p.openAllIn ? undefined : true, openBb: undefined });
    else put({ openBb: !typedSize && p.openBb === x ? undefined : x, openAllIn: undefined });
  };
  const pickAction = (a: PreAction) => {
    const next = withAction({ ...p, stage }, p.action === a ? undefined : a);
    // The size went with the old action: the field goes too.
    if (next.openBb === undefined) setCustom(false);
    onChange(next);
  };
  /** The open's amount: in chips when the level is known; my own open that reaches my stack is an all-in. */
  const openAmt = (): string => {
    if (p.openBb === undefined) return "";
    if (p.action === "open" && cap !== null && p.openBb >= cap) return `올인 ${cap}bb`;
    return bbChips ? `= ${chipsOf(p.openBb, bbChips)}` : "";
  };
  /** My 3-bet: "10.5bb = 8,400", or "올인 8bb" once it reaches my stack. */
  const threeAmt = (): string => {
    if (p.threeBetAllIn || tb === null) return "";
    if (tbShown === "allin") return cap !== null ? `올인 ${cap}bb` : "올인";
    return `${tb}bb${bbChips ? ` = ${chipsOf(tb, bbChips)}` : ""}`;
  };
  const openOn = (x: PreSize) => !typedSize && (x === "allin" ? p.openAllIn === true : p.openBb === x);
  const threeOn = (x: PreSize) => (x === "allin" ? p.threeBetAllIn === true : p.threeBetX === x);

  return (
    <div className="memo-sec quick-pre">
      <div className="pre-head">
        <span className="flow-label">프리플랍</span>
        <ChipRow
          items={PRE_STAGES}
          value={stage}
          label={(s) => STAGE_LABEL[s]}
          // A tap fixes the stage for this hand; tapping the fixed one again lets it follow my stack.
          onPick={(s) => put(s === stage && p.pinned ? { pinned: undefined } : { stage: s, pinned: true })}
          className="pre-stage"
        />
        {/* Fixed width either way, so the stage chips never shift. */}
        <span className="pre-auto">
          {p.pinned ? (
            <button type="button" onClick={() => put({ pinned: undefined })} aria-label="스택 구간 자동으로 (내 스택 따라가기)">
              자동
            </button>
          ) : bb !== null ? (
            <small title="내 스택으로 정해져요">자동</small>
          ) : null}
        </span>
      </div>
      <ChipRow items={PRE_ACTIONS} value={p.action ?? null} label={(a) => ACTION_LABEL[a]} onPick={pickAction} className="fill pre-acts" />
      {rows.size && (
        <div className="pre-line">
          <span className="pre-k">오픈</span>
          <div className="flow-chips one pre-chips">
            {presets.map((x) => (
              <button key={x} type="button" className={openOn(x) ? "on" : ""} onClick={() => pickOpen(x)}>
                {sizeLabel(x, "bb")}
              </button>
            ))}
            {typedSize ? (
              <label className="pre-typed on" onFocus={() => setCustom(true)}>
                <ChipsInput value={p.openBb ?? null} unit="bb" onChange={(v) => put({ openBb: v !== null && v > 0 ? v : undefined, openAllIn: undefined })} placeholder="0" autoFocus={focusTyped} ariaLabel="오픈 크기 직접 입력 (bb)" />
                <i>bb</i>
              </label>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCustom(true);
                  setFocusTyped(true);
                }}
              >
                직접
              </button>
            )}
          </div>
          <small className="pre-amt">{openAmt()}</small>
        </div>
      )}
      {rows.opener && (
        <div className="pre-line">
          <span className="pre-k">자리</span>
          <ChipRow items={openers} value={p.openerSeat ?? null} onPick={(s) => put({ openerSeat: p.openerSeat === s ? undefined : s })} className={`seats pre-seats n${openers.length}`} />
        </div>
      )}
      {rows.threeBet && (
        <div className="pre-line">
          <span className="pre-k">3벳</span>
          <div className="flow-chips one pre-chips">
            {THREE_BET_PRESETS.map((x) => (
              <button
                key={x}
                type="button"
                className={threeOn(x) ? "on" : ""}
                onClick={() => (x === "allin" ? put({ threeBetAllIn: p.threeBetAllIn ? undefined : true, threeBetX: undefined }) : put({ threeBetX: p.threeBetX === x ? undefined : x, threeBetAllIn: undefined }))}
              >
                {x === "allin" ? "올인" : `×${x}`}
              </button>
            ))}
          </div>
          <small className="pre-amt">{threeAmt()}</small>
        </div>
      )}
    </div>
  );
}
