import { useMemo } from "react";
import { ChipGraph } from "./ChipGraph";
import { chipSeries, marksOf, missedOf, oldestFirst, sessionMoney, signedText, type Unit } from "./fastChips";
import { hasChips, type FastStats } from "./fastLog";
import { MarksText, MoneyHead } from "./FastResult";
import { VERDICT_MARK } from "./fastVerdict";
import { fastActed, fastActText, fastVerdictOf, holeClass, type LoggedHand } from "./handLog";

/**
 * The pieces 빠른 기록's list of hands is made of, shared by its own screen and the tournament screens: a
 * hand's row, the chart line, and the total with the chip graph.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "21:05". */
export const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** A verdict for a list row: "⚠ 오버 (폴드)", "▽ 언더 (오픈 72%)", another player's "⚠ 루즈 (폴드)", "차트 없음". */
const shortVerdict = (t: string) =>
  t.replace(/ · 솔버 \d+bb 기준$/, "").replace("오버플레이", "오버").replace("언더플레이", "언더").replace("차트보다 루즈", "루즈").replace("차트보다 타이트", "타이트").replace("차트: ", "").replace(" · 림프 팟", "");

/** A list row's chips: "+12,000" / "−6bb" in the unit shown, 폴드 (with the blind it cost: "폴드 −200"), 본전, or – for none. */
function netShown(h: LoggedHand, view: Unit): string {
  if (h.result === "fold") return h.net ? `폴드 ${signedText(h.net, view, h.level)}` : "폴드";
  if (h.net !== null && h.net !== 0) return signedText(h.net, view, h.level);
  if (h.net === 0) return "본전";
  return h.result === "win" ? "수익" : h.result === "lose" ? "손실" : "–";
}

/** Plain text to the clipboard: the async API, else a hidden textarea (older iOS). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back below */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * One hand in the list. 빠른 기록's chips and board: the hand, its seat, the chips (in the unit shown), the
 * board as remembered (a decision's mark at the end). Else (another player's, or an old hand with no chips):
 * its action and the chart's verdict. `editing`: the hand open in the editor (ringed).
 */
export function FastItem({ h, view, other, editing, onClick }: { h: LoggedHand; view: Unit; other: boolean; editing: boolean; onClick: () => void }) {
  const v = fastVerdictOf(h);
  const k = v?.kind ?? "none";
  if (!other && hasChips(h)) {
    const net = h.net ?? 0;
    return (
      <button type="button" className={`fast-item res v-${k}${editing ? " editing" : ""}`} onClick={onClick}>
        <span className="fi-time">{clock(h.createdAt)}</span>
        <b className="fi-seat">{h.seat}</b>
        <b className="fi-class">{holeClass(h)}</b>
        <span className={`fi-net${h.result === "fold" ? " fold" : net > 0 ? " up" : net < 0 ? " down" : ""}`}>{netShown(h, view)}</span>
        <MarksText className="fi-board" marks={marksOf(h.board, h.guess?.board)} />
        {fastActed(h) && <span className="fi-verdict">{VERDICT_MARK[k]}</span>}
      </button>
    );
  }
  const said = fastActText(h);
  return (
    <button type="button" className={`fast-item v-${k}${editing ? " editing" : ""}`} onClick={onClick}>
      <span className="fi-time">{clock(h.createdAt)}</span>
      <b className="fi-seat">{h.seat}</b>
      <b className="fi-class">{holeClass(h)}</b>
      <span className="fi-act">{said}</span>
      <span className="fi-verdict">{k === "ok" || k === "mixed" ? VERDICT_MARK[k] : v && v.text !== said ? shortVerdict(v.text) : VERDICT_MARK.none}</span>
    </button>
  );
}

/** The chart line: 차트대로 out of the graded hands, overplays, underplays, mixed, none (nothing without a hand graded or not). */
export function FastStatsRow({ stats, other }: { stats: FastStats; other: boolean }) {
  if (!stats.total) return null;
  return (
    <div className="fast-stats">
      <span className="v-ok">
        차트대로 <b>{stats.okPct ?? 0}%</b> <small>({stats.by.ok}/{stats.graded})</small>
      </span>
      <span className="v-over">
        ⚠ {other ? "루즈" : "오버"} {stats.by.over}
      </span>
      <span className="v-under">
        ▽ {other ? "타이트" : "언더"} {stats.by.under}
      </span>
      <span className="v-mixed">△ 섞음 {stats.by.mixed}</span>
      {stats.by.none ? <span className="v-none">차트 없음 {stats.by.none}</span> : null}
    </div>
  );
}

/**
 * The hands' total with the 칩 | bb toggle and the chip graph (from the tournament's start stack when known),
 * or what to do for one. `title` names the graph ("오늘 칩 흐름", a tournament's "칩 흐름").
 */
export function ChipsBlock({ hands, view, onView, startStack = null, title = "오늘 칩 흐름" }: { hands: LoggedHand[]; view: Unit; onView: (u: Unit) => void; startStack?: number | null; title?: string }) {
  const money = useMemo(() => sessionMoney(hands), [hands]);
  const series = useMemo(() => chipSeries(hands, view, startStack), [hands, view, startStack]);
  const missed = useMemo(() => missedOf(hands, startStack), [hands, startStack]);
  return series ? (
    <>
      <MoneyHead money={money} missed={missed} view={view} onView={onView} />
      <ChipGraph series={series} hands={oldestFirst(hands)} title={title} />
      {series.unit !== view && <p className="muted small fast-note">레벨이 없어서 칩으로 보여요</p>}
    </>
  ) : (
    <p className="muted small fast-note">{`결과를 넣으면 ${title === "오늘 칩 흐름" ? "오늘 칩 흐름이" : "칩 흐름이"} 그래프로 보여요`}</p>
  );
}
