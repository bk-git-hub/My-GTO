import { useState } from "react";
import { ChipsPad } from "./CalcSheet";
import { bbPart, chipsText, handLv, signedText } from "./fastChips";
import { Bb } from "./FastResult";
import { clockOf, type SettleSpan } from "./fastTourney";
import { holeClass, type LoggedHand } from "./handLog";

/** "14:05 BTN AQo · + 수익" (a hand saved without its cards: no class). */
const handLine = (h: LoggedHand): string => `${clockOf(h.createdAt)} ${h.seat}${holeClass(h) ? ` ${holeClass(h)}` : ""} · ${h.result === "win" ? "+ 수익" : "− 손실"}`;

/**
 * ⏳ 정리: the ⏳ hands a known stack ends, one at a time (oldest first), each typed in chips (its sign is the one it
 * was saved with; 모름 leaves it ⏳). Ended by a 칩 업데이트: the last one takes what is left, so it isn't asked.
 * Ended by a 스택 hand: every ⏳ hand is asked, and that hand takes what is left.
 */
export function SettleSheet(p: {
  span: SettleSpan;
  /** Saves the chips worked out (hand id → chips): an error to show, or null when saved. */
  onSave: (nets: Map<string, number>, note: string) => string | null;
  onClose: () => void;
}) {
  const { pending, total, end } = p.span;
  // Asked: all but the last when a 칩 업데이트 ends them (it takes the rest), else all of them.
  const asked = end ? pending : pending.slice(0, -1);
  const [i, setI] = useState(0);
  const [vals, setVals] = useState<(number | null)[]>([]);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const h = asked[i];
  const typed = /^\d{1,9}$/.test(text) ? Number(text) : null;
  const signOf = (x: LoggedHand) => (x.result === "lose" ? -1 : 1);
  const now = typed === null ? null : signOf(h) * typed;
  const sumOf = (xs: (number | null)[]) => xs.reduce<number>((t, v) => t + (v ?? 0), 0);
  const left = total - sumOf(vals) - (now ?? 0);
  const lastStep = i === asked.length - 1;
  const unknown = vals.some((v) => v === null);
  /** Who takes what is left: the last ⏳ hand, or the 스택 hand. */
  const taker = end ? "이 핸드 (스택)" : `${holeClass(pending[pending.length - 1]) || pending[pending.length - 1].seat}`;

  function finish(all: (number | null)[]) {
    const nets = new Map<string, number>();
    asked.forEach((x, k) => {
      const v = all[k];
      if (v !== null && v !== undefined) nets.set(x.id, v);
    });
    let note = "";
    if (!end && !all.some((v) => v === null)) {
      const last = pending[pending.length - 1];
      const rest = total - sumOf(all);
      nets.set(last.id, rest);
      if ((last.result === "win" && rest < 0) || (last.result === "lose" && rest > 0)) note = ` · ${handLine(last)}인데 ${signedText(rest, "chips")}이 남아 그대로 적었어요`;
    }
    const e = p.onSave(nets, note);
    if (e) setErr(e);
  }
  function step(v: number | null) {
    const all = [...vals.slice(0, i), v];
    setVals(all);
    setText("");
    setErr(null);
    if (lastStep) finish(all);
    else setI(i + 1);
  }

  const line = err ? (
    <span className="calc-err" role="alert">
      {err}
    </span>
  ) : lastStep && !unknown ? (
    <>
      <small>남은 건 {taker}</small> <b className={left > 0 ? "up" : left < 0 ? "down" : undefined}>{signedText(left, "chips")}</b>
    </>
  ) : (
    <>
      <small>⏳ 합계</small> <b className={total > 0 ? "up" : total < 0 ? "down" : undefined}>{signedText(total, "chips")}</b> <Bb v={bbPart(total, handLv(h), true)} />
    </>
  );
  return (
    <ChipsPad
      label="⏳ 정리"
      title={`⏳ 정리 ${i + 1}/${asked.length}`}
      note={handLine(h)}
      value={text}
      placeholder={h.result === "win" ? "얼마 땄어요?" : "얼마 잃었어요?"}
      bb={typed !== null ? bbPart(typed, handLv(h)) : null}
      line={line}
      lineClass={err ? "bad" : undefined}
      left={{ label: "모름", onClick: () => step(null) }}
      right={{
        label: lastStep ? "저장" : "다음",
        onClick: () => (typed === null ? setErr(`금액을 넣어 주세요 · 모르면 모름 (${chipsText(Math.abs(total))} 중)`) : step(now)),
      }}
      onValue={(v) => {
        setText(v);
        setErr(null);
      }}
      onClose={p.onClose}
    />
  );
}
