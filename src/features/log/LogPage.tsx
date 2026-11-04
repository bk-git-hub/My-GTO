import { useMemo, useRef, useState } from "react";
import { CardPicker, CardRow } from "../../components/Cards";
import { cardLabel, type Card } from "../../poker/cards";
import { useCoach } from "../coach/CoachContext";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import {
  deleteHand,
  emptyHand,
  emptyShowdown,
  exportData,
  handFacts,
  handLogStore,
  hasContent,
  hasDetail,
  holeText,
  knownNames,
  levelLabel,
  LOG_SEATS,
  LOG_STREET_LABEL,
  LOG_STREETS,
  mergeImport,
  RESULT_LABEL,
  saveHand,
  stackBb,
  villainBook,
  type LoggedHand,
  type Result,
  type ShowdownNote,
} from "./handLog";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
const NAMES_LIST_ID = "log-villain-names";
const ACTION_HINT: Record<string, string> = {
  preflop: "예) UTG 1,600 오픈, 나 BTN 콜",
  flop: "예) UTG 2,000 벳, 나 콜",
  turn: "예) 체크 체크",
  river: "예) UTG 올인, 나 폴드",
};

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

  return (
    <>
      <section className="card-box">
        <div className="row-between">
          <h2>빠른 기록</h2>
          <span className="muted small">카드·자리·스택만 찍고 저장</span>
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
            저장하고 자세히 입력
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

const comparable = (h: LoggedHand | undefined) => (h ? JSON.stringify({ ...h, updatedAt: 0 }) : "");

function EditView({ id, hands, go }: { id: string; hands: LoggedHand[]; go: (route: string) => void }) {
  const original = hands.find((h) => h.id === id);
  const [draft, setDraft] = useState<LoggedHand | undefined>(original);
  const [msg, setMsg] = useState<Msg>(null);
  const coach = useCoach();

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
  const dirty = comparable(draft) !== comparable(original);

  /** Save the draft if it changed; returns the stored copy, or null if storage is full. */
  function commit(): LoggedHand | null {
    if (!draft) return null;
    if (!dirty && original) return original;
    if (!saveHand(draft)) {
      setMsg({ text: FULL_MSG, error: true });
      return null;
    }
    const stored = handLogStore.get().hands.find((h) => h.id === draft.id) ?? draft;
    setDraft(stored);
    return stored;
  }

  function review() {
    const h = commit();
    if (!h) return;
    coach.open({
      id: `log:${h.id}:${h.updatedAt}`,
      title: `기록 리뷰 · ${h.seat || "자리 모름"} ${h.hole.map(cardLabel).join("")}`,
      facts: handFacts(h),
      defaultQuestion:
        "내가 펍에서 실제로 친 핸드야. 내 플레이가 괜찮았는지, 아쉬운 결정이 있다면 뭐였는지, 이런 펍아재 상대로는 어떻게 조정하면 좋을지 알려줘. 기록에 빠진 정보가 있으면 어떤 가정으로 판단했는지도 말해줘.",
    });
  }

  return (
    <>
      <div className="row-gap wrap">
        <button className="primary" onClick={() => commit() && go("log")}>
          {dirty ? "저장" : "목록으로"}
        </button>
        <button className="ghost" onClick={review} disabled={!hasContent(draft)}>
          AI 리뷰
        </button>
        {dirty && (
          <button className="ghost" onClick={() => go("log")}>
            저장 안 하고 닫기
          </button>
        )}
      </div>
      {msg && <div className={`notice ${msg.error ? "error" : ""}`}>{msg.text}</div>}
      <section className="card-box">
        <div className="muted small">{`${dayLabel(draft.createdAt)} ${timeLabel(draft.createdAt)}`}</div>
        <HandFields h={draft} onChange={setDraft} full />
      </section>
      <button
        className="ghost danger"
        onClick={() => {
          if (confirm("이 핸드 기록을 지울까요?")) {
            deleteHand(draft.id);
            go("log");
          }
        }}
      >
        이 기록 삭제
      </button>
    </>
  );
}

/** Quick fields; with `full`, also board, street actions, chip result and showdowns. */
function HandFields({ h, onChange, full = false }: { h: LoggedHand; onChange: (h: LoggedHand) => void; full?: boolean }) {
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

      <CardField label="내 카드" cards={h.hole} max={2} disabled={[...h.board, ...sdCards]} onChange={(hole) => set({ hole })} defaultOpen={!full || !h.hole.length} />

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

      {full && (
        <>
          <CardField label="보드" cards={h.board} max={5} disabled={[...h.hole, ...sdCards]} onChange={(board) => set({ board })} defaultOpen={false} />

          {LOG_STREETS.map((st) => (
            <label key={st} className="field">
              {LOG_STREET_LABEL[st]} 액션
              <input value={h.actions[st]} onChange={(e) => set({ actions: { ...h.actions, [st]: e.target.value } })} placeholder={ACTION_HINT[st]} />
            </label>
          ))}

          <NetField h={h} onChange={(net) => set({ net })} />

          <div className="field">
            상대 쇼다운
            <span className="muted small">상대 별명을 같게 적으면 '상대별 쇼다운'에 모여요.</span>
            {h.showdowns.map((sd, i) => (
              <ShowdownEditor
                key={i}
                sd={sd}
                taken={[...h.hole, ...h.board, ...h.showdowns.filter((_, j) => j !== i).flatMap((s) => s.cards)]}
                onChange={(next) => set({ showdowns: h.showdowns.map((s, j) => (j === i ? next : s)) })}
                onRemove={() => set({ showdowns: h.showdowns.filter((_, j) => j !== i) })}
              />
            ))}
            <button type="button" className="ghost small" onClick={() => set({ showdowns: [...h.showdowns, emptyShowdown()] })}>
              + 쇼다운 추가
            </button>
          </div>
        </>
      )}
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

function NetField({ h, onChange }: { h: LoggedHand; onChange: (net: number | null) => void }) {
  // Phone number pads have no minus key, so the sign is a toggle.
  const [negative, setNegative] = useState(h.net !== null ? h.net < 0 : h.result === "lose" || h.result === "fold");
  const amount = h.net !== null ? Math.abs(h.net) : null;
  const apply = (neg: boolean, a: number | null) => onChange(a === null ? null : neg ? -a : a);
  return (
    <label className="field">
      칩 변동
      <span className="row-gap">
        <button
          type="button"
          className={`ghost sign-btn ${negative ? "minus" : "plus"}`}
          onClick={() => {
            setNegative(!negative);
            apply(!negative, amount);
          }}
        >
          {negative ? "−" : "+"}
        </button>
        <ChipsInput value={amount} onChange={(a) => apply(negative, a)} placeholder="딴 칩 / 잃은 칩" />
      </span>
    </label>
  );
}

function ShowdownEditor(props: { sd: ShowdownNote; taken: Card[]; onChange: (sd: ShowdownNote) => void; onRemove: () => void }) {
  const { sd, taken, onChange, onRemove } = props;
  const set = (patch: Partial<ShowdownNote>) => onChange({ ...sd, ...patch });
  return (
    <div className="showdown-box">
      <div className="row-gap">
        <input list={NAMES_LIST_ID} value={sd.name} onChange={(e) => set({ name: e.target.value })} placeholder="상대 별명 (예: 빨간모자)" />
        <button type="button" className="ghost small" onClick={onRemove}>
          삭제
        </button>
      </div>
      <SeatChips value={sd.seat} onChange={(seat) => set({ seat })} />
      <CardField label="상대 카드" cards={sd.cards} max={2} disabled={taken} onChange={(cards) => set({ cards })} defaultOpen={!sd.cards.length} />
      <input value={sd.did} onChange={(e) => set({ did: e.target.value })} placeholder="한 플레이 (예: 올인 콜, 3벳, 림프 콜)" />
    </div>
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
