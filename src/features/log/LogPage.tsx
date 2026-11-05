import { useEffect, useMemo, useRef, useState } from "react";
import { CardPicker, CardRow } from "../../components/Cards";
import { cardLabel, type Card } from "../../poker/cards";
import { useCoach } from "../coach/CoachContext";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import {
  deleteHand,
  emptyHand,
  exportData,
  handFacts,
  handLogStore,
  hasContent,
  hasDetail,
  holeText,
  knownNames,
  levelLabel,
  LOG_SEATS,
  mergeImport,
  RESULT_LABEL,
  saveHand,
  stackBb,
  villainBook,
  type LoggedHand,
  type Result,
} from "./handLog";
import { TableFlow } from "./TableFlow";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
const NAMES_LIST_ID = "log-villain-names";

type Msg = { text: string; error?: boolean } | null;

/** Routes: "log" (quick entry + list), "log/players" (showdowns by opponent), "log/<id>" (edit one hand). */
export function LogPage({ sub, go }: { sub: string; go: (route: string) => void }) {
  const { hands } = handLogStore.use();
  const tab = sub === "players" ? "players" : sub ? "edit" : "list";
  return (
    <div className="page">
      <div className="seg small">
        <button className={tab !== "players" ? "on" : ""} onClick={() => go("log")}>
          핸드 기록
        </button>
        <button className={tab === "players" ? "on" : ""} onClick={() => go("log/players")}>
          상대별 쇼다운
        </button>
      </div>
      <datalist id={NAMES_LIST_ID}>
        {knownNames(hands).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {tab === "list" && <ListView hands={hands} go={go} />}
      {tab === "edit" && <EditView key={sub} id={sub} hands={hands} go={go} />}
      {tab === "players" && <PlayersView hands={hands} go={go} />}
    </div>
  );
}

// ───────────── list + quick entry ─────────────

function ListView({ hands, go }: { hands: LoggedHand[]; go: (route: string) => void }) {
  const [draft, setDraft] = useState<LoggedHand>(() => emptyHand());
  const [msg, setMsg] = useState<Msg>(null);
  const [limit, setLimit] = useState(50);
  const groups = useMemo(() => groupByDay(hands.slice(0, limit)), [hands, limit]);
  const ready = hasContent(draft);

  function save(detail: boolean) {
    if (!ready) return;
    if (!saveHand(draft)) return setMsg({ text: FULL_MSG, error: true });
    if (detail) return go(`log/${draft.id}`);
    setMsg({ text: "저장했어요." });
    setDraft(emptyHand(draft.level));
  }

  function startTable() {
    const h = emptyHand();
    if (!saveHand(h)) return setMsg({ text: FULL_MSG, error: true });
    go(`log/${h.id}`);
  }

  return (
    <>
      <button className="cta log-new" onClick={startTable}>
        <span className="cta-icon">♠</span>
        <span className="cta-text">
          <b>새 핸드 기록</b>
          <span>테이블에서 자리·핸드 고르고, 액션한 자리만 순서대로 · 승률 자동 계산</span>
        </span>
        <span className="cta-go">→</span>
      </button>
      <section className="card-box">
        <div className="row-between">
          <h2>빠른 메모</h2>
          <span className="muted small">카드·자리·스택만 찍어 두고 나중에 이어서</span>
        </div>
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
        {msg && <div className={`notice ${msg.error ? "error" : ""}`}>{msg.text}</div>}
      </section>

      {hands.length === 0 ? (
        <p className="muted small">아직 기록이 없어요. 펍에서 기억해 둘 핸드가 나오면 위에서 바로 찍어 두세요.</p>
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

// ───────────── one hand ─────────────

function EditView({ id, hands, go }: { id: string; hands: LoggedHand[]; go: (route: string) => void }) {
  const stored = hands.find((h) => h.id === id);
  const [draft, setDraft] = useState<LoggedHand | undefined>(stored);
  const [msg, setMsg] = useState<Msg>(null);
  const [memo, setMemo] = useState(false);
  const coach = useCoach();

  // A hand started but left empty (nothing entered) shouldn't clutter the list.
  useEffect(
    () => () => {
      const h = handLogStore.get().hands.find((x) => x.id === id);
      if (h && !hasContent(h)) deleteHand(id);
    },
    [id],
  );

  if (!draft) {
    return (
      <section className="card-box">
        <p>이 기록을 찾을 수 없어요. 지웠거나 다른 기기에서 만든 기록이에요.</p>
        <button className="ghost" onClick={() => go("log")}>
          목록으로
        </button>
      </section>
    );
  }

  /** Every change is saved right away: a hand recorded at the table must not be lost. */
  function change(h: LoggedHand) {
    setDraft(h);
    setMsg(saveHand(h) ? null : { text: FULL_MSG, error: true });
  }

  function review(h: LoggedHand, extra: string) {
    change(h);
    coach.open({
      id: `log:${h.id}:${h.updatedAt}:${h.steps.length}:${h.showdowns.map((x) => x.cards.join("-")).join("|")}`,
      title: `기록 리뷰 · ${h.seat || "자리 모름"} ${h.hole.map(cardLabel).join("")}`,
      facts: handFacts(h) + extra,
      defaultQuestion:
        "내가 펍에서 실제로 친 핸드야. 스트리트별로 내 결정이 괜찮았는지, 결과와 상관없이 결정 자체가 좋았는지, 아쉬운 결정이 있다면 뭐였는지, 이런 펍아재 상대로는 어떻게 조정하면 좋을지 알려줘.",
    });
  }

  return (
    <>
      {msg && <div className={`notice ${msg.error ? "error" : ""}`}>{msg.text}</div>}
      <TableFlow h={draft} onChange={change} onReview={review} onClose={() => go("log")} />
      <div className="row-gap wrap">
        <button className="ghost small" onClick={() => setMemo(!memo)}>
          메모 {draft.note.trim() ? "✓" : ""}
        </button>
        <span className="muted small">{`${dayLabel(draft.createdAt)} ${timeLabel(draft.createdAt)} · 자동 저장`}</span>
        <button
          className="ghost small danger"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            if (confirm("이 핸드 기록을 지울까요?")) {
              deleteHand(draft.id);
              go("log");
            }
          }}
        >
          삭제
        </button>
      </div>
      {memo && <textarea rows={3} value={draft.note} onChange={(e) => change({ ...draft, note: e.target.value })} placeholder="예) BTN 아재가 리버에서 오래 고민하다 콜" />}
    </>
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
        아직 쇼다운 기록이 없어요. 핸드를 '자세히 입력'할 때 상대 쇼다운에 별명과 카드를 적으면 여기 상대별로 모여요. 레인지를 조정할 때 근거가
        돼요.
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
