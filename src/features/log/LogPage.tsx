import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardPicker, CardRow } from "../../components/Cards";
import { cardLabel, RANKS, SUIT_SYMBOL, SUITS, type Card } from "../../poker/cards";
import { useCoach } from "../coach/CoachContext";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import {
  deleteHand,
  emptyHand,
  exportData,
  handFacts,
  handLogStore,
  handProgress,
  hasContent,
  hasDetail,
  holeText,
  knownNames,
  levelLabel,
  LOG_SEATS,
  mergeImport,
  PROGRESS_LABEL,
  putAside,
  rememberSetup,
  RESULT_LABEL,
  resumeOffer,
  saveHand,
  stackBb,
  villainBook,
  type LoggedHand,
  type Result,
} from "./handLog";
import type { FlowStep } from "./flowSteps";
import { TableFlow } from "./TableFlow";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
const NAMES_LIST_ID = "log-villain-names";

type Msg = { text: string; error?: boolean } | null;

/**
 * Routes: "log" (a new hand, straight onto the table), "log/list" (past hands, quick memo, backup),
 * "log/players" (showdowns by opponent), "log/<id>" (one saved hand).
 */
export function LogPage({ sub, go }: { sub: string; go: (route: string) => void }) {
  const { hands } = handLogStore.use();
  const view = sub === "" || sub === "new" ? "new" : sub === "list" ? "list" : sub === "players" ? "players" : "edit";
  return (
    <div className="page log-page">
      <datalist id={NAMES_LIST_ID}>
        {knownNames(hands).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {view === "new" && <NewHandView hands={hands} go={go} />}
      {view === "edit" && <EditView key={sub} id={sub} hands={hands} go={go} />}
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

  const listLink = (
    <button type="button" className="log-link" onClick={() => go("log/list")}>
      지난 핸드{hands.length ? <span className="log-link-n"> {hands.length}개</span> : null} ›
    </button>
  );
  // On the first line of the table setup, so the screen still fits one view on a phone.
  const aside = (
    <span className="flow-aside">
      {resume && (
        <button
          type="button"
          className="log-resume"
          onClick={() => go(`log/${resume.id}`)}
          aria-label={["이어서 기록:", resume.seat || "자리 전", resume.hole.map(cardLabel).join(""), "·", PROGRESS_LABEL[handProgress(resume)]].filter(Boolean).join(" ")}
        >
          <b>↺ 이어서</b>
          <span>
            {resume.seat || "자리 전"} {resume.hole.length ? <HoleText cards={resume.hole} /> : null}
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
      if (h && !hasContent(h)) deleteHand(id);
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

// ───────────── past hands + quick memo ─────────────

function ListView({ hands, go }: { hands: LoggedHand[]; go: (route: string) => void }) {
  const [limit, setLimit] = useState(50);
  const groups = useMemo(() => groupByDay(hands.slice(0, limit)), [hands, limit]);

  return (
    <>
      <QuickMemo go={go} />
      {hands.length === 0 ? (
        <p className="muted small">아직 기록이 없어요. ＋ 새 핸드로 테이블에서 기록하거나, 빠른 메모로 카드만 찍어 두세요.</p>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="log-list">
            <div className="log-day">
              {g.day} · {g.hands.length}핸드
            </div>
            {g.hands.map((h) => (
              <HandRow key={h.id} h={h} onClick={() => go(`log/${h.id}`)} />
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

/** Jot down just the cards, seat and stack; folded away until asked for. */
function QuickMemo({ go }: { go: (route: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LoggedHand>(() => emptyHand());
  const [msg, setMsg] = useState<Msg>(null);
  const ready = hasContent(draft);

  function save(detail: boolean) {
    if (!ready) return;
    if (!saveHand(draft)) return setMsg({ text: FULL_MSG, error: true });
    if (detail) return go(`log/${draft.id}`);
    setMsg({ text: "저장했어요." });
    setDraft(emptyHand(draft.level));
  }

  return (
    <section className={`card-box log-memo ${open ? "open" : ""}`}>
      <button type="button" className="log-memo-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>빠른 메모</b>
        <span className="muted small">카드·자리·스택만 찍어 두고 나중에 이어서</span>
        <em>{open ? "▴" : "▾"}</em>
      </button>
      {open && (
        <>
          <HandFields
            h={draft}
            onChange={(h) => {
              setDraft(h);
              setMsg(null);
            }}
          />
          <div className="row-gap wrap">
            <button className="primary" disabled={!ready} onClick={() => save(false)}>
              저장
            </button>
            <button className="ghost" disabled={!ready} onClick={() => save(true)}>
              저장하고 테이블로 기록
            </button>
          </div>
        </>
      )}
      {msg && <div className={`notice ${msg.error ? "error" : ""}`}>{msg.text}</div>}
    </section>
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

/** Quick memo fields: level, seat, cards, stack, result, note. */
function HandFields({ h, onChange }: { h: LoggedHand; onChange: (h: LoggedHand) => void }) {
  const set = (patch: Partial<LoggedHand>) => onChange({ ...h, ...patch });
  const bb = stackBb(h);
  const sdCards = h.showdowns.flatMap((s) => s.cards);

  return (
    <div className="log-form">
      <label className="field">
        레벨
        <select className="select" value={h.level ?? ""} onChange={(e) => set({ level: e.target.value ? Number(e.target.value) : null })}>
          <option value="">레벨 모름</option>
          {BLIND_LEVELS.map(([lv, sb, big]) => (
            <option key={lv} value={lv}>
              Lv{lv} · {sb.toLocaleString()}/{big.toLocaleString()}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        내 자리
        <SeatChips value={h.seat} onChange={(seat) => set({ seat })} />
      </div>

      <CardField label="내 카드" cards={h.hole} max={2} disabled={[...h.board, ...sdCards]} onChange={(hole) => set({ hole })} defaultOpen />

      <label className="field">
        <span>
          내 스택 (칩) <span className="muted small">{bb !== null ? `= ${bb}bb` : h.stack !== null ? "레벨을 고르면 bb로 보여줘요" : ""}</span>
        </span>
        <ChipsInput value={h.stack} onChange={(stack) => set({ stack })} placeholder="예) 34,000" />
      </label>

      <div className="field">
        결과
        <div className="chips">
          {(Object.keys(RESULT_LABEL) as Result[]).map((r) => (
            <button key={r} type="button" className={`chip ${h.result === r ? "on" : ""}`} onClick={() => set({ result: h.result === r ? null : r })}>
              {RESULT_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        메모
        <textarea rows={2} value={h.note} onChange={(e) => set({ note: e.target.value })} placeholder="예) BTN 아재 K9s로 올인 콜, 내 AQo 짐" />
      </label>

    </div>
  );
}

function SeatChips({ value, onChange, allowEmpty = true }: { value: string; onChange: (seat: string) => void; allowEmpty?: boolean }) {
  return (
    <div className="seat-chips">
      {LOG_SEATS.map((s) => (
        <button key={s} type="button" className={`chip ${value === s ? "on" : ""}`} onClick={() => onChange(value === s && allowEmpty ? "" : s)}>
          {s}
        </button>
      ))}
    </div>
  );
}

function CardField(props: { label: string; cards: Card[]; max: number; disabled: Card[]; onChange: (cards: Card[]) => void; defaultOpen: boolean }) {
  const { label, cards, max, disabled, onChange } = props;
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <div className="field">
      <div className="row-between">
        <span>{label}</span>
        <span className="row-gap">
          {cards.length ? <CardRow cards={cards} size="sm" /> : <span className="muted small">없음</span>}
          {cards.length > 0 && (
            <button type="button" className="ghost small" onClick={() => onChange([])}>
              지우기
            </button>
          )}
          <button type="button" className="ghost small" onClick={() => setOpen(!open)}>
            {open ? "접기" : "고르기"}
          </button>
        </span>
      </div>
      {open && <CardPicker selected={cards} max={max} disabled={disabled} onChange={onChange} />}
    </div>
  );
}

/** Digits-only chip count shown with thousands separators. */
function ChipsInput({ value, onChange, placeholder }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  return (
    <input
      inputMode="numeric"
      value={value !== null ? value.toLocaleString() : ""}
      placeholder={placeholder}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, "");
        onChange(digits ? Number(digits) : null);
      }}
    />
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
            <button key={`${hand.id}:${i}`} className="log-row" onClick={() => go(`log/${hand.id}`)}>
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
