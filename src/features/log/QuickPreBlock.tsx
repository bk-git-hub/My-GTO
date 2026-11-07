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

/** Another player's action as the entry screen offers it: no 폴드 (it tells nothing about a range), and 올인 콜 (a call of an all-in open). */
type Choice = PreAction | "allincall";
const OTHER_ACTIONS: Choice[] = ["open", "limp", "call", "3bet", "allin", "allincall"];
const CHOICE_LABEL: Record<Choice, string> = { ...ACTION_LABEL, allincall: "올인 콜" };
const chipsOf = (bb: number, bbChips: number) => Math.round(bb * bbChips).toLocaleString();

/**
 * A preflop block, one row each: the stack stage (on the label line), the subject's action, the open's
 * size, who opened, the 3-bet. Rows after the action show only when they apply to it. `other`: another
 * player's hand (actions 오픈 · 림프 · 콜 · 3벳 · 올인 · 올인 콜). `onChange` gets the block as edited;
 * the screen tidies it (stage, seats) as it saves.
 */
export function QuickPreBlock({ h, bb, last, seats, onChange, other }: { h: LoggedHand; bb: number | null; last: PreStage | null; seats: string[]; onChange: (pre: QuickPre) => void; other?: boolean }) {
  const p: QuickPre = h.quickPre ?? {};
  const stage = stageOf(h.quickPre, bb, last);
  const bbChips = levelInfo(h.level)?.bb ?? null;
  const choice: Choice | null = other && p.action === "call" && p.openAllIn ? "allincall" : (p.action ?? null);
  const rows = choice === "allincall" ? { ...preRows(p), size: false } : preRows(p);
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
  const pickAction = (a: Choice) => {
    const off = choice === a;
    let next = withAction({ ...p, stage }, off ? undefined : a === "allincall" ? "call" : a);
    // 올인 콜: a call of an all-in open (no size); 콜 after it: an open with a size again.
    if (!off && a === "allincall") next = { ...next, openAllIn: true, openBb: undefined };
    else if (!off && a === "call" && choice === "allincall") next = { ...next, openAllIn: undefined };
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
            <button type="button" onClick={() => put({ pinned: undefined })} aria-label={other ? "스택 구간 자동으로 (스택·레벨 따라가기)" : "스택 구간 자동으로 (내 스택 따라가기)"}>
              자동
            </button>
          ) : bb !== null ? (
            <small title={other ? "상대 스택으로 정해져요" : "내 스택으로 정해져요"}>자동</small>
          ) : null}
        </span>
      </div>
      <ChipRow<Choice> items={other ? OTHER_ACTIONS : PRE_ACTIONS} value={choice} label={(a) => CHOICE_LABEL[a]} onPick={pickAction} className="fill pre-acts" />
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
