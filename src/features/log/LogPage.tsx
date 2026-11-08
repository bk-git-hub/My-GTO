import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardRow, CardsText } from "../../components/Cards";
import { cardLabel } from "../../poker/cards";
import { useCoach } from "../coach/CoachContext";
import {
  actionLine,
  coachPrompt,
  deleteHand,
  exportData,
  exportLegacyScout,
  fastActText,
  fastOnly,
  fastVerdictOf,
  freshHand,
  freshLevel,
  handFacts,
  handLevelLabel,
  handLogStore,
  handProgress,
  handRoute,
  hasContent,
  hasDetail,
  holeClass,
  holeGuessed,
  holeLabel,
  holeText,
  allPicked,
  isOther,
  knownNames,
  levelLabel,
  livePicks,
  logView,
  memoBlocker,
  mergeImport,
  pickAll,
  PROGRESS_LABEL,
  putAside,
  quickCopy,
  quickSaveAction,
  quickSettled,
  rememberSetup,
  RESULT_LABEL,
  resumeOffer,
  saveHand,
  scoutImported,
  stackBb,
  toggleId,
  tidyHand,
  unfinished,
  villainBook,
  type ListFilter,
  type LoggedHand,
} from "./handLog";
import { FastView } from "./FastView";
import { VERDICT_MARK } from "./fastVerdict";
import { levelDeclined } from "./inputs";
import { STAGE_LABEL } from "./quickPre";
import { TableFlow } from "./TableFlow";
import { deleteWithUndo, dismissUndo, undoLast, useUndoNote } from "./undoDelete";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
const NAMES_LIST_ID = "log-villain-names";

type Msg = { text: string; error?: boolean } | null;

/**
 * Routes: "log" (a new hand of mine: the hand first, then the table), "log/fast" (빠른 기록: every hand
 * of mine, a few taps each, graded against the chart), "log/other" (남의 핸드: the same screen for hands
 * other players showed), "log/list" (past hands: all, "log/list/mine", "log/list/other", 편집 to delete
 * some, and the backup), "log/players" (showdowns by opponent), "log/<id>" (a saved hand in the table
 * flow, mine or another player's).
 */
export function LogPage({ sub, go }: { sub: string; go: (route: string) => void }) {
  const { hands } = handLogStore.use();
  const v = logView(sub, hands);
  return (
    <div className="page log-page">
      <datalist id={NAMES_LIST_ID}>
        {knownNames(hands).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {v.kind === "new" && <NewHandView hands={hands} go={go} />}
      {v.kind === "fast" && <FastView key="mine" hands={hands} go={go} />}
      {/* Keyed by the hand: saving changes the address bar only, so the screen keeps its hand. */}
      {v.kind === "edit" && <EditView key={v.id} id={v.id} hands={hands} go={go} />}
      {v.kind === "other" && <FastView key="other" mode="other" hands={hands} go={go} />}
      {v.kind === "list" && <ListScreen tab={v.filter} hands={hands} go={go} />}
      {v.kind === "players" && <ListScreen tab="players" hands={hands} go={go} />}
      <Toast />
      <UndoToast />
    </div>
  );
}

// ───────────── saving as it is typed ─────────────

/**
 * The hand on screen, saved as it is typed: once it holds two clean cards or a note it is stored, and
 * every edit after that goes to the same hand; a typo or a half-typed card never overwrites the cards
 * on file; a hand emptied out is removed (see quickSaveAction). `onCommitted` hears each edit and
 * whether the hand is on file after it.
 */
function useHandDraft(start: LoggedHand, onCommitted?: (h: LoggedHand, kept: boolean) => void) {
  const [draft, setDraft] = useState<LoggedHand>(start);
  /** The hand on screen, for the card field's late clean/unclean report. */
  const latest = useRef(draft);
  /** When the hand on screen was first saved: kept if it is deleted and saved again (its cards typed anew). */
  const born = useRef<{ id: string; at: number } | null>(handLogStore.get().hands.some((x) => x.id === start.id) ? { id: start.id, at: start.createdAt } : null);
  // The card field reports a typo or half-typed card here: its cards aren't saved while it shows one.
  const [cardsClean, setCardsClean] = useState(true);
  const cleanRef = useRef(true);
  /** The last save failed (storage full): shown until a save goes through. */
  const [full, setFull] = useState(false);
  const stored = handLogStore.use().hands.find((x) => x.id === draft.id) ?? null;

  function commit(next: LoggedHand, clean: boolean) {
    let shown = tidyHand(next);
    const onFile = handLogStore.get().hands.find((x) => x.id === shown.id) ?? null;
    const act = quickSaveAction(onFile, shown, clean);
    let kept = onFile !== null;
    if (act === "save") {
      // Dated from the first save, not from when the screen was opened; an estimated level (or none)
      // follows that moment too, so a screen left open for an hour doesn't save the level it opened at.
      if (!onFile) {
        const at = born.current?.id === shown.id ? born.current.at : Date.now();
        shown = freshLevel({ ...shown, createdAt: at }, at, levelDeclined.has(shown.id));
      }
      const ok = saveHand(tidyHand(quickCopy(onFile, shown, clean)));
      setFull(!ok);
      if (ok) {
        kept = true;
        born.current = { id: shown.id, at: shown.createdAt };
      }
    } else if (act === "delete") {
      deleteHand(shown.id);
      kept = false;
    }
    onCommitted?.(shown, kept);
    latest.current = shown;
    setDraft(shown);
  }
  const setClean = (ok: boolean) => {
    cleanRef.current = ok;
    setCardsClean(ok);
  };

  return {
    draft,
    stored,
    cardsClean,
    full,
    /** Leaving now loses nothing: the hand on file is the one on screen. */
    settled: quickSettled(stored, draft, cardsClean),
    change(next: LoggedHand, clean?: boolean) {
      if (clean !== undefined) setClean(clean);
      commit(next, clean ?? cleanRef.current);
    },
    onCardsClean(ok: boolean) {
      setClean(ok);
      commit(latest.current, ok);
    },
    /** The card field is left mid-way (another step, another screen part): the cards on file come back on screen. */
    settle() {
      if (cleanRef.current) return;
      const onFile = handLogStore.get().hands.find((x) => x.id === latest.current.id) ?? null;
      setClean(true);
      commit(quickCopy(onFile, latest.current, false), true);
    },
    /** Put another hand on screen (a new one). */
    replace(h: LoggedHand) {
      latest.current = h;
      born.current = null;
      setClean(true);
      setFull(false);
      setDraft(h);
    },
  };
}

/** "작성 중" flash for the past hands, set just before going there. */
let flashed: { text: string; at: number } | null = null;
function flash(text: string) {
  flashed = { text, at: Date.now() };
}

/** A short message at the bottom (the hand just left for later), gone after a moment. */
function Toast() {
  const [msg] = useState(() => (flashed && Date.now() - flashed.at < 2000 ? flashed.text : null));
  const [on, setOn] = useState(msg !== null);
  useEffect(() => {
    if (!msg) return;
    flashed = null;
    const t = setTimeout(() => setOn(false), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  return on && msg ? (
    <div className="log-toast" role="status">
      {msg}
    </div>
  ) : null;
}

/** "N개 삭제했어요 · 되돌리기" at the bottom for a few seconds after a delete (see undoDelete.ts). */
function UndoToast() {
  const n = useUndoNote();
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => dismissUndo(n.key), Math.max(0, n.until - Date.now()));
    return () => clearTimeout(t);
  }, [n]);
  if (!n) return null;
  return (
    <div className={`undo-toast${n.error ? " error" : ""}`} role="status" aria-live="polite">
      <span>{n.text}</span>
      {n.deletion && (
        <button type="button" onClick={() => undoLast()}>
          되돌리기
        </button>
      )}
    </div>
  );
}

/** Asks once before something that can't be taken back by a tap later (a bottom sheet, not the browser's dialog). */
function ConfirmSheet({ title, sub, yes, onYes, onNo }: { title: string; sub?: string; yes: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="confirm-backdrop" onClick={onNo}>
      <div className="confirm-sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <b>{title}</b>
        {sub && <p>{sub}</p>}
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onNo}>
            취소
          </button>
          <button type="button" className="confirm-yes" onClick={onYes}>
            {yes}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The cards on file, as a short label: colored "A♦T♦", or "ATs (무늬 추정)". */
function HandLabel({ h }: { h: LoggedHand }) {
  return holeGuessed(h) ? <b>{holeLabel(h)}</b> : <CardsText cards={h.hole} />;
}

/**
 * The hand step's line about saving, two lines of fixed height so saving never moves the keypad:
 * what saves it, that it is saved (and can be finished later), or that the card field is mid-edit.
 */
function SaveLine({ stored, draft, cardsClean, saved }: { stored: LoggedHand | null; draft: LoggedHand; cardsClean: boolean; saved: ReactNode }) {
  if (!stored) {
    return (
      <p className="save-line idle" aria-live="polite">
        <span>{memoBlocker(draft, cardsClean) ?? ""}</span>
      </p>
    );
  }
  if (cardsClean && draft.hole.length !== 1) {
    return (
      <p className="save-line ok" aria-live="polite">
        <b>✓ 저장됐어요</b>
        <span>{saved}</span>
      </p>
    );
  }
  // The card field is mid-edit: the rest is on file, with the last good cards.
  return (
    <p className="save-line wait" aria-live="polite">
      <b>✓ 저장됨</b>
      <span>
        {draft.hole.length === 2 ? (
          "카드 칸에 글자가 더 있어요"
        ) : stored.hole.length ? (
          <>
            카드는 <HandLabel h={stored} /> 그대로예요
          </>
        ) : (
          "카드는 두 장 넣으면 저장돼요"
        )}
      </span>
    </p>
  );
}

// ───────────── a hand in the table flow ─────────────

/** A new hand nobody has typed anything worth saving into yet: kept here, so a trip to the list doesn't lose it. */
let untouched: LoggedHand | null = null;

/** The first screen: a new hand of mine, the hand first. */
function NewHandView({ hands, go }: { hands: LoggedHand[]; go: (route: string) => void }) {
  // A blank hand kept from earlier takes the level estimate for now, like a new one.
  const [start] = useState(() => (untouched && !hands.some((x) => x.id === untouched!.id) ? freshLevel(untouched, Date.now(), levelDeclined.has(untouched.id)) : freshHand()));
  return <HandScreen start={start} isNew hands={hands} go={go} />;
}

function EditView({ id, hands, go }: { id: string; hands: LoggedHand[]; go: (route: string) => void }) {
  // Taken once: the hand may leave the store while it is on screen (its cards cleared to be typed again).
  const [start, setStart] = useState(() => hands.find((h) => h.id === id) ?? null);
  // Not on file when the screen opened (deleted), but back now (되돌리기): show it from here on.
  const back = start ? null : (hands.find((h) => h.id === id) ?? null);
  if (back) setStart(back);
  if (!start) {
    return (
      <>
        <div className="log-top">
          <button type="button" className="log-link back" onClick={() => go("log/list")}>
            ‹ 지난 기록
          </button>
        </div>
        <section className="card-box">
          <p>이 기록을 찾을 수 없어요. 지웠거나 다른 기기에서 만든 기록이에요.</p>
          <button className="ghost" onClick={() => go("log/list")}>
            목록으로
          </button>
        </section>
      </>
    );
  }
  return <HandScreen start={start} isNew={false} hands={hands} go={go} />;
}

/**
 * One hand in the table flow (핸드 → 테이블 → 프리플랍 … → 결과), saved as it is typed. `isNew`: the
 * first screen (#log), with the hand to pick up again and the past-hands link on its first line.
 */
function HandScreen({ start, isNew, hands, go }: { start: LoggedHand; isNew: boolean; hands: LoggedHand[]; go: (route: string) => void }) {
  const d = useHandDraft(start, (h, kept) => {
    if (!isNew) return;
    untouched = kept ? null : h;
    if (!kept) rememberSetup(h);
  });
  const { draft: h, stored } = d;
  const saved = stored !== null;
  const other = isOther(h);
  const listRoute = other ? "log/list/other" : "log/list/mine";
  const resume = useMemo(() => (isNew && !hasContent(h) ? resumeOffer(hands, Date.now()) : null), [isNew, hands, h]);
  const coach = useCoach();

  function fresh() {
    // Left on purpose: not offered for resuming.
    if (stored) putAside(stored.id);
    untouched = null;
    d.replace(freshHand());
  }
  function later() {
    if (!stored) return;
    putAside(stored.id);
    if (isNew) untouched = null;
    flash(unfinished(stored) ? "저장했어요 · 작성 중" : "저장했어요");
    go(listRoute);
  }
  /** On to the next hand (this one is complete and on file). */
  function nextHand() {
    if (isNew) {
      fresh();
      return;
    }
    putAside(h.id);
    go(other ? "log/other" : "log");
  }
  function review(next: LoggedHand, extra: string) {
    d.change(next);
    const prompt = coachPrompt(next);
    coach.open({
      id: `log:${next.id}:${next.updatedAt}:${next.steps.length}:${next.showdowns.map((x) => x.cards.join("-")).join("|")}`,
      title: prompt.title,
      facts: handFacts(next) + extra,
      defaultQuestion: prompt.question,
    });
  }

  const n = hands.length;
  const listLink = (
    <button type="button" className="log-link" onClick={() => go("log/list")} aria-label={n ? `지난 기록 ${n}개` : "지난 기록"}>
      {/* Narrow screens drop the words in .ll-word: "지난 3 ›". */}
      지난<span className="ll-word"> 기록</span>
      {n ? (
        <span className="log-link-n">
          {" "}
          {n}
          <span className="ll-word">개</span>
        </span>
      ) : null}{" "}
      ›
    </button>
  );
  // The first line of the hand step: one line in every state, so saving never moves the keypad.
  const aside = isNew ? (
    <span className={`flow-aside${resume ? " with-resume" : ""}`}>
      {saved ? (
        <button type="button" className="log-new-pill" onClick={fresh}>
          ＋ 새 핸드
        </button>
      ) : resume ? (
        <ResumePill h={resume} onClick={() => go(handRoute(resume))} />
      ) : null}
      {listLink}
    </span>
  ) : undefined;

  // On #log past the hand step (whose first line has these): the way to the past hands, and once the
  // hand is on file the way to the next one.
  const newTop = isNew ? (
    <div className="log-top">
      <button type="button" className="log-link back" onClick={() => go(listRoute)}>
        ‹ 지난 기록
      </button>
      {saved && (
        <button type="button" className="log-new-btn" onClick={fresh}>
          ＋ 새 핸드
        </button>
      )}
    </div>
  ) : undefined;

  return (
    <>
      {!isNew && (
        <div className="log-top">
          <button type="button" className="log-link back" onClick={() => go(listRoute)}>
            ‹ 지난 기록
          </button>
          <button
            type="button"
            className="log-new-btn"
            onClick={() => {
              // Leaving this hand for a new one on purpose: don't offer it back on the next screen.
              putAside(h.id);
              go(other ? "log/other" : "log");
            }}
          >
            {other ? "＋ 남의 핸드" : "＋ 새 핸드"}
          </button>
        </div>
      )}
      {d.full && (
        <div className="notice error" role="alert">
          {FULL_MSG}
        </div>
      )}
      <TableFlow
        key={h.id}
        h={h}
        onChange={d.change}
        onCardsClean={d.onCardsClean}
        onLeaveHand={d.settle}
        onReview={review}
        startAt={isNew ? "hand" : undefined}
        aside={aside}
        status={<SaveLine stored={stored} draft={h} cardsClean={d.cardsClean} saved="지금 다 안 써도 지난 기록에서 이어서 작성할 수 있어요" />}
        onLater={later}
        laterReady={saved && d.settled}
        onNextHand={nextHand}
        top={newTop}
        // Seat, stack and level typed here aren't kept until the hand is first saved: say so.
        unsaved={saved ? null : <p className="save-line idle setup-unsaved">아직 저장 전 · {memoBlocker(h, d.cardsClean) ?? "카드 두 장이나 메모를 넣으면 저장돼요"}</p>}
      />
      <HandFoot
        h={h}
        saved={saved}
        onNote={(note) => d.change({ ...h, note })}
        onDelete={() => {
          // Gone at once, with 되돌리기 at the bottom of the next screen for a few seconds.
          deleteWithUndo([h.id]);
          if (isNew) fresh();
          else go(listRoute);
        }}
      />
    </>
  );
}

/** Under the flow: the note, and once saved its date and the delete button. */
function HandFoot({ h, saved, onNote, onDelete }: { h: LoggedHand; saved: boolean; onNote: (note: string) => void; onDelete: () => void }) {
  const [memo, setMemo] = useState(false);
  return (
    <>
      <div className="row-gap log-foot">
        <button className="ghost small" onClick={() => setMemo(!memo)}>
          메모 {h.note.trim() ? "✓" : ""}
        </button>
        {saved && <span className="muted small">{`${dayLabel(h.createdAt)} ${timeLabel(h.createdAt)} · 자동 저장`}</span>}
        {saved && (
          <button
            className="ghost small danger"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              if (confirm("이 핸드 기록을 지울까요?")) onDelete();
            }}
          >
            삭제
          </button>
        )}
      </div>
      {memo && <textarea rows={3} value={h.note} onChange={(e) => onNote(e.target.value)} placeholder="예) BTN 아재가 리버에서 오래 고민하다 콜" />}
    </>
  );
}

/** "↺ 이어서 BTN A♦T♦": a hand of mine left mid-way, to pick up again. */
function ResumePill({ h, onClick }: { h: LoggedHand; onClick: () => void }) {
  const cards = holeGuessed(h) ? holeClass(h) : h.hole.map(cardLabel).join("");
  return (
    <button
      type="button"
      className={`log-resume${h.hole.length ? " has-cards" : ""}`}
      onClick={onClick}
      aria-label={["이어서 기록:", h.seat || (h.hole.length ? "" : "자리 전"), cards, "·", PROGRESS_LABEL[handProgress(h)]].filter(Boolean).join(" ")}
    >
      {/* Narrow screens keep the arrow and the cards: "↺ A♦T♦". */}
      <b>
        ↺<span className="rs-word"> 이어서</span>
      </b>
      <span>
        {h.hole.length ? (
          <>
            {/* Long seat names (UTG+1) go first on small phones, then any seat shrinks before the cards. */}
            {h.seat && <span className={`rs-seat${h.seat.length > 3 ? " long" : ""}`}>{h.seat} </span>}
            {holeGuessed(h) ? <span className="hole-text">{holeClass(h)}</span> : <CardsText cards={h.hole} />}
          </>
        ) : (
          h.seat || "메모"
        )}
      </span>
    </button>
  );
}

// ───────────── past hands ─────────────

type ListTab = ListFilter | "players";

const TAB_ROUTE: Record<ListTab, string> = { all: "log/list", mine: "log/list/mine", other: "log/list/other", players: "log/players" };

function ListScreen({ tab, hands, go }: { tab: ListTab; hands: LoggedHand[]; go: (route: string) => void }) {
  const mine = useMemo(() => hands.filter((h) => !isOther(h)), [hands]);
  const others = useMemo(() => hands.filter(isOther), [hands]);
  const tabs: [ListTab, string, number | null][] = [
    ["all", "전체", hands.length],
    ["mine", "내 핸드", mine.length],
    ["other", "남의 핸드", others.length],
    ["players", "쇼다운", null],
  ];
  return (
    <>
      <div className="seg small log-tabs" role="tablist" aria-label="지난 기록">
        {tabs.map(([t, label, count]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => go(TAB_ROUTE[t])} aria-label={t === "players" ? "상대별 쇼다운" : undefined}>
            {label}
            {count ? <b>{count}</b> : null}
          </button>
        ))}
      </div>
      {tab === "players" ? (
        <PlayersView hands={hands} go={go} />
      ) : (
        <>
          <ListView key={tab} tab={tab} hands={tab === "all" ? hands : tab === "mine" ? mine : others} go={go} />
          <BackupBox hands={hands} />
        </>
      )}
    </>
  );
}

const EMPTY_TEXT: Record<ListFilter, string> = {
  all: "아직 기록이 없어요. ＋ 새 기록으로 기억나는 핸드부터 넣어 보세요.",
  mine: "아직 내 핸드 기록이 없어요. ＋ 새 기록으로 기억나는 핸드부터 넣어 보세요.",
  other: "아직 남의 핸드가 없어요. ＋ 남의 핸드로 누가 뭘로 오픈·콜했는지 모아 보세요.",
};

/**
 * The past hands of a tab, newest first by day. 편집 turns the rows into picks (a check at the left), with
 * a bar at the bottom: 전체 선택 (the rows shown), how many are picked and 선택 삭제, which asks once and
 * then deletes with 되돌리기 offered for a few seconds. 완료 (or a new tab) drops the picks.
 * `startPicking` / `startPicks` open it already in 편집 (for tests).
 */
export function ListView({ tab, hands, go, startPicking = false, startPicks = [] }: { tab: ListFilter; hands: LoggedHand[]; go: (route: string) => void; startPicking?: boolean; startPicks?: string[] }) {
  const [limit, setLimit] = useState(50);
  const [picking, setPicking] = useState(startPicking);
  const [sel, setSel] = useState<string[]>(startPicks);
  const [asking, setAsking] = useState(false);
  const shown = useMemo(() => hands.slice(0, limit), [hands, limit]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  // A hand deleted meanwhile (elsewhere) is no longer picked.
  const picks = picking ? livePicks(sel, hands) : [];
  const shownIds = shown.map((h) => h.id);
  const all = allPicked(picks, shownIds);

  function stop() {
    setPicking(false);
    setSel([]);
    setAsking(false);
  }
  function remove() {
    deleteWithUndo(picks);
    stop();
  }

  return (
    <>
      {picking ? (
        <div className="log-new-row log-picking-head">
          <span className="log-pick-title">지울 기록을 골라 주세요</span>
          <button type="button" className="log-edit-btn on" onClick={stop}>
            완료
          </button>
        </div>
      ) : (
        <div className="log-new-row">
          {tab !== "other" && (
            <button type="button" className="log-new-btn" onClick={() => go("log")}>
              ＋ 새 기록
            </button>
          )}
          {tab !== "other" && (
            <button type="button" className="log-new-btn" onClick={() => go("log/fast")}>
              ⚡ 빠른 기록
            </button>
          )}
          {tab !== "mine" && (
            <button type="button" className="log-new-btn other" onClick={() => go("log/other")}>
              ＋ 남의 핸드
            </button>
          )}
          {hands.length > 0 && (
            <button type="button" className="log-edit-btn" onClick={() => setPicking(true)}>
              편집
            </button>
          )}
        </div>
      )}
      {hands.length === 0 ? (
        <p className="muted small">{EMPTY_TEXT[tab]}</p>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="log-list">
            <div className="log-day">
              {g.day} · {g.hands.length}핸드
            </div>
            {g.hands.map((h) =>
              picking ? (
                <HandRow key={h.id} h={h} picked={picks.includes(h.id)} onClick={() => setSel(toggleId(picks, h.id))} />
              ) : (
                <HandRow key={h.id} h={h} onClick={() => go(handRoute(h))} />
              ),
            )}
          </div>
        ))
      )}
      {hands.length > limit && (
        <button className="ghost" onClick={() => setLimit(limit + 100)}>
          더 보기 ({hands.length - limit}개 남음)
        </button>
      )}
      {picking && (
        <div className="log-pick-bar" role="toolbar" aria-label="선택한 기록">
          <button type="button" className="ghost" onClick={() => setSel(pickAll(picks, shownIds))}>
            {all ? "전체 해제" : "전체 선택"}
          </button>
          <span className="log-pick-n" aria-live="polite">
            {picks.length}개 선택
          </span>
          <button type="button" className="log-pick-del" disabled={!picks.length} onClick={() => setAsking(true)}>
            선택 삭제
          </button>
        </div>
      )}
      {asking && picks.length > 0 && (
        <ConfirmSheet
          title={`기록 ${picks.length}개를 지울까요?`}
          sub="지운 뒤 몇 초 동안은 아래 되돌리기로 그대로 살릴 수 있어요."
          yes={`${picks.length}개 삭제`}
          onYes={remove}
          onNo={() => setAsking(false)}
        />
      )}
    </>
  );
}

/**
 * One past hand: whose it is (another player's carry a "남" badge), the subject's seat and cards (a
 * class like "ATs" when the suits were guessed), the preflop line, and for a hand recorded part of the
 * way "작성 중" with 이어서 작성.
 */
function HandRow({ h, onClick, picked }: { h: LoggedHand; onClick: () => void; picked?: boolean }) {
  const other = isOther(h);
  const bb = stackBb(h);
  // A 빠른 기록 hand: its decision and the chart's verdict, until it is carried on to the table.
  const fast = fastOnly(h);
  const fv = h.fast ? fastVerdictOf(h) : null;
  // A walk's line already says 워크.
  const verdict = fv && fv.text !== "워크" ? fv : null;
  const line = fast ? [h.quickPre?.stage ? STAGE_LABEL[h.quickPre.stage] : "", fastActText(h)].filter(Boolean).join(" · ") : actionLine(h);
  const open = unfinished(h);
  const guessed = holeGuessed(h);
  return (
    <button
      className={`log-row${other ? " other" : ""}${open ? " open" : ""}${picked !== undefined ? ` picking${picked ? " picked" : ""}` : ""}`}
      onClick={onClick}
      {...(picked !== undefined ? { role: "checkbox", "aria-checked": picked } : {})}
    >
      {picked !== undefined && (
        <span className="log-check" aria-hidden="true">
          {picked ? "✓" : ""}
        </span>
      )}
      <span className="log-row-main">
        {other && (
          <span className="log-kind" aria-label="남의 핸드">
            남
          </span>
        )}
        <b className="log-seat">{h.seat || "-"}</b>
        {h.hole.length === 2 ? guessed ? <b className="log-class">{holeClass(h)}</b> : <CardRow cards={h.hole} size="sm" /> : <span className="muted small">카드 없음</span>}
        {bb !== null && <span className="small">{bb}bb</span>}
        <span className="log-end">
          {h.fast && <span className="log-tag fast">빠른</span>}
          {guessed && !h.fast && <span className="log-tag soft">무늬 추정</span>}
          {open && <span className="log-tag">작성 중</span>}
          {h.result && <span className={`log-result ${h.result}`}>{RESULT_LABEL[h.result]}</span>}
        </span>
      </span>
      {line && <span className="log-pre small">{line}</span>}
      {verdict && (
        <span className={`log-verdict small v-${verdict.kind}`}>
          {verdict.kind === "none" ? `${VERDICT_MARK.none} ${verdict.text}` : verdict.text}
        </span>
      )}
      <span className="muted small">
        {timeLabel(h.createdAt)} · {handLevelLabel(h)}
        {hasDetail(h) ? " · 자세히" : ""}
        {h.showdowns.length ? ` · 쇼다운 ${h.showdowns.length}` : ""}
        {other && h.mySeat ? ` · 내 자리 ${h.mySeat}` : ""}
      </span>
      {h.note.trim() && <span className="log-note small">{h.note.trim()}</span>}
      {open && <span className="log-continue">이어서 작성 ›</span>}
    </button>
  );
}

// ───────────── opponents ─────────────

function PlayersView({ hands, go }: { hands: LoggedHand[]; go: (route: string) => void }) {
  const book = useMemo(() => villainBook(hands), [hands]);
  const coach = useCoach();
  if (!book.length) {
    return (
      <p className="muted small">
        아직 쇼다운 기록이 없어요. 핸드를 기록하고 결과 화면에서 상대 핸드와 별명을 넣으면 여기 상대별로 모여요. 레인지를 조정할 때 근거가 돼요.
      </p>
    );
  }

  function analyse(name: string, entries: ReturnType<typeof villainBook>[number]["entries"]) {
    const lines = entries.map(({ hand, showdown }) => {
      const bb = stackBb(hand);
      return `- ${dayLabel(hand.createdAt)} ${levelLabel(hand.level)} · 상대 ${showdown.seat || "자리 모름"} ${showdown.cards.length ? holeText(showdown.cards) : "카드 모름"}${showdown.did.trim() ? ` — ${showdown.did.trim()}` : ""} (${isOther(hand) ? `남의 핸드 기록${hand.mySeat ? `, 내 자리 ${hand.mySeat}` : ""}` : `내 자리 ${hand.seat || "모름"}${bb !== null ? `, 내 스택 ${bb}bb` : ""}`})`;
    });
    coach.open({
      id: `villain:${name}:${entries.length}:${entries[0].hand.updatedAt}`,
      title: `상대 분석 · ${name}`,
      facts: ["게임: 홀덤펍 토너먼트 · 9인 · BB 앤티. 사용자가 실제로 본 상대의 쇼다운 기록.", `상대: ${name} · 쇼다운 ${entries.length}번`, ...lines].join("\n"),
      defaultQuestion: "이 상대가 보여준 핸드로 성향을 정리해줘. 그리고 이 상대에게 내 오픈·올인·콜 레인지를 어떻게 조정하면 좋을지 알려줘. 표본이 적으면 그 점도 감안해서 말해줘.",
    });
  }

  return (
    <>
      <div className="log-day">상대별 쇼다운 · 별명으로 모아 보기</div>
      {book.map(({ name, entries }) => (
        <section key={name} className="card-box">
          <div className="row-between">
            <h2>{name}</h2>
            <span className="row-gap">
              <span className="muted small">쇼다운 {entries.length}번</span>
              <button className="ghost small" onClick={() => analyse(name, entries)}>
                AI 분석
              </button>
            </span>
          </div>
          {entries.map(({ hand, showdown }, i) => (
            <button key={`${hand.id}:${i}`} className="log-row" onClick={() => go(handRoute(hand))}>
              <span className="log-row-main">
                <b className="log-seat">{showdown.seat || "-"}</b>
                {/* A class seen ("K9s 보여줌") is in the words: "카드 모름" only when nothing was seen. */}
                {showdown.cards.length ? <CardRow cards={showdown.cards} size="sm" /> : showdown.did.trim() ? null : <span className="muted small">카드 모름</span>}
                <span className="small">{showdown.did.trim() || ""}</span>
              </span>
              <span className="muted small">
                {dayLabel(hand.createdAt)} · {levelLabel(hand.level)}
              </span>
            </button>
          ))}
        </section>
      ))}
    </>
  );
}

// ───────────── backup ─────────────

/** Hands a file to the share sheet (plain text is accepted more widely), or downloads it. */
async function saveFile(text: string, name: string, title: string) {
  const file = new File([text], `${name}.txt`, { type: "text/plain" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BackupBox({ hands }: { hands: LoggedHand[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<Msg>(null);
  /** The old 정보 수집 data, still stored as it was (it was copied into 남의 핸드). */
  const [legacy] = useState(() => exportLegacyScout());
  const day = () => new Date().toISOString().slice(0, 10);

  async function importFile(f: File) {
    try {
      const prev = handLogStore.get();
      const { hands: merged, added, updated, startClock, startClocks } = mergeImport(await f.text(), prev.hands, prev.startClock, prev.startClocks);
      if (handLogStore.set({ ...prev, hands: merged, ...(startClock ? { startClock } : {}), ...(startClocks.length ? { startClocks } : {}) })) setMsg({ text: `불러왔어요. 새 기록 ${added}개, 업데이트 ${updated}개.` });
      else {
        handLogStore.set(prev);
        setMsg({ text: FULL_MSG, error: true });
      }
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }

  return (
    <section className="card-box">
      <h2>백업</h2>
      <p className="muted small">
        기록은 이 기기의 브라우저에만 저장돼요 (서버 없음, 무료). 브라우저 데이터를 지우거나 폰을 바꾸면 사라지니, 가끔 내보내서 카톡 '나에게
        보내기'나 드라이브에 보관하세요. 불러오면 지금 기록과 합쳐져요.
      </p>
      <div className="row-gap wrap">
        <button
          className="ghost"
          disabled={!hands.length}
          onClick={() => void saveFile(exportData(hands, handLogStore.get().startClock, handLogStore.get().startClocks), `pubaj-hands-${day()}`, "PubAJ 핸드 기록 백업")}
        >
          내보내기 ({hands.length}개)
        </button>
        <button className="ghost" onClick={() => fileRef.current?.click()}>
          불러오기
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,application/json,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {legacy && (
        <div className="log-legacy">
          <button className="ghost" onClick={() => void saveFile(legacy, `pubaj-scout-${day()}`, "PubAJ 이전 정보 수집 데이터")}>
            이전 정보 수집 데이터 내보내기
          </button>
          <span className="muted small">예전 정보 수집 기록은 남의 핸드로 옮겼어요{scoutImported() ? ` (${scoutImported()}개)` : ""}. 원본도 파일로 받아 둘 수 있고, 불러오기로 다시 넣을 수 있어요.</span>
        </div>
      )}
      {msg && <div className={`notice ${msg.error ? "error" : ""}`}>{msg.text}</div>}
    </section>
  );
}

// ───────────── dates ─────────────

const dayLabel = (t: number) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
const timeLabel = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

function groupByDay(hands: LoggedHand[]): { day: string; hands: LoggedHand[] }[] {
  const out: { day: string; hands: LoggedHand[] }[] = [];
  for (const h of hands) {
    const day = dayLabel(h.createdAt);
    const last = out[out.length - 1];
    if (last && last.day === day) last.hands.push(h);
    else out.push({ day, hands: [h] });
  }
  return out;
}
