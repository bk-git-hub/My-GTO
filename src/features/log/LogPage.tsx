import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardRow } from "../../components/Cards";
import { cardLabel, handClassOf, RANKS, SUIT_SYMBOL, SUITS, type Card } from "../../poker/cards";
import { useCoach } from "../coach/CoachContext";
import {
  deleteHand,
  emptyHand,
  exportData,
  handFacts,
  handLogStore,
  handProgress,
  handRoute,
  hasContent,
  hasDetail,
  holeText,
  isQuickHand,
  knownNames,
  levelLabel,
  logView,
  memoBlocker,
  mergeImport,
  PROGRESS_LABEL,
  putAside,
  quickCopy,
  quickSaveAction,
  quickSettled,
  rememberSetup,
  RESULT_LABEL,
  resumeOffer,
  saveHand,
  stackBb,
  villainBook,
  worthKeeping,
  type LoggedHand,
  type Result,
} from "./handLog";
import type { FlowStep } from "./flowSteps";
import { BlindRow, CardText, ChipRow, ChipsInput } from "./inputs";
import { positionsFor, TABLE_SIZES } from "./recorder";
import { TableFlow } from "./TableFlow";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
const NAMES_LIST_ID = "log-villain-names";

type Msg = { text: string; error?: boolean } | null;

/**
 * Routes: "log" (a new hand, straight onto the table), "log/quick" (quick record: the hand first, saved
 * as it is typed), "log/quick/<id>" (a quick hand to finish), "log/list" (past hands, backup),
 * "log/players" (showdowns by opponent), "log/<id>" (one saved hand on the table).
 */
export function LogPage({ sub, go }: { sub: string; go: (route: string) => void }) {
  const { hands } = handLogStore.use();
  const v = logView(sub, hands);
  const view = v.kind;
  return (
    <div className="page log-page">
      <datalist id={NAMES_LIST_ID}>
        {knownNames(hands).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {v.kind === "new" && <NewHandView hands={hands} go={go} />}
      {/* Keyed by the route: saving changes the address bar only, so the screen keeps its hand. */}
      {v.kind === "quick" && <QuickView key={sub} id={v.id} hands={hands} go={go} />}
      {v.kind === "edit" && <EditView key={sub} id={v.id} hands={hands} go={go} />}
      {(view === "list" || view === "players") && (
        <>
          <div className="log-top">
            <div className="seg small log-tabs">
              <button className={view === "list" ? "on" : ""} onClick={() => go("log/list")}>
                지난 핸드 {hands.length > 0 && <b>{hands.length}</b>}
              </button>
              <button className={view === "players" ? "on" : ""} onClick={() => go("log/players")}>
                상대별 쇼다운
              </button>
            </div>
            <button type="button" className="log-new-btn" onClick={() => go("log")}>
              ＋ 새 핸드
            </button>
          </div>
          {view === "list" ? <ListView hands={hands} go={go} /> : <PlayersView hands={hands} go={go} />}
        </>
      )}
    </div>
  );
}

// ───────────── a new hand ─────────────

/** A new hand nobody has typed anything into yet: kept here, not in the list, so a trip to the list doesn't lose the table setup. */
let untouched: LoggedHand | null = null;

/**
 * The first screen: a new hand's table setup. It is saved only once something worth keeping is in it
 * (cards, actions, a note); until then it never shows up among the saved hands.
 */
function NewHandView({ hands, go }: { hands: LoggedHand[]; go: (route: string) => void }) {
  const [h, setH] = useState<LoggedHand>(() => (untouched && !hands.some((x) => x.id === untouched!.id) ? untouched : emptyHand()));
  const [msg, setMsg] = useState<Msg>(null);
  const saved = hands.some((x) => x.id === h.id);
  const resume = useMemo(() => (hasContent(h) ? null : resumeOffer(hands, Date.now())), [hands, h]);

  function change(next: LoggedHand) {
    if (hasContent(next)) {
      // Dated from the first thing typed, not from when the screen was opened.
      if (!saved) next = { ...next, createdAt: Date.now() };
      untouched = null;
      setH(next);
      setMsg(saveHand(next) ? null : { text: FULL_MSG, error: true });
    } else {
      if (saved) deleteHand(next.id);
      untouched = next;
      setH(next);
      rememberSetup(next);
    }
  }

  function fresh() {
    if (saved) putAside(h.id);
    untouched = null;
    setMsg(null);
    setH(emptyHand());
  }

  const n = hands.length;
  const listLink = (
    <button type="button" className="log-link" onClick={() => go("log/list")} aria-label={n ? `지난 핸드 ${n}개` : "지난 핸드"}>
      {/* Narrow screens drop the words in .ll-word: "지난 3 ›". */}
      지난<span className="ll-word"> 핸드</span>
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
  const resumeQuick = resume !== null && isQuickHand(resume);
  // On the first line of the table setup, so the screen still fits one view on a phone.
  const aside = (
    <span className={`flow-aside${resume ? " with-resume" : ""}`}>
      <button type="button" className="log-quick" onClick={() => go("log/quick")} aria-label="빠른 기록: 핸드만 먼저 찍어 두기">
        {/* The narrowest screens drop "기록" next to the resume pill: "⚡ 빠른". */}
        ⚡ 빠른<span className="lq-word"> 기록</span>
      </button>
      {resume && (
        <button
          type="button"
          className={`log-resume${resume.hole.length ? " has-cards" : ""}`}
          onClick={() => go(handRoute(resume))}
          aria-label={["이어서 기록:", resume.seat || (resumeQuick ? "" : "자리 전"), resume.hole.map(cardLabel).join(""), "·", resumeQuick ? "빠른 기록" : PROGRESS_LABEL[handProgress(resume)]]
            .filter(Boolean)
            .join(" ")}
        >
          {/* Narrow screens keep the arrow and the cards: "↺ A♦T♦". */}
          <b>
            ↺<span className="rs-word"> 이어서</span>
          </b>
          <span>
            {resume.hole.length ? (
              <>
                {/* Long seat names (UTG+1) go first on small phones, then any seat shrinks before the cards. */}
                {resume.seat && <span className={`rs-seat${resume.seat.length > 3 ? " long" : ""}`}>{resume.seat} </span>}
                <HoleText cards={resume.hole} />
              </>
            ) : (
              resume.seat || (resumeQuick ? "메모" : "자리 전")
            )}
          </span>
        </button>
      )}
      {listLink}
    </span>
  );

  return (
    <>
      {/* Nothing above the table on a fresh screen. */}
      {saved && (
        <div className="log-top">
          <button type="button" className="log-new-btn" onClick={fresh}>
            ＋ 새 핸드
          </button>
          {listLink}
        </div>
      )}
      <HandBody
        key={h.id}
        h={h}
        change={change}
        msg={msg}
        saved={saved}
        startAt="setup"
        aside={saved ? undefined : aside}
        onDelete={() => {
          deleteHand(h.id);
          fresh();
        }}
      />
    </>
  );
}

// ───────────── one saved hand ─────────────

function EditView({ id, hands, go }: { id: string; hands: LoggedHand[]; go: (route: string) => void }) {
  const stored = hands.find((h) => h.id === id);
  const [draft, setDraft] = useState<LoggedHand | undefined>(stored);
  const [msg, setMsg] = useState<Msg>(null);

  // A hand emptied out (nothing left in it) shouldn't clutter the list.
  useEffect(
    () => () => {
      const h = handLogStore.get().hands.find((x) => x.id === id);
      if (h && !worthKeeping(h)) deleteHand(id);
    },
    [id],
  );

  const top = (
    <div className="log-top">
      <button type="button" className="log-link back" onClick={() => go("log/list")}>
        ‹ 지난 핸드
      </button>
      <button
        type="button"
        className="log-new-btn"
        onClick={() => {
          // Leaving this hand for a new one on purpose: don't offer it back on the next screen.
          putAside(id);
          go("log");
        }}
      >
        ＋ 새 핸드
      </button>
    </div>
  );

  if (!draft) {
    return (
      <>
        {top}
        <section className="card-box">
          <p>이 기록을 찾을 수 없어요. 지웠거나 다른 기기에서 만든 기록이에요.</p>
          <button className="ghost" onClick={() => go("log/list")}>
            목록으로
          </button>
        </section>
      </>
    );
  }

  /** Every change is saved right away: a hand recorded at the table must not be lost. */
  function change(h: LoggedHand) {
    setDraft(h);
    setMsg(saveHand(h) ? null : { text: FULL_MSG, error: true });
  }

  return (
    <>
      {top}
      <HandBody
        h={draft}
        change={change}
        msg={msg}
        saved
        onDelete={() => {
          deleteHand(draft.id);
          go("log/list");
        }}
      />
    </>
  );
}

/** The recorder for one hand, with its note, date and delete button once it is saved. */
function HandBody(props: { h: LoggedHand; change: (h: LoggedHand) => void; msg: Msg; saved: boolean; startAt?: FlowStep; aside?: ReactNode; onDelete: () => void }) {
  const { h, change, msg, saved, startAt, aside, onDelete } = props;
  const [memo, setMemo] = useState(false);
  const coach = useCoach();

  function review(next: LoggedHand, extra: string) {
    change(next);
    coach.open({
      id: `log:${next.id}:${next.updatedAt}:${next.steps.length}:${next.showdowns.map((x) => x.cards.join("-")).join("|")}`,
      title: `기록 리뷰 · ${next.seat || "자리 모름"} ${next.hole.map(cardLabel).join("")}`,
      facts: handFacts(next) + extra,
      defaultQuestion:
        "내가 펍에서 실제로 친 핸드야. 스트리트별로 내 결정이 괜찮았는지, 결과와 상관없이 결정 자체가 좋았는지, 아쉬운 결정이 있다면 뭐였는지, 이런 펍아재 상대로는 어떻게 조정하면 좋을지 알려줘.",
    });
  }

  return (
    <>
      {msg && <div className={`notice ${msg.error ? "error" : ""}`}>{msg.text}</div>}
      <TableFlow key={h.id} h={h} onChange={change} onReview={review} startAt={startAt} aside={aside} />
      {saved && (
        <>
          <div className="row-gap wrap log-foot">
            <button className="ghost small" onClick={() => setMemo(!memo)}>
              메모 {h.note.trim() ? "✓" : ""}
            </button>
            <span className="muted small">{`${dayLabel(h.createdAt)} ${timeLabel(h.createdAt)} · 자동 저장`}</span>
            <button
              className="ghost small danger"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                if (confirm("이 핸드 기록을 지울까요?")) onDelete();
              }}
            >
              삭제
            </button>
          </div>
          {memo && <textarea rows={3} value={h.note} onChange={(e) => change({ ...h, note: e.target.value })} placeholder="예) BTN 아재가 리버에서 오래 고민하다 콜" />}
        </>
      )}
    </>
  );
}

/** Cards as short colored text ("A♦T♦"). */
function HoleText({ cards }: { cards: Card[] }) {
  return (
    <span className="hole-text">
      {cards.map((c) => (
        <i key={c} className={`s-${SUITS[c & 3]}`}>
          {RANKS[c >> 2]}
          {SUIT_SYMBOL[SUITS[c & 3]]}
          {"\uFE0E"}
        </i>
      ))}
    </span>
  );
}

// ───────────── past hands ─────────────

function ListView({ hands, go }: { hands: LoggedHand[]; go: (route: string) => void }) {
  const [limit, setLimit] = useState(50);
  const groups = useMemo(() => groupByDay(hands.slice(0, limit)), [hands, limit]);

  return (
    <>
      <button type="button" className="card-box log-quick-entry" onClick={() => go("log/quick")}>
        <b>⚡ 빠른 기록</b>
        <span className="muted small">핸드만 먼저 찍고 나중에 이어 쓰기</span>
        <em>›</em>
      </button>
      {hands.length === 0 ? (
        <p className="muted small">아직 기록이 없어요. ＋ 새 핸드로 테이블에서 기록하거나, ⚡ 빠른 기록으로 핸드만 먼저 찍어 두세요.</p>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="log-list">
            <div className="log-day">
              {g.day} · {g.hands.length}핸드
            </div>
            {g.hands.map((h) => (
              <HandRow key={h.id} h={h} onClick={() => go(handRoute(h))} />
            ))}
          </div>
        ))
      )}
      {hands.length > limit && (
        <button className="ghost" onClick={() => setLimit(limit + 100)}>
          더 보기 ({hands.length - limit}개 남음)
        </button>
      )}

      <BackupBox hands={hands} />
    </>
  );
}

// ───────────── quick record ─────────────

const RESULTS = Object.keys(RESULT_LABEL) as Result[];

/** A quick hand with nothing worth saving yet, kept so a trip to the list doesn't lose its setup. */
let quickUntouched: LoggedHand | null = null;

/** A new quick hand. `from`, the hand before it, passes on its level, table size and ante. */
function newQuickHand(from?: LoggedHand): LoggedHand {
  const h = emptyHand(from ? from.level : undefined);
  return { ...h, ...(from ? { players: from.players, bbAnte: from.bbAnte } : {}), quick: true };
}

/** Point the address bar at the hand on screen without navigating, so a reload opens it again. */
function showRoute(route: string) {
  try {
    if (decodeURIComponent(location.hash.slice(1)) !== route) history.replaceState(history.state, "", `#${route}`);
  } catch {
    /* no browser history */
  }
}

/** "오후 5:50" */
const clockLabel = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });

/**
 * Quick record: the hand first (cards on the keypad), then seat, blinds, stack, result and a note.
 * Saved the moment it holds two cards or a note, and every edit after that goes to the same hand (the
 * other fields even while the card field is mid-edit); ＋ 다음 핸드 starts the next one. A quick hand
 * opens here again from the past hands until it is carried on to the table.
 */
function QuickView({ id, hands, go }: { id: string | null; hands: LoggedHand[]; go: (route: string) => void }) {
  const [draft, setDraft] = useState<LoggedHand>(() => {
    const stored = id ? hands.find((x) => x.id === id) : undefined;
    if (stored) return stored;
    if (quickUntouched && !hands.some((x) => x.id === quickUntouched!.id)) return quickUntouched;
    return newQuickHand();
  });
  /** The hand on screen, for the card field's late clean/unclean report. */
  const latest = useRef(draft);
  /** When the hand on screen was first saved: kept if it is deleted and saved again (its cards typed anew). */
  const born = useRef<{ id: string; at: number } | null>(hands.some((x) => x.id === draft.id) ? { id: draft.id, at: draft.createdAt } : null);
  // The card field reports a typo or half-typed card here: its cards aren't saved while it shows one.
  const [cardsClean, setCardsClean] = useState(true);
  /** The last save failed (storage full): shown until a save goes through. */
  const [full, setFull] = useState(false);
  /** The hand left with ＋ 다음 핸드: named on the status line until the next one has something in it. */
  const [prev, setPrev] = useState<LoggedHand | null>(null);
  const stored = hands.find((x) => x.id === draft.id) ?? null;
  // Leaving now loses nothing: the hand on file is the one on screen.
  const settled = quickSettled(stored, draft, cardsClean);

  /** Every edit: save, delete or leave the copy on file as it is (see quickSaveAction). */
  function commit(shown: LoggedHand, clean: boolean) {
    const onFile = handLogStore.get().hands.find((x) => x.id === shown.id) ?? null;
    const act = quickSaveAction(onFile, shown, clean);
    let kept = onFile !== null;
    if (act === "save") {
      // Dated from the first save, not from when the screen was opened.
      if (!onFile) shown = { ...shown, createdAt: born.current?.id === shown.id ? born.current.at : Date.now() };
      const ok = saveHand(quickCopy(onFile, shown, clean));
      setFull(!ok);
      if (ok) {
        kept = true;
        born.current = { id: shown.id, at: shown.createdAt };
        showRoute(`log/quick/${shown.id}`);
      }
    } else if (act === "delete") {
      deleteHand(shown.id);
      kept = false;
      showRoute("log/quick");
    }
    quickUntouched = kept ? null : shown;
    if (!kept) rememberSetup(shown);
    latest.current = shown;
    setDraft(shown);
  }

  function nextHand() {
    // Left on purpose: the table screen doesn't offer it for resuming.
    if (stored) putAside(stored.id);
    setPrev(stored);
    const fresh = newQuickHand(draft);
    quickUntouched = fresh;
    latest.current = fresh;
    setDraft(fresh);
    setCardsClean(true);
    showRoute("log/quick");
    window.scrollTo({ top: 0 });
  }

  function toTable() {
    if (stored) return go(`log/${stored.id}`);
    // Nothing worth saving yet: the setup moves on to a new hand on the table.
    untouched = { ...draft, quick: undefined };
    quickUntouched = null;
    go("log");
  }

  let tone = "idle";
  let status: ReactNode = memoBlocker(draft, cardsClean);
  if (stored) {
    const saved = <b>✓ 저장됨 · {clockLabel(stored.updatedAt)}</b>;
    if (cardsClean && draft.hole.length !== 1) {
      tone = "ok";
      status = (
        <>
          {saved}
          <span>
            — <span className="qs-word">나중에 </span>지난 핸드에서 이어 쓸 수 있어요
          </span>
        </>
      );
    } else {
      // The card field is mid-edit: the rest is on file, with the last good cards.
      tone = "wait";
      status = (
        <>
          {saved}
          <span>
            —{" "}
            {draft.hole.length === 2 ? (
              "카드 칸에 글자가 더 있어요"
            ) : stored.hole.length ? (
              <>
                카드는 <HoleText cards={stored.hole} /> 그대로예요
              </>
            ) : (
              "카드는 두 장 넣으면 저장돼요"
            )}
          </span>
        </>
      );
    }
  } else if (prev && cardsClean && !hasContent(draft)) {
    tone = "ok";
    status = (
      <>
        <b>✓ 앞 핸드 저장됨</b>
        <span>
          {prev.hole.length ? <HoleText cards={prev.hole} /> : null} — 이제 이번 핸드를 넣으세요
        </span>
      </>
    );
  }

  return (
    <>
      <div className="log-top">
        <h2 className="quick-title">⚡ 빠른 기록</h2>
        <button type="button" className="log-link" onClick={() => go("log/list")}>
          지난 핸드{hands.length ? <span className="log-link-n"> {hands.length}개</span> : null} ›
        </button>
      </div>
      {full ? (
        <div className="notice error" role="alert">
          {FULL_MSG}
        </div>
      ) : (
        <p className={`quick-status ${tone}`} aria-live="polite">
          {status}
        </p>
      )}
      <QuickFields
        key={draft.id}
        h={draft}
        onChange={(next, clean) => {
          if (clean !== undefined) setCardsClean(clean);
          commit(next, clean ?? cardsClean);
        }}
        onCardsClean={(ok) => {
          setCardsClean(ok);
          commit(latest.current, ok);
        }}
      />
      {/* Only once everything on screen is on file: moving on must not drop an unsaved edit. */}
      <div className="memo-actions">
        <button type="button" className="flow-next" disabled={!stored || !settled} onClick={nextHand}>
          ＋ 다음 핸드
        </button>
        <button type="button" className="ghost" disabled={!settled} onClick={toTable}>
          테이블로 이어서 기록 →
        </button>
      </div>
    </>
  );
}

/**
 * The quick screen's fields, in the order they come back to mind: cards, seat, blinds, stack, result,
 * note. `onChange` carries the card field's clean flag with a card edit (undefined for the other fields).
 */
function QuickFields({ h, onChange, onCardsClean }: { h: LoggedHand; onChange: (h: LoggedHand, cardsClean?: boolean) => void; onCardsClean: (ok: boolean) => void }) {
  const set = (patch: Partial<LoggedHand>) => onChange({ ...h, ...patch });
  const [sizes, setSizes] = useState(false);
  const [blinds, setBlinds] = useState(false);
  const seats = positionsFor(h.players);
  const bb = stackBb(h);

  const pickPlayers = (n: number) => {
    // A new table size changes the seat names: keep mine only if it still exists (as on the table).
    if (n !== h.players) set({ players: n, seat: positionsFor(n).includes(h.seat) ? h.seat : "", stacks: {} });
    setSizes(false);
  };

  return (
    <div className="memo-body quick-body">
      <div className="quick-hand">
        <div className="flow-label">
          내 핸드 {h.hole.length === 2 && <small>{handClassOf(h.hole[0], h.hole[1])}</small>}
        </div>
        {/* No autofocus: iOS would pop its keyboard up over the keypad. */}
        <CardText cards={h.hole} max={2} taken={[]} onChange={(hole, clean) => onChange({ ...h, hole }, clean)} onValid={onCardsClean} />
      </div>
      <div className="memo-sec">
        <div className="flow-label">
          내 포지션 {h.seat && <small>{h.seat}</small>}
          <button type="button" className="memo-size" aria-expanded={sizes} aria-label={`테이블 ${h.players}인 · 인원 바꾸기`} onClick={() => setSizes(!sizes)}>
            {h.players}인 <i>{sizes ? "▴" : "▾"}</i>
          </button>
        </div>
        {sizes && <ChipRow items={TABLE_SIZES} value={h.players} label={(n) => `${n}인`} onPick={pickPlayers} />}
        <ChipRow items={seats} value={h.seat} onPick={(s) => set({ seat: h.seat === s ? "" : s })} className={`seats n${seats.length}`} />
      </div>
      <div className="flow-form">
        <BlindRow
          level={h.level}
          bbAnte={h.bbAnte}
          onLevel={(level) => set({ level })}
          onAnte={(bbAnte) => set({ bbAnte })}
          open={blinds}
          onToggle={() => setBlinds(!blinds)}
          unknownLabel="레벨 모름"
        />
        <label className="flow-row-box flow-row-in">
          <span>내 스택</span>
          <ChipsInput value={h.stack} unit="chips" onChange={(stack) => set({ stack })} placeholder="칩 (예: 32,000)" />
          <small>{bb !== null ? `= ${bb}bb` : h.stack !== null ? "레벨 고르면 bb" : ""}</small>
        </label>
      </div>
      <div className="memo-sec">
        <div className="flow-label">결과</div>
        <ChipRow items={RESULTS} value={h.result} label={(r) => RESULT_LABEL[r]} onPick={(r) => set({ result: h.result === r ? null : r })} className="fill" />
      </div>
      <label className="memo-sec">
        <span className="flow-label">메모</span>
        <textarea rows={2} value={h.note} onChange={(e) => set({ note: e.target.value })} placeholder="예) BTN 아재 K9s로 올인 콜, 내 AQo 짐" />
      </label>
    </div>
  );
}

function HandRow({ h, onClick }: { h: LoggedHand; onClick: () => void }) {
  const bb = stackBb(h);
  return (
    <button className="log-row" onClick={onClick}>
      <span className="log-row-main">
        <b className="log-seat">{h.seat || "-"}</b>
        {h.hole.length ? <CardRow cards={h.hole} size="sm" /> : <span className="muted small">카드 없음</span>}
        {bb !== null && <span className="small">{bb}bb</span>}
        {/* A quick hand not carried on to the table yet: it opens on the quick screen. */}
        {isQuickHand(h) && <span className="log-tag">이어 쓰기</span>}
        {h.result && <span className={`log-result ${h.result}`}>{RESULT_LABEL[h.result]}</span>}
      </span>
      <span className="muted small">
        {timeLabel(h.createdAt)} · {levelLabel(h.level)}
        {hasDetail(h) ? " · 자세히" : ""}
        {h.showdowns.length ? ` · 쇼다운 ${h.showdowns.length}` : ""}
      </span>
      {h.note.trim() && <span className="log-note small">{h.note.trim()}</span>}
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
      return `- ${dayLabel(hand.createdAt)} ${levelLabel(hand.level)} · 상대 ${showdown.seat || "자리 모름"} ${showdown.cards.length ? holeText(showdown.cards) : "카드 모름"}${showdown.did.trim() ? ` — ${showdown.did.trim()}` : ""} (내 자리 ${hand.seat || "모름"}${bb !== null ? `, 내 스택 ${bb}bb` : ""})`;
    });
    coach.open({
      id: `villain:${name}:${entries.length}:${entries[0].hand.updatedAt}`,
      title: `상대 분석 · ${name}`,
      facts: [
        "게임: 홀덤펍 토너먼트 · 9인 · BB 앤티. 사용자가 실제로 본 상대의 쇼다운 기록.",
        `상대: ${name} · 쇼다운 ${entries.length}번`,
        ...lines,
      ].join("\n"),
      defaultQuestion: "이 상대가 보여준 핸드로 성향을 정리해줘. 그리고 이 상대에게 내 오픈·올인·콜 레인지를 어떻게 조정하면 좋을지 알려줘. 표본이 적으면 그 점도 감안해서 말해줘.",
    });
  }

  return (
    <>
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
                {showdown.cards.length ? <CardRow cards={showdown.cards} size="sm" /> : <span className="muted small">카드 모름</span>}
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

function BackupBox({ hands }: { hands: LoggedHand[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<Msg>(null);

  async function exportFile() {
    const json = exportData(hands);
    const day = new Date().toISOString().slice(0, 10);
    // Share sheets accept plain text files more widely than JSON.
    const file = new File([json], `pubaj-hands-${day}.txt`, { type: "text/plain" });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "PubAJ 핸드 기록 백업" });
        return;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `pubaj-hands-${day}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importFile(f: File) {
    try {
      const prev = handLogStore.get();
      const { hands: merged, added, updated } = mergeImport(await f.text(), prev.hands);
      if (handLogStore.set({ ...prev, hands: merged })) setMsg({ text: `불러왔어요. 새 기록 ${added}개, 업데이트 ${updated}개.` });
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
        <button className="ghost" disabled={!hands.length} onClick={() => void exportFile()}>
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
