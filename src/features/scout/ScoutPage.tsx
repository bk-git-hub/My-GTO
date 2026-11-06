import { useEffect, useRef, useState } from "react";
import {
  activeSession,
  currentHand,
  deleteHand,
  exportJson,
  handBlank,
  hasHistory,
  handOrder,
  mergeState,
  newPerson,
  nextHand,
  parseShow,
  prevHand,
  renamePlayer,
  sanitizeState,
  scoutStore,
  setButton,
  setMySeat,
  setNote,
  setShow,
  setSize,
  setStreet,
  startSession,
  stepButton,
  TABLE_SIZES,
  tapAct,
  toggleEmpty,
  toggleWon,
  updateActive,
  type Act,
  type ScoutHand,
  type ScoutSession,
  type Street,
} from "./scout";
import { handsRecorded, pct, playerLabel, sessionStats, SMALL_SAMPLE, type PlayerStats } from "./stats";
import "./scout.css";

/** 정보 수집: one screen per hand, built for tapping fast at a live table. */

const ACT_LABEL: Record<Act, string> = { L: "림프", R: "레이즈", "3": "3벳+", A: "올인" };
const ACT_WORD: Record<Act, string> = { L: "림프/콜", R: "레이즈", "3": "3벳+", A: "올인" };
const STREET_LABEL: Record<Street, string> = { pre: "프리플랍 끝", flop: "플랍", turn: "턴", river: "리버" };
const SUIT_SYM: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** Shown cards as colored text: "Kh9h" → K♥9♥, a class stays as typed. */
function ShowText({ show }: { show: string }) {
  const p = parseShow(show);
  if (!p.ok) return <span className="sc-show bad">{show || "?"}</span>;
  if (!p.exact) return <span className="sc-show">{p.norm}</span>;
  return (
    <span className="sc-show">
      {[0, 2].map((i) => (
        <span key={i} className={`s-${p.norm[i + 1]}`}>
          {p.norm[i]}
          {SUIT_SYM[p.norm[i + 1]]}
        </span>
      ))}
    </span>
  );
}

/** Shown cards as text with its own keypad: exact cards ("Kh9h") or a class ("K9s", "AQo", "77"). */
function ShowInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const p = parseShow(value);
  const put = (t: string) => {
    const q = parseShow(t);
    onChange(q.ok ? q.norm : t);
  };
  return (
    <div className="sc-showin">
      <div className={`sc-showfield ${p.ok ? "ok" : p.partial ? "" : "bad"}`}>
        <input
          value={value}
          onChange={(e) => put(e.target.value)}
          placeholder="K9s · AQo · 77 · Kh9h"
          aria-label="쇼다운 카드"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="none"
        />
        {p.ok && <span className="sc-cls">{p.exact ? p.cls : ""}</span>}
      </div>
      <div className="sc-keys ranks">
        {"AKQJT98765432".split("").map((k) => (
          <button key={k} type="button" onClick={() => put(value + k)}>
            {k}
          </button>
        ))}
        <button type="button" onClick={() => put(value.slice(0, -1))} aria-label="지우기">
          ⌫
        </button>
      </div>
      <div className="sc-keys suits">
        {"shdc".split("").map((s) => (
          <button key={s} type="button" className={`s-${s}`} onClick={() => put(value + s)} aria-label={`무늬 ${s}`}>
            {SUIT_SYM[s]}
          </button>
        ))}
        <button type="button" onClick={() => put(value + "s")}>
          s<small>수딧</small>
        </button>
        <button type="button" onClick={() => put(value + "o")}>
          o<small>오프</small>
        </button>
      </div>
    </div>
  );
}

function SetupBox(props: { s: ScoutSession; open: boolean; onToggle: () => void; upd: (fn: (s: ScoutSession) => ScoutSession) => void; sessions: ScoutSession[] }) {
  const { s, open, onToggle, upd, sessions } = props;
  const empty = s.occ.filter((p) => !p).length;
  const named = s.occ.filter((p) => p && s.players[p]?.name).length;
  const summary = `${s.size}인 · ${s.mySeat ? `내 자리 ${s.mySeat}번` : "내 자리 없음"}${empty ? ` · 빈 자리 ${empty}` : ""}${named ? ` · 닉 ${named}` : ""}`;
  const pickMySeat = (n: number) => {
    const me = s.mySeat ? s.occ[s.mySeat - 1] : null;
    const moving = !!me && !!s.players[me]?.me && hasHistory(s, me);
    if (moving && s.mySeat === n) return; // my hands are recorded: keep a seat (pick another to move)
    const there = s.occ[n - 1] ? ` ${n}번에 있던 사람 기록은 그대로 남아요.` : "";
    if (moving && !confirm(`내 자리를 ${n}번으로 옮길까요?\n${s.mySeat}번은 빈 자리가 돼요.${there}`)) return;
    upd((x) => setMySeat(x, x.mySeat === n ? null : n));
  };
  return (
    <div className={`sc-setup ${open ? "open" : ""}`}>
      <button type="button" className="sc-setup-head" aria-expanded={open} onClick={onToggle}>
        <span>테이블</span>
        <b>{summary}</b>
        <i>{open ? "▴" : "▾"}</i>
      </button>
      {open && (
        <div className="sc-setup-body">
          <div className="sc-line">
            <span className="sc-label">인원</span>
            <div className="sc-chips">
              {TABLE_SIZES.map((n) => (
                <button key={n} type="button" className={s.size === n ? "on" : ""} onClick={() => upd((x) => setSize(x, n))}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="sc-line">
            <span className="sc-label">내 자리</span>
            <div className="sc-chips seats">
              {Array.from({ length: s.size }, (_, i) => i + 1).map((n) => (
                <button key={n} type="button" className={s.mySeat === n ? "on" : ""} onClick={() => pickMySeat(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="sc-seats">
            {s.occ.map((pid, i) => {
              const seat = i + 1;
              const p = pid ? s.players[pid] : null;
              return (
                <div key={seat} className={`sc-seat ${p ? "" : "empty"} ${p?.me ? "me" : ""}`}>
                  <b>{seat}</b>
                  {p ? (
                    p.me ? (
                      <span className="sc-me">나</span>
                    ) : (
                      <input value={p.name} placeholder={`${seat}번 자리 닉네임`} maxLength={16} onChange={(e) => upd((x) => renamePlayer(x, p.id, e.target.value))} aria-label={`${seat}번 닉네임`} />
                    )
                  ) : (
                    <span className="sc-me muted">빈 자리</span>
                  )}
                  <button type="button" onClick={() => upd((x) => toggleEmpty(x, seat))}>
                    {p ? "비움" : "앉음"}
                  </button>
                  {p && !p.me && (
                    <button type="button" onClick={() => upd((x) => newPerson(x, seat))} title="자리 바뀜/새 사람">
                      새 사람
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="sc-hint">새 사람·비움은 지금 핸드에 아무것도 안 찍힌 자리면 바로, 아니면 다음 핸드부터 적용돼요.</p>
          <div className="sc-line end">
            {sessions.length > 1 && (
              <select
                className="select sc-session-pick"
                value={s.id}
                onChange={(e) => scoutStore.set((st) => ({ ...st, active: e.target.value }))}
                aria-label="세션 고르기"
              >
                {[...sessions].reverse().map((x) => (
                  <option key={x.id} value={x.id}>
                    {new Date(x.started).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {handsRecorded(x)}핸드
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                if (confirm("새 세션을 시작할까요? (지금 세션은 그대로 저장돼요)")) startSession();
              }}
            >
              새 세션
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HandView({ s, upd }: { s: ScoutSession; upd: (fn: (s: ScoutSession) => ScoutSession) => void }) {
  const h: ScoutHand = currentHand(s);
  const order = handOrder(h);
  const [open, setOpen] = useState<string | null>(null);
  const [pickBtn, setPickBtn] = useState(false);
  const latest = s.cur === s.hands.length - 1;
  const btn = order.find((x) => x.pos === "BTN" || (order.length === 2 && x.pos === "SB"));
  const btnPlayer = btn ? s.players[btn.pid] : null;
  // a new (or earlier) hand starts closed, scrolled so the hand header sits under the app bar (UTG first)
  const first = useRef(true);
  const head = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOpen(null);
    setPickBtn(false);
    if (first.current) {
      first.current = false;
      return;
    }
    const el = head.current;
    const bar = document.querySelector(".app-head")?.getBoundingClientRect().height ?? 0;
    if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - bar - 6));
  }, [h.id]);
  // a double or stray tap on 다음 핸드 must not close an extra empty hand
  const lastNext = useRef(0);
  const goNext = () => {
    const now = Date.now();
    if (now - lastNext.current < 700) return;
    lastNext.current = now;
    upd(nextHand);
  };

  let raised = false;
  const entered = Object.keys(h.acts).length;
  return (
    <>
      <div className="sc-handhead" ref={head}>
        <div className="sc-handno">
          <b>#{h.no}</b>
          {!latest && <small>수정 중</small>}
          {!latest && (
            <button
              type="button"
              className="sc-del"
              onClick={() => {
                if (confirm(`#${h.no} 핸드를 지울까요? (뒤 핸드 번호가 하나씩 당겨져요)`)) upd(deleteHand);
              }}
            >
              삭제
            </button>
          )}
        </div>
        <div className="sc-btn">
          <button type="button" aria-label="버튼 뒤로" onClick={() => upd((x) => stepButton(x, -1))}>
            ‹
          </button>
          <button type="button" className="sc-btn-mid" onClick={() => setPickBtn(!pickBtn)} aria-expanded={pickBtn}>
            <span className="sc-d">D</span>
            {btn ? `${btn.seat}번` : "-"}
            {btnPlayer && (btnPlayer.me ? " 나" : btnPlayer.name ? ` ${btnPlayer.name}` : "")}
          </button>
          <button type="button" aria-label="버튼 앞으로" onClick={() => upd((x) => stepButton(x, 1))}>
            ›
          </button>
        </div>
      </div>
      {pickBtn && (
        <div className="sc-chips seats sc-btnpick">
          {h.seats.map(([seat]) => (
            <button
              key={seat}
              type="button"
              className={btn?.seat === seat ? "on" : ""}
              onClick={() => {
                upd((x) => setButton(x, seat));
                setPickBtn(false);
              }}
            >
              {seat}
            </button>
          ))}
        </div>
      )}
      <div className="sc-rows">
        {order.map((x, i) => {
          const p = s.players[x.pid];
          const a = h.acts[x.pid];
          const before = raised;
          if (a === "R" || a === "3" || a === "A") raised = true;
          const isBB = order.length >= 2 && i === order.length - 1;
          const lLabel = before ? "콜" : isBB ? "체크" : ACT_LABEL.L;
          const called = h.called.includes(x.pid);
          const sd = h.sd[x.pid];
          const isOpen = open === x.pid;
          return (
            <div key={x.pid} className={`sc-rowwrap ${isOpen ? "open" : ""}`}>
              <div className={`sc-row ${p?.me ? "me" : ""} ${a ? "in" : ""}`}>
                <button type="button" className="sc-who" onClick={() => setOpen(isOpen ? null : x.pid)} aria-expanded={isOpen}>
                  <span className="sc-pos">{x.pos}</span>
                  <span className="sc-name">
                    <b>{x.seat}</b>
                    {p?.me ? "나" : p?.name || <span className="muted">{x.seat}번</span>}
                  </span>
                  {sd && (
                    <span className="sc-sdtag">
                      {sd.show ? <ShowText show={sd.show} /> : "쇼"}
                      {sd.won && <em>승</em>}
                    </span>
                  )}
                </button>
                <div className="sc-acts">
                  {(["L", "R", "3", "A"] as Act[]).map((k) => (
                    <button key={k} type="button" className={`k-${k === "3" ? "3b" : k} ${a === k ? "on" : ""}`} aria-pressed={a === k} onClick={() => upd((y) => tapAct(y, x.pid, k))}>
                      {k === "L" ? lLabel : ACT_LABEL[k]}
                      {a === k && called && <small>→콜</small>}
                    </button>
                  ))}
                </div>
              </div>
              {isOpen && (
                <div className="sc-detail">
                  {p && !p.me && (
                    <input className="sc-nick" value={p.name} maxLength={16} placeholder={`${x.seat}번 닉네임 (예: 빨간모자)`} onChange={(e) => upd((y) => renamePlayer(y, x.pid, e.target.value))} aria-label="닉네임" />
                  )}
                  <div className="sc-sdline">
                    <span className="sc-label">쇼다운</span>
                    <button type="button" className={`sc-won ${sd?.won ? "on" : ""}`} aria-pressed={!!sd?.won} onClick={() => upd((y) => toggleWon(y, x.pid))}>
                      {sd?.won ? "✓ 이김" : "이김?"}
                    </button>
                    {sd && (
                      <button type="button" className="sc-clear" onClick={() => upd((y) => setShow(y, x.pid, null))}>
                        지우기
                      </button>
                    )}
                    <button type="button" className="sc-close" onClick={() => setOpen(null)}>
                      닫기
                    </button>
                  </div>
                  <ShowInput value={sd?.show ?? ""} onChange={(v) => upd((y) => setShow(y, x.pid, v))} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="sc-chips sc-street" role="group" aria-label="어디까지">
        {(Object.keys(STREET_LABEL) as Street[]).map((k) => (
          <button key={k} type="button" className={h.street === k ? "on" : ""} onClick={() => upd((y) => setStreet(y, k))}>
            {STREET_LABEL[k]}
          </button>
        ))}
      </div>
      <input className="sc-note" value={h.note ?? ""} maxLength={200} placeholder="한 줄 메모 (선택)" onChange={(e) => upd((y) => setNote(y, e.target.value))} />
      <div className="sc-foot">
        <button type="button" className="ghost" disabled={s.cur === 0} onClick={() => upd(prevHand)}>
          ↶ 이전
        </button>
        <button type="button" className="primary" onClick={goNext}>
          {latest ? "다음 핸드 ▶" : `#${h.no + 1} 로 ▶`}
          <small>{handBlank(h) ? "모두 폴드" : `참여 ${entered}명`}</small>
        </button>
      </div>
    </>
  );
}

function StatLine({ p }: { p: PlayerStats }) {
  const v = (n: number, d: number) => {
    const x = pct(n, d);
    return x === null ? "–" : `${x}`;
  };
  return (
    <div className={`sc-stat ${p.seated ? "" : "gone"}`}>
      <div className="sc-stat-head">
        <b>{playerLabel(p)}</b>
        <span className="muted">
          {p.name ? `${p.seat}번 · ` : ""}
          {p.hands}핸드{p.seated ? "" : " · 떠남"}
        </span>
        {p.hands < SMALL_SAMPLE && <span className="sc-small">표본 적음</span>}
      </div>
      <div className="sc-nums">
        <span>
          <i>VPIP</i>
          <b>{v(p.vpip, p.opps)}</b>
        </span>
        <span>
          <i>PFR</i>
          <b>{v(p.pfr, p.opps)}</b>
        </span>
        <span>
          <i>림프</i>
          <b>{v(p.limp, p.opps)}</b>
          {p.limpCall > 0 && <small>콜 {p.limpCall}</small>}
        </span>
        <span>
          <i>3벳</i>
          <b>{v(p.three, p.threeOpps)}</b>
          <small>
            {p.three}/{p.threeOpps}
          </small>
        </span>
      </div>
      {p.shows.length > 0 && (
        <div className="sc-shows">
          {p.shows.map((x, i) => (
            <span key={i}>
              <ShowText show={x.show} /> {x.pos}
              {x.act ? ` ${ACT_WORD[x.act]}` : ""}
              {x.won ? " ✓" : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatsView({ s }: { s: ScoutSession }) {
  const stats = sessionStats(s);
  const st = scoutStore.use();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const stamp = () => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  };
  async function doExport() {
    const json = exportJson(st);
    const name = `pubaj-scout-${stamp()}.json`;
    try {
      const f = new File([json], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [f] })) {
        await navigator.share({ files: [f], title: name });
        setMsg("내보냈어요");
        return;
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMsg("파일로 저장했어요");
  }
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(exportJson(st));
      setMsg("복사했어요 (메모장 등에 붙여 두세요)");
    } catch {
      setMsg("복사가 막혔어요 — 내보내기를 쓰세요");
    }
  }
  function importText(text: string) {
    try {
      const incoming = sanitizeState(JSON.parse(text));
      if (!incoming.sessions.length) {
        setMsg("가져올 세션이 없어요");
        return;
      }
      const r = mergeState(scoutStore.get(), incoming);
      const ok = scoutStore.set(r.state);
      setMsg(ok ? `합쳤어요: 새 세션 ${r.sessions}개 · 핸드 ${r.hands}개` : "저장 공간이 부족해요");
    } catch {
      setMsg("JSON을 읽지 못했어요");
    }
  }
  async function doPaste() {
    try {
      importText(await navigator.clipboard.readText());
    } catch {
      setMsg("붙여넣기가 막혔어요 — 파일로 가져오세요");
    }
  }
  const total = handsRecorded(s);
  return (
    <>
      <div className="sc-totals">
        <span>
          기록한 핸드 <b>{total}</b>
        </span>
        <span>
          플레이어 <b>{stats.length}</b>
        </span>
        <span className="muted">VPIP 순</span>
      </div>
      {stats.length === 0 ? (
        <p className="muted small sc-empty">아직 기록한 핸드가 없어요. 핸드 탭에서 액션을 찍고 ‘다음 핸드’를 누르세요.</p>
      ) : (
        <div className="sc-statlist">
          {stats.map((p) => (
            <StatLine key={p.pid} p={p} />
          ))}
        </div>
      )}
      <p className="sc-hint">VPIP·PFR·림프는 핸드 수 기준(BB 워크 제외), 3벳은 레이즈를 마주한 횟수 기준. BB 체크는 VPIP 아님.</p>
      <div className="sc-data">
        <span className="sc-label">데이터</span>
        <button type="button" className="ghost small" onClick={doExport}>
          내보내기
        </button>
        <button type="button" className="ghost small" onClick={doCopy}>
          복사
        </button>
        <button type="button" className="ghost small" onClick={() => file.current?.click()}>
          가져오기
        </button>
        <button type="button" className="ghost small" onClick={doPaste}>
          붙여넣기
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importText(await f.text());
          }}
        />
      </div>
      {msg && <p className="sc-msg">{msg}</p>}
    </>
  );
}

export function ScoutPage() {
  const st = scoutStore.use();
  const s = activeSession(st);
  const [tab, setTab] = useState<"hand" | "stats">("hand");
  const [setupOpen, setSetupOpen] = useState(() => !s || s.hands.every(handBlank));
  const [saveFailed, setSaveFailed] = useState(false);

  // the first visit starts a session right away
  useEffect(() => {
    if (!s) startSession(9, null);
  }, [s]);
  if (!s) return <div className="page sc-page" />;

  const upd = (fn: (x: ScoutSession) => ScoutSession) => setSaveFailed(!updateActive(fn));
  const total = handsRecorded(s);
  return (
    <div className="page sc-page">
      <div className="seg sc-tabs">
        <button type="button" className={tab === "hand" ? "on" : ""} onClick={() => setTab("hand")}>
          핸드 #{currentHand(s).no}
        </button>
        <button type="button" className={tab === "stats" ? "on" : ""} onClick={() => setTab("stats")}>
          통계 · {total}핸드
        </button>
      </div>
      {saveFailed && <div className="notice error">저장 실패! 통계 탭에서 바로 내보내기 하세요.</div>}
      {tab === "hand" ? (
        <>
          <SetupBox s={s} open={setupOpen} onToggle={() => setSetupOpen(!setupOpen)} upd={upd} sessions={st.sessions} />
          <HandView s={s} upd={upd} />
        </>
      ) : (
        <StatsView s={s} />
      )}
    </div>
  );
}
