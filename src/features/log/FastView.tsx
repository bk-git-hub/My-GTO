import { useEffect, useMemo, useState } from "react";
import { RANKS } from "../../poker/cards";
import {
  actLabel,
  actsFor,
  isThreeBet,
  seatsBefore,
  spotsFor,
  VERDICT_MARK,
  type FastSpot,
  type VerdictKind,
} from "./fastVerdict";
import {
  afterSave,
  cancelEdit,
  classDone,
  cleanFastState,
  draftClass,
  draftPlayers,
  draftReady,
  draftStage,
  fastHand,
  fastOtherStore,
  fastStats,
  fastStore,
  nextSeat,
  pickSuited,
  sessionOf,
  sessionText,
  shareTable,
  startEdit,
  storeFor,
  tapRank,
  undoTap,
  withSeat,
  withSpot,
  type FastMode,
  type FastState,
} from "./fastLog";
import {
  estimatedLevel,
  fastActText,
  fastOnly,
  fastVerdictOf,
  freshHand,
  handLogStore,
  handRoute,
  holeClass,
  lastStage,
  levelEstimateAt,
  saveHand,
  type LoggedHand,
} from "./handLog";
import { levelStage, PRE_STAGES, STAGE_LABEL, type PreAction } from "./quickPre";
import { buttonSeat, positionsFor, TABLE_SIZES } from "./recorder";
import { closeUndoOffer, deleteWithUndo } from "./undoDelete";

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";

/** The rank pad, high to low, and ⌫ to finish the second row. */
const PAD = "AKQJT98765432".split("");

/** The spot chips: two short lines each so five fit one row on a phone. 3벳 이상 covers both 3-bet spots (a row below picks which). */
const SPOT_CHIP: Record<Exclude<FastSpot, "cold3">, [string, string]> = { none: ["폴드로", "나에게"], limp: ["림프", "있음"], open: ["오픈", "있음"], shove: ["올인", "있음"], "3bet": ["3벳", "이상"] };
/** 남의 핸드: the same chips seen from the player whose hand it is. */
const SPOT_CHIP_OTHER: typeof SPOT_CHIP = { ...SPOT_CHIP, none: ["폴드로", "상대에게"] };
const SPOTS = ["none", "limp", "open", "shove", "3bet"] as const;

/** A seat chip's label: in the tightest rows (10 seats, 9 beside 오픈 자리) UTG+1 goes on two lines so it isn't clipped. */
function SeatText({ seat, tight }: { seat: string; tight: boolean }) {
  const m = tight ? /^(UTG)(\+\d)$/.exec(seat) : null;
  return m ? (
    <span className="two">
      <span>{m[1]}</span>
      <span>{m[2]}</span>
    </span>
  ) : (
    <>{seat}</>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** A verdict for a list row: "⚠ 오버 (폴드)", "▽ 언더 (오픈 72%)", another player's "⚠ 루즈 (폴드)", "차트 없음". */
const shortVerdict = (t: string) =>
  t.replace("오버플레이", "오버").replace("언더플레이", "언더").replace("차트보다 루즈", "루즈").replace("차트보다 타이트", "타이트").replace("차트: ", "").replace(" · 림프 팟", "");

/** Plain text to the clipboard: the async API, else a hidden textarea (older iOS). */
async function copyText(text: string): Promise<boolean> {
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

/** "내 핸드 | 남의 핸드" at the top of both quick screens. */
export function QuickToggle({ mine, go }: { mine: boolean; go: (route: string) => void }) {
  return (
    <div className="seg small fast-toggle" role="tablist" aria-label="빠른 기록">
      <button type="button" role="tab" aria-selected={mine} className={mine ? "on" : ""} onClick={() => !mine && go("log/fast")}>
        내 핸드
      </button>
      <button type="button" role="tab" aria-selected={!mine} className={!mine ? "on" : ""} onClick={() => mine && go("log/other")}>
        남의 핸드
      </button>
    </div>
  );
}

/** The hand just saved, its verdict shown under 내 액션 until the next hand is started. */
interface Saved {
  id: string;
  kind: VerdictKind;
  text: string;
  line: string;
}

/**
 * 빠른 기록: every hand dealt to me, a few taps each. The stage and the table size stay for the session;
 * my seat moves on by itself after each hand; the class goes in on a rank pad (no suits); what happened
 * before me defaults to 폴드로 나에게; tapping my action saves the hand, grades it against the pub chart
 * (shown under the actions with 되돌리기 until the next hand is started, and in today's list) and starts
 * the next hand.
 *
 * mode "other" is 남의 핸드, the same screen for a hand another player showed: their seat (it stays put
 * from hand to hand), their class, what happened before them, their action. It saves an other-hand and
 * judges it against the same chart, worded as how pub players play (차트보다 루즈 / 타이트).
 */
export function FastView({ hands, go, mode = "mine" }: { hands: LoggedHand[]; go: (route: string) => void; mode?: FastMode }) {
  const other = mode === "other";
  const store = storeFor(mode);
  // A first visit's stage: the level's usual one (from today's start time), else the last one used.
  const [fallback] = useState(() => levelStage(estimatedLevel(levelEstimateAt(Date.now()))) ?? lastStage() ?? "mid");
  // 남의 핸드's first visit starts at 빠른 기록's table (the same stage and table size).
  const [first] = useState(() => (other ? cleanFastState(fastStore.get(), fallback) : null));
  const clean = (x: unknown) => cleanFastState(x, first?.stage ?? fallback, first?.players);
  const raw = store.use();
  const s = clean(raw);
  /** The state as stored right now (a second tap in the same moment must not act on the old one). */
  const cur = () => clean(store.get());
  const set = (next: FastState) => store.set(next);
  /** A new stage or table size goes for the other screen too: both are the same table. */
  const share = (next: FastState) => {
    const twin = other ? fastStore : fastOtherStore;
    twin.set(shareTable(cleanFastState(twin.get(), next.stage, next.players), next.stage, next.players));
  };
  const d = s.draft;
  const players = draftPlayers(s);
  const stage = draftStage(s);
  const seats = positionsFor(players);
  const editing = d.editing ? (hands.find((h) => h.id === d.editing) ?? null) : null;
  const [justSaved, setSaved] = useState<Saved | null>(null);
  // The hand just saved was deleted (here or in 지난 기록): its verdict goes with it.
  const saved = justSaved && hands.some((h) => h.id === justSaved.id) ? justSaved : null;
  /** A short note by the class (a rank tapped into a full class while correcting). */
  const [nudge, setNudge] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [sizes, setSizes] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const session = useMemo(() => sessionOf(hands, Math.max(now, ...hands.slice(0, 1).map((h) => h.createdAt)), mode), [hands, now, mode]);
  const stats = useMemo(() => fastStats(session), [session]);

  // The hand being corrected was deleted (here or in 지난 기록): back to the new hand.
  useEffect(() => {
    if (d.editing && !editing) set(cancelEdit(cur()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.editing, editing]);
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(null), 2500);
    return () => clearTimeout(t);
  }, [nudge]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  // Any change to the hand on screen starts the next hand: the last verdict gives way to the hints.
  const draft = (f: (x: FastState["draft"], p: number) => FastState["draft"]) => {
    const c = cur();
    set({ ...c, draft: f(c.draft, draftPlayers(c)) });
    setSaved(null);
    setNudge(null);
  };
  function rank(k: string) {
    const c = cur();
    if (c.draft.editing && classDone(c.draft)) {
      setNudge("수정 중 · ⌫로 먼저 지우세요");
      return;
    }
    draft((v) => tapRank(v, RANKS.indexOf(k)));
  }

  function pickStage(x: (typeof PRE_STAGES)[number]) {
    const c = cur();
    if (c.draft.editing) {
      set({ ...c, draft: { ...c.draft, stage: x } });
      return;
    }
    const next = { ...c, stage: x };
    set(next);
    share(next);
  }
  function pickPlayers(n: number) {
    const c = cur();
    const seat = positionsFor(n).includes(c.draft.seat) ? c.draft.seat : buttonSeat(n);
    if (c.draft.editing) set({ ...c, draft: { ...withSeat(c.draft, seat, n), players: n } });
    else {
      const next = { ...c, players: n, draft: withSeat(c.draft, seat, n) };
      set(next);
      share(next);
    }
    setSizes(false);
  }

  function act(a: PreAction | undefined) {
    const c = cur();
    const p = draftPlayers(c);
    const editHand = c.draft.editing ? (handLogStore.get().hands.find((h) => h.id === c.draft.editing) ?? null) : null;
    const base = editHand ?? { ...freshHand(mode), players: p };
    const h = fastHand(c.draft, a, base, draftStage(c), p, mode);
    if (!h) return;
    const ok = saveHand(h);
    setFull(!ok);
    // Not on file: the hand stays on screen to try again.
    if (!ok) return;
    // Only one 되돌리기 on screen: the one under the actions, for the hand just saved.
    closeUndoOffer();
    const v = fastVerdictOf(h);
    set(afterSave(c, h, handLogStore.get().hands, mode));
    setSaved({ id: h.id, kind: v?.kind ?? "none", text: v?.text ?? "", line: `${h.seat} ${holeClass(h)} ${fastActText(h)}` });
    setNudge(null);
  }
  function edit(h: LoggedHand) {
    if (!fastOnly(h)) {
      go(handRoute(h));
      return;
    }
    set(startEdit(cur(), h, mode));
    setSaved(null);
    setNudge(null);
    window.scrollTo({ top: 0 });
  }
  function undo() {
    const h = saved ? handLogStore.get().hands.find((x) => x.id === saved.id) : null;
    if (h) edit(h);
    setSaved(null);
  }

  const cls = draftClass(d);
  const pairOrDone = d.ranks.length === 2 && d.ranks[0] === d.ranks[1];
  const needSuit = d.ranks.length === 2 && !pairOrDone;
  const spots = spotsFor(players, d.seat);
  const before = seatsBefore(players, d.seat);
  const acts = actsFor(d.spot, d.seat);
  const ready = draftReady(d, players);
  const savedAct = editing?.quickPre?.action;
  const recent = session.slice(0, 20);
  const chip = other ? SPOT_CHIP_OTHER : SPOT_CHIP;

  return (
    <div className="fast">
      <div className="fast-bar">
        <div className="fast-stages" role="group" aria-label="스택 구간 (차트)">
          {PRE_STAGES.map((x) => (
            <button key={x} type="button" className={stage === x ? "on" : ""} aria-pressed={stage === x} onClick={() => pickStage(x)}>
              {STAGE_LABEL[x]}
            </button>
          ))}
        </div>
        <button type="button" className="fast-size" aria-expanded={sizes} aria-label={`테이블 ${players}인 · 인원 바꾸기`} onClick={() => setSizes(!sizes)}>
          {players}인 <i>{sizes ? "▴" : "▾"}</i>
        </button>
      </div>
      {sizes && (
        <div className="fast-row fast-sizes">
          {TABLE_SIZES.filter((n) => n >= 3).map((n) => (
            <button key={n} type="button" className={n === players ? "on" : ""} onClick={() => pickPlayers(n)}>
              {n}인
            </button>
          ))}
        </div>
      )}
      {full && (
        <div className="notice error" role="alert">
          {FULL_MSG}
        </div>
      )}
      {editing && (
        <div className="fast-editing" role="status">
          <span>
            <b>✎ 수정 중</b> {clock(editing.createdAt)} {editing.seat} {holeClass(editing)} · 액션을 다시 누르면 저장
          </span>
          <button
            type="button"
            className="fast-mini danger"
            onClick={() => {
              if (!confirm("이 핸드를 지울까요?")) return;
              // Back to the new hand put aside, with 되돌리기 at the bottom for a few seconds.
              deleteWithUndo([editing.id]);
            }}
          >
            삭제
          </button>
          <button type="button" className="fast-mini" onClick={() => set(cancelEdit(cur()))}>
            취소
          </button>
        </div>
      )}

      <div className="fast-sec">
        <div className="fast-label">
          {other ? "상대 포지션" : "내 포지션"} <b>{d.seat}</b>
          <QuickToggle mine={!other} go={go} />
        </div>
        <div className={`fast-row fast-seats n${seats.length}`}>
          {seats.map((x) => (
            <button key={x} type="button" className={d.seat === x ? "on" : ""} onClick={() => draft((v, p) => withSeat(v, x, p))}>
              <SeatText seat={x} tight={seats.length >= 10} />
            </button>
          ))}
        </div>
      </div>

      <div className="fast-sec">
        <div className="fast-label">
          핸드
          {nudge && (
            <span className="fast-nudge" role="alert">
              {nudge}
            </span>
          )}
          <span className={`fast-class${classDone(d) ? " done" : ""}`} aria-live="polite">
            {cls || "—"}
            {needSuit && d.suited === null ? <small>?</small> : null}
          </span>
        </div>
        <div className="fast-pad">
          {PAD.map((k) => (
            <button key={k} type="button" onClick={() => rank(k)}>
              {k}
            </button>
          ))}
          <button type="button" className="fast-back" aria-label="지우기" disabled={!d.ranks.length} onClick={() => draft(undoTap)}>
            ⌫
          </button>
        </div>
        <div className={`fast-suits${needSuit && d.suited === null ? " ask" : ""}`}>
          <button type="button" className={d.suited === true ? "on" : ""} disabled={!needSuit} onClick={() => draft((v) => pickSuited(v, true))}>
            수딧
          </button>
          <button type="button" className={d.suited === false ? "on" : ""} disabled={!needSuit} onClick={() => draft((v) => pickSuited(v, false))}>
            오프수트
          </button>
        </div>
      </div>

      <div className="fast-sec">
        <div className="fast-label">상황{other && <small>상대 앞에서</small>}</div>
        <div className="fast-row fast-spots">
          {SPOTS.map((x) => {
            const three = x === "3bet";
            const on = three ? isThreeBet(d.spot) : d.spot === x;
            const can = three ? spots.includes("3bet") || spots.includes("cold3") : spots.includes(x);
            // 3벳 이상: over my open where I can open, else (the BB) a cold one.
            const to: FastSpot = three && !spots.includes("3bet") ? "cold3" : x;
            return (
              <button key={x} type="button" className={on ? "on" : ""} disabled={!can} onClick={() => !on && draft((v) => withSpot(v, to))}>
                <span>{chip[x][0]}</span>
                <span>{chip[x][1]}</span>
              </button>
            );
          })}
        </div>
        {(d.spot === "open" || d.spot === "shove") && (
          <div className="fast-opener">
            <span className="fast-sub">
              {d.spot === "open" ? "오픈" : "올인"}
              <br />
              자리
            </span>
            <div className={`fast-row fast-seats n${before.length}`}>
              {before.map((x) => (
                <button key={x} type="button" className={d.opener === x ? "on" : ""} onClick={() => draft((v) => ({ ...v, opener: x }))}>
                  <SeatText seat={x} tight={before.length >= 9} />
                </button>
              ))}
            </div>
          </div>
        )}
        {isThreeBet(d.spot) && (
          <div className="fast-opener">
            <span className="fast-sub">
              누가
              <br />
              오픈
            </span>
            <div className="fast-row fast-who">
              <button type="button" className={d.spot === "3bet" ? "on" : ""} disabled={!spots.includes("3bet")} onClick={() => draft((v) => withSpot(v, "3bet"))}>
                {other ? "상대 오픈에 3벳" : "내 오픈에 3벳"}
              </button>
              <button type="button" className={d.spot === "cold3" ? "on" : ""} disabled={!spots.includes("cold3")} onClick={() => draft((v) => withSpot(v, "cold3"))}>
                남끼리 오픈·3벳
              </button>
            </div>
          </div>
        )}
        {d.spot === "limp" && <p className="fast-hint">림프 팟은 차트가 없어서 판정 없이 저장돼요</p>}
      </div>

      <div className="fast-sec">
        <div className="fast-label">{other ? "상대 액션" : "내 액션"}</div>
        <div className={`fast-acts n${Math.max(acts.length, 1)}`}>
          {acts.length ? (
            acts.map((a) => (
              <button key={a} type="button" className={`a-${a}${editing && savedAct === a ? " on" : ""}`} disabled={!ready} onClick={() => act(a)}>
                {actLabel(d.spot, a, d.seat)}
              </button>
            ))
          ) : (
            <button type="button" className="a-walk" disabled={!ready} onClick={() => act(undefined)}>
              워크 (모두 폴드)
            </button>
          )}
        </div>
        {/* One fixed-height slot: the verdict of the hand just saved (with 되돌리기), else what to tap next. */}
        <div className={`fast-result${saved ? ` shown v-${saved.kind}` : ""}`} role="status" aria-live="polite">
          {saved ? (
            <>
              <span className="fr-text">
                <b>{saved.text || "저장했어요"}</b> <small>{saved.line}</small>
              </span>
              <button type="button" onClick={undo}>
                되돌리기
              </button>
            </>
          ) : (
            <span className="fr-hint">
              {ready
                ? editing
                  ? "누르면 이 핸드를 고쳐서 저장해요"
                  : other
                    ? `누르면 바로 저장 · 자리는 ${d.seat} 그대로`
                    : `누르면 바로 저장 · 다음 핸드는 ${nextSeat(players, d.seat)}`
                : !classDone(d)
                  ? needSuit
                    ? "수딧인지 오프수트인지 골라 주세요"
                    : "랭크 두 개를 누르세요"
                  : "오픈·올인한 자리를 골라 주세요"}
            </span>
          )}
        </div>
      </div>

      <section className="card-box fast-today">
        <div className="fast-today-head">
          <h2>{other ? "오늘 남의 핸드" : "오늘 빠른 기록"}</h2>
          <span className="muted small">{stats.total}핸드</span>
        </div>
        {stats.total ? (
          <>
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
            <div className="fast-list">
              {recent.map((h) => {
                const v = fastVerdictOf(h);
                const k = v?.kind ?? "none";
                const said = fastActText(h);
                return (
                  <button key={h.id} type="button" className={`fast-item v-${k}${d.editing === h.id ? " editing" : ""}`} onClick={() => edit(h)}>
                    <span className="fi-time">{clock(h.createdAt)}</span>
                    <b className="fi-seat">{h.seat}</b>
                    <b className="fi-class">{holeClass(h)}</b>
                    <span className="fi-act">{said}</span>
                    <span className="fi-verdict">{k === "ok" || k === "mixed" ? VERDICT_MARK[k] : v && v.text !== said ? shortVerdict(v.text) : VERDICT_MARK.none}</span>
                  </button>
                );
              })}
            </div>
            <p className="muted small">
              핸드를 누르면 고치거나 지울 수 있어요{session.length > recent.length ? ` · 최근 ${recent.length}핸드만 보여요, 전부는 지난 기록에서` : ""}
            </p>
            <div className="fast-today-foot">
              <button
                type="button"
                className="ghost small"
                onClick={async () => setCopied((await copyText(sessionText(session, mode))) ? "복사했어요 · 카톡이나 Claude에 붙여 넣으세요" : "복사하지 못했어요")}
              >
                오늘 요약 복사
              </button>
              <button type="button" className="log-link" onClick={() => go(other ? "log/list/other" : "log/list/mine")}>
                지난 기록 ›
              </button>
            </div>
            {copied && <p className="fast-hint ok">{copied}</p>}
          </>
        ) : (
          <p className="muted small">
            {other
              ? "아직 오늘 남의 핸드가 없어요. 보인 핸드마다 상대 자리 → 랭크 두 개 → 수딧/오프 → 상황 → 상대 액션만 누르면 저장돼요. 펍 사람들이 실제로 어떻게 치는지 모여요."
              : "아직 오늘 기록이 없어요. 핸드마다 자리 → 랭크 두 개 → 수딧/오프 → 액션만 누르면 저장돼요."}
          </p>
        )}
      </section>

    </div>
  );
}
