import { useMemo, useRef, useState } from "react";
import { QUIZ_KIND_LABEL, type AttemptGrade, type QuizKind } from "../../../shared/contracts";
import { exportAttemptsJson, importAttemptsJson, useAttemptLog, type LocalAttempt } from "../../state/attempts";
import { useStats } from "../../state/stats";
import { useCoach } from "../coach/CoachContext";
import {
  attemptFacts,
  byKind,
  filterHistory,
  formatTime,
  legacyTotals,
  overview,
  pctText,
  rate,
  RECENT_N,
  weakSpots,
  type Trend,
} from "./summary";

const PAGE = 30;
const GRADE_CHIP: Record<AttemptGrade, { cls: string; text: string }> = {
  correct: { cls: "good", text: "정답" },
  mixed: { cls: "ok", text: "부분 정답" },
  wrong: { cls: "mistake", text: "오답" },
};
const TREND: Record<Exclude<Trend, null>, { mark: string; cls: string; title: string }> = {
  up: { mark: "▲", cls: "up", title: "최근 정답률이 전체보다 높아요" },
  down: { mark: "▼", cls: "down", title: "최근 정답률이 전체보다 낮아요" },
  flat: { mark: "–", cls: "flat", title: "전체와 비슷해요" },
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RecordsPage({ go }: { go: (route: string) => void }) {
  const { items, saveFailed } = useAttemptLog();
  const stats = useStats();
  const coach = useCoach();
  const [kind, setKind] = useState<QuizKind | "all">("all");
  const [wrongOnly, setWrongOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // `now` is fixed per render of a new log so "오늘" and the bars stay consistent.
  const now = useMemo(() => Date.now(), [items]);
  const ov = useMemo(() => overview(items, now), [items, now]);
  const kinds = useMemo(() => byKind(items), [items]);
  const weak = useMemo(() => weakSpots(items), [items]);
  const history = useMemo(() => filterHistory(items, kind, wrongOnly), [items, kind, wrongOnly]);
  const legacy = useMemo(() => legacyTotals(stats.byKey, items), [stats.byKey, items]);
  const maxDay = Math.max(1, ...ov.days.map((d) => d.attempts));

  function exportNow() {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    download(`pubaz-records-${stamp}.json`, exportAttemptsJson());
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const r = importAttemptsJson(await file.text());
      const parts = [`${r.added}개 추가`];
      if (r.duplicates) parts.push(`이미 있던 기록 ${r.duplicates}개`);
      if (r.invalid) parts.push(`읽을 수 없는 줄 ${r.invalid}개 건너뜀`);
      setImportMsg({ ok: true, text: `가져오기 완료 — ${parts.join(", ")}` });
    } catch (e) {
      setImportMsg({ ok: false, text: e instanceof Error ? e.message : "가져오기에 실패했어요." });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function askCoach(a: LocalAttempt) {
    coach.open({
      id: `attempt:${a.id}`,
      title: a.title,
      facts: attemptFacts(a),
      defaultQuestion:
        a.grade === "wrong"
          ? "이 문제에서 내 선택이 왜 틀렸는지, 다음에 같은 상황에서 어떻게 생각하면 되는지 쉽게 설명해줘."
          : "이 문제의 정답 이유를 쉽게 정리하고, 비슷한 상황에서 기억할 요령을 알려줘.",
    });
  }

  const dataSection = (
    <section className="card-box">
      <h2>데이터</h2>
      <p className="muted small">
        기록은 이 기기 브라우저에만 저장돼요. 다른 기기로 옮기거나 백업하려면 내보낸 파일을 가져오기 하세요 (같은 기록은
        한 번만 들어가요).
      </p>
      <div className="row-gap wrap">
        <button className="ghost small" onClick={exportNow} disabled={!items.length}>
          기록 내보내기 (JSON)
        </button>
        <button className="ghost small" onClick={() => fileRef.current?.click()}>
          가져오기
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="rec-file"
          onChange={(e) => importFile(e.target.files?.[0])}
        />
      </div>
      {importMsg && <span className={importMsg.ok ? "ok-text" : "err-text"}>{importMsg.text}</span>}
      {legacy.attempts > 0 && (
        <p className="muted small">
          이번 업데이트 전에 푼 문제는 합계만 남아 있어요: {legacy.attempts}문제 · 정답률 {pctText(rate(legacy))}. 문제별 기록은
          지금부터 쌓여요.
        </p>
      )}
      {saveFailed && <p className="err-text">브라우저 저장 공간이 부족해서 일부 기록이 저장되지 않았어요. 내보내기로 백업해 두세요.</p>}
    </section>
  );

  if (!items.length) {
    return (
      <div className="page">
        <section className="card-box rec-empty">
          <h2>아직 문제별 기록이 없어요</h2>
          <p className="muted small">
            퀴즈나 핸드 플레이에서 문제를 풀면 여기에 하나씩 쌓여요. 틀린 문제를 다시 보고, 약한 스팟을 골라 연습하고, AI
            해설도 받을 수 있어요.
          </p>
          <div className="row-gap wrap">
            <button className="primary small" onClick={() => go("quiz/stack")}>
              레인지 암기 시작
            </button>
            <button className="ghost small" onClick={() => go("play")}>
              핸드 플레이
            </button>
          </div>
        </section>
        {dataSection}
      </div>
    );
  }

  const presentKinds = kinds.map((k) => k.kind);

  return (
    <div className="page">
      <section className="card-box">
        <h2>요약</h2>
        <div className="home-stats">
          <div>
            <b>{ov.attempts}</b>
            <span>총 문제</span>
          </div>
          <div>
            <b>{pctText(rate(ov))}</b>
            <span>정답률</span>
          </div>
          <div>
            <b>{ov.today}</b>
            <span>오늘 푼 문제</span>
          </div>
          <div>
            <b>
              {stats.streak}
              <small className="muted"> / {stats.bestStreak}</small>
            </b>
            <span>연속 정답 (최고)</span>
          </div>
        </div>
        <p className="muted small">부분 정답(혼합 빈도 핸드에서 가끔 쓰는 선택)도 정답으로 세요. 퀴즈 화면 정답률과 같은 기준이에요.</p>
        <div className="rec-chart" aria-label="최근 14일 푼 문제">
          {ov.days.map((d, i) => {
            const [m, day] = d.label.split("/");
            return (
              <div key={d.day} className={`rec-col ${d.today ? "today" : ""}`} title={`${d.label}: ${d.attempts}문제, 정답 ${d.correct}`}>
                <span className="rec-count">{d.attempts || ""}</span>
                <div className="rec-track">
                  {d.attempts > 0 && (
                    <div className="rec-bar" style={{ height: `${(d.attempts / maxDay) * 100}%` }}>
                      <i className="rec-ok" style={{ flexBasis: `${(d.correct / d.attempts) * 100}%` }} />
                    </div>
                  )}
                </div>
                <span className="rec-day">{d.today ? "오늘" : i === 0 || day === "1" ? `${m}/${day}` : day}</span>
              </div>
            );
          })}
        </div>
        <div className="legend small">
          <span className="legend-item">
            <i style={{ background: "var(--ok)" }} /> 정답
          </span>
          <span className="legend-item">
            <i style={{ background: "var(--err)" }} /> 오답
          </span>
          <span className="muted">최근 14일</span>
        </div>
      </section>

      <section className="card-box">
        <h2>카테고리별</h2>
        <div className="rec-kinds">
          {kinds.map((k) => (
            <div key={k.kind} className="rec-kind">
              <div className="row-between">
                <b>{k.label}</b>
                <span className="muted small">{k.attempts}문제</span>
              </div>
              <div className="rec-kind-stats small">
                <span>
                  정답률 <b>{pctText(rate(k))}</b>
                </span>
                <span>
                  최근 {Math.min(RECENT_N, k.attempts)}문제 <b>{pctText(rate(k.recent))}</b>
                  {k.trend && (
                    <span className={`rec-trend ${TREND[k.trend].cls}`} title={TREND[k.trend].title}>
                      {" "}
                      {TREND[k.trend].mark}
                    </span>
                  )}
                </span>
                {k.avgEvLoss !== null && (
                  <span>
                    평균 EV 손실 <b>{k.avgEvLoss}bb</b>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card-box">
        <h2>약점 TOP 5</h2>
        {weak.length ? (
          <ol className="rec-weak">
            {weak.map((w) => (
              <li key={w.spot}>
                <div className="rec-weak-text">
                  <b>{w.label}</b>
                  <span className="muted small">
                    {QUIZ_KIND_LABEL[w.kind]} · 정답률 {pctText(rate(w))} ({w.correct}/{w.attempts})
                  </span>
                </div>
                <button className="ghost small" onClick={() => go(w.route)}>
                  연습하기
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">같은 스팟을 3번 이상 풀면 정답률이 낮은 순서로 여기에 보여 줘요.</p>
        )}
      </section>

      <section className="card-box">
        <h2>히스토리</h2>
        <div className="chips scroll">
          <button className={`chip ${kind === "all" ? "on" : ""}`} onClick={() => { setKind("all"); setShown(PAGE); }}>
            전체
          </button>
          {presentKinds.map((k) => (
            <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => { setKind(k); setShown(PAGE); }}>
              {QUIZ_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="hint-toggle small">
          <input type="checkbox" checked={wrongOnly} onChange={(e) => { setWrongOnly(e.target.checked); setShown(PAGE); }} /> 오답만
        </label>
        {history.length ? (
          <ul className="rec-list">
            {history.slice(0, shown).map((a) => {
              const g = GRADE_CHIP[a.grade];
              const isOpen = open === a.id;
              return (
                <li key={a.id} className={`rec-row ${isOpen ? "open" : ""}`}>
                  <button className="rec-row-head" onClick={() => setOpen(isOpen ? null : a.id)} aria-expanded={isOpen}>
                    <span className="rec-row-top">
                      <span className="muted small">
                        {formatTime(a.at, now)} · {QUIZ_KIND_LABEL[a.kind]}
                      </span>
                      <span className={`grade-chip ${g.cls}`}>{g.text}</span>
                    </span>
                    <b className="rec-title">{a.title}</b>
                    <span className="small">
                      {a.chosen} → <b>{a.correct}</b>
                      {typeof a.evLossBB === "number" && a.evLossBB > 0 ? <span className="muted"> · EV −{a.evLossBB}bb</span> : null}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="rec-detail">
                      {a.detail ? <pre>{a.detail}</pre> : <span className="muted small">저장된 상세 정보가 없어요.</span>}
                      <button className="ghost small" onClick={() => askCoach(a)}>
                        AI 해설 요청
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">조건에 맞는 기록이 없어요.</p>
        )}
        {history.length > shown && (
          <button className="ghost small" onClick={() => setShown((n) => n + PAGE)}>
            더 보기 ({history.length - shown}개 남음)
          </button>
        )}
      </section>

      {dataSection}
    </div>
  );
}
