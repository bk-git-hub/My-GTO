import { useMemo, useState } from "react";
import type { Go } from "../../backNav";
import { bbPart, bbText1, checkSteps, chipSeries, chipsText, levelNear, missedOf, MINUS, sessionMoney, type Unit } from "./fastChips";
import { Bb } from "./FastResult";
import { fastStats, fastStore, sessionText } from "./fastLog";
import { CheckRow, ChipsBlock, copyText, FastItem, FastStatsRow } from "./FastParts";
import {
  defaultTitle,
  deleteTourney,
  editTourney,
  fieldsOf,
  groupChips,
  groupFor,
  groupTitle,
  groupWhen,
  infoOf,
  newFields,
  openHand,
  resumeTourney,
  runningUntagged,
  sheetLevelText,
  startNote,
  startTourney,
  tourneyGroups,
  tourneyTitle,
  type TourneyGroup,
} from "./fastTourney";
import { fastActed, handLogStore, type LoggedHand } from "./handLog";
import { cleanTourneys, type StackCheck } from "./tourney";
import { TourneySheet } from "./TourneySheet";

/**
 * 토너먼트 기록: 빠른 기록's tournaments, newest first (the one being logged on top), each opening its own
 * screen, and 이어 적기 to log into one again; under them the 빠른 기록 hands from before tournaments (이전
 * 기록), grouped by time as 빠른 기록 used to show them. Routes "log/fast/past", "log/fast/t/<id>",
 * "log/fast/s/<newest hand's time>".
 */

const FULL_MSG = "저장 공간이 꽉 차서 저장하지 못했어요. 백업한 뒤 오래된 기록을 지워 주세요.";
const NO_CHECKS: readonly StackCheck[] = [];

/** Now, or the newest hand's time if the clock is behind it (fixed for the screen: an action moves it on itself). */
function useNow(hands: LoggedHand[]): number {
  const [now] = useState(() => Date.now());
  return Math.max(now, ...hands.slice(0, 1).map((h) => h.createdAt));
}

/**
 * A group's chips in bb, as its total shows them (each hand at its own level, the stack's jumps at theirs); null
 * when a part of it has no level.
 */
function groupBb(g: TourneyGroup): number | null {
  const m = sessionMoney(g.hands);
  const missed = missedOf(g.hands, g.t?.startStack ?? null, g.t?.checks ?? []);
  if (m.bb === null || (missed && missed.bb === null)) return null;
  return Math.round((m.bb + (missed?.bb ?? 0)) * 10) / 10;
}

/** A group's chips, toned, with their bb: "+14,200 +28.4bb", "−8,500", "본전", or "결과 없음". */
export function GroupRes({ g }: { g: TourneyGroup }) {
  const n = groupChips(g.hands, g.t?.startStack ?? null, g.t?.checks ?? []);
  if (n === null) return <span className="tn-res none">결과 없음</span>;
  const b = n === 0 ? null : groupBb(g);
  return (
    <span className={`tn-res${n > 0 ? " up" : n < 0 ? " down" : ""}`}>
      {n === 0 ? "본전" : `${n > 0 ? "+" : MINUS}${chipsText(Math.abs(n))}`}
      {b !== null && b !== 0 && (
        <>
          {" "}
          <Bb v={`${b > 0 ? "+" : MINUS}${bbText1(Math.abs(b))}`} />
        </>
      )}
    </span>
  );
}

const routeOf = (g: TourneyGroup) => (g.kind === "tourney" ? `log/fast/t/${g.key}` : `log/fast/s/${g.key}`);

/** One row of the list: the whole row opens the group; a past tournament has 이어 적기 at its right. */
function GroupRow({ g, hands, go, onResume }: { g: TourneyGroup; hands: LoggedHand[]; go: Go; onResume: (id: string) => void }) {
  const title = groupTitle(g, hands);
  return (
    <div className={`tn-row${g.current ? " current" : ""}${g.kind === "legacy" ? " legacy" : ""}`}>
      <button type="button" className="tn-open" onClick={() => go(routeOf(g))}>
        <span className="tn-row-top">
          <b className="tn-name">{title}</b>
          {g.current && <span className="log-tag">적는 중</span>}
          <GroupRes g={g} />
        </span>
        <span className="muted small">
          {groupWhen(g, hands)} · {g.hands.length}핸드{g.others ? ` · 남의 핸드 ${g.others}` : ""}
        </span>
      </button>
      {g.kind === "tourney" && !g.current && (
        <button type="button" className="tn-resume" aria-label={`이어 적기: ${title}`} onClick={() => onResume(g.key)}>
          이어 적기
        </button>
      )}
    </div>
  );
}

export function TourneyList({ hands, go }: { hands: LoggedHand[]; go: Go }) {
  const log = handLogStore.use();
  const ts = useMemo(() => cleanTourneys(log.tourneys), [log.tourneys]);
  const now = useNow(hands);
  const { tourneys, legacy } = useMemo(() => tourneyGroups(ts, hands, now), [ts, hands, now]);
  const [sheet, setSheet] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function resume(id: string) {
    // Back on 빠른 기록, logging into it.
    if (resumeTourney(id)) go("log/fast", "back");
    else setMsg(FULL_MSG);
  }

  return (
    <>
      <div className="log-top">
        <button type="button" className="log-link back" onClick={() => go("log/fast", "back")}>
          ‹ 빠른 기록
        </button>
        <button type="button" className="log-new-btn" onClick={() => setSheet(true)}>
          ＋ 새 토너먼트
        </button>
      </div>
      {msg && (
        <div className="notice error" role="alert">
          {msg}
        </div>
      )}
      {!tourneys.length && !legacy.length && <p className="muted small">아직 토너먼트 기록이 없어요. 빠른 기록에서 핸드를 적으면 토너먼트가 시작돼요.</p>}
      {tourneys.length > 0 && (
        <div className="tn-list">
          {tourneys.map((g) => (
            <GroupRow key={g.key} g={g} hands={hands} go={go} onResume={resume} />
          ))}
        </div>
      )}
      {legacy.length > 0 && (
        <>
          <div className="log-day">이전 기록 · 토너먼트 없이 적은 빠른 기록</div>
          <div className="tn-list">
            {legacy.map((g) => (
              <GroupRow key={g.key} g={g} hands={hands} go={go} onResume={resume} />
            ))}
          </div>
        </>
      )}
      <button type="button" className="log-link tn-backup" onClick={() => go("log/list")}>
        백업은 지난 기록 아래 백업에서 · 토너먼트도 같이 저장돼요 ›
      </button>
      {sheet && (
        <TourneySheet
          mode="new"
          initial={newFields(Date.now())}
          defaultName={defaultTitle(Date.now())}
          levelText={(clock) => sheetLevelText(clock, null, hands, Date.now())}
          join={tourneys.some((g) => g.current) ? 0 : runningUntagged(hands, Date.now()).length}
          onSave={(f, join) => {
            if (!startTourney(f, Date.now(), join)) return FULL_MSG;
            setSheet(false);
            go("log/fast", "back");
            return null;
          }}
          onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}

/** One tournament (kind "tourney", by id) or one group of hands from before tournaments (kind "legacy", by its newest hand's time). */
export function TourneyView({ kind, id, hands, go }: { kind: "tourney" | "legacy"; id: string; hands: LoggedHand[]; go: Go }) {
  const log = handLogStore.use();
  const ts = useMemo(() => cleanTourneys(log.tourneys), [log.tourneys]);
  const now = useNow(hands);
  const g = useMemo(() => groupFor(kind, id, ts, hands, now), [kind, id, ts, hands, now]);
  const fast = fastStore.use();
  const view: Unit = fast.view === "bb" ? "bb" : "chips";
  const [sheet, setSheet] = useState(false);
  const [limit, setLimit] = useState(100);
  const [copied, setCopied] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const back = () => go("log/fast/past", "back");

  if (!g) {
    return (
      <>
        <div className="log-top">
          <button type="button" className="log-link back" onClick={back}>
            ‹ 토너먼트 기록
          </button>
        </div>
        <section className="card-box">
          <p>{kind === "tourney" ? "이 토너먼트를 찾을 수 없어요. 지웠거나 다른 기기에서 만든 기록이에요." : "이 기록을 찾을 수 없어요. 지웠거나 다른 기기에서 만든 기록이에요."}</p>
          <button type="button" className="ghost" onClick={back}>
            목록으로
          </button>
        </section>
      </>
    );
  }

  const t = g.t;
  const title = groupTitle(g, hands);
  const total = g.hands.length + g.others;
  const checks = t?.checks ?? NO_CHECKS;
  // Its stack at the end, as the graph ends (a 칩 업데이트 with no hand: that stack).
  const run = t ? chipSeries(g.hands, "chips", t.startStack, checks) : null;
  const end = run?.absolute ? Math.round(run.end) : checks.length ? checks[checks.length - 1].stack : null;
  const meta =
    `${groupWhen(g, hands)} · ${g.hands.length}핸드` +
    (t && t.startStack !== null ? ` · 시작 ${chipsText(t.startStack)}${end !== null ? " " : ""}` : end !== null ? " · " : "");
  // The stack at the end, with its bb at the level of the last hand, kept together with the word before it ("→ 61,700 102.8bb", "끝 …").
  const endLead = t && t.startStack !== null ? "→ " : "끝 ";
  const endBb = end !== null ? bbPart(end, levelNear(g.hands, Infinity)) : null;
  // Its 칩 업데이트 among the hands shown, by time.
  const shown = g.hands.slice(0, limit);
  const oldest = g.hands.length > limit ? shown[shown.length - 1].createdAt : -Infinity;
  const rows = [
    ...shown.map((h) => ({ t: h.createdAt, k: 0 as const, h })),
    ...(t ? checkSteps(g.hands, t.startStack, checks) : []).filter((c) => c.at >= oldest).map((c) => ({ t: c.at, k: 1 as const, c })),
  ].sort((a, b) => b.t - a.t || b.k - a.k);
  const memo = t?.memo.trim() ?? "";
  const setView = (u: Unit) => {
    const raw = fastStore.get();
    if (u === "bb") fastStore.set({ ...raw, view: "bb" });
    else {
      const { view: _v, ...rest } = raw;
      void _v;
      fastStore.set(rest);
    }
  };
  function resume() {
    if (!t) return;
    if (resumeTourney(t.id)) go("log/fast", "back");
    else setMsg(FULL_MSG);
  }
  function remove() {
    if (!t || !confirm("이 토너먼트를 지울까요?")) return;
    if (deleteTourney(t.id)) back();
    else setMsg(FULL_MSG);
  }

  return (
    <>
      <div className="log-top">
        <button type="button" className="log-link back" onClick={back}>
          ‹ 토너먼트 기록
        </button>
        {t &&
          (g.current ? (
            <span className="log-tag">적는 중</span>
          ) : (
            <button type="button" className="tn-resume" onClick={resume}>
              이어 적기
            </button>
          ))}
      </div>
      {msg && (
        <div className="notice error" role="alert">
          {msg}
        </div>
      )}
      <section className="card-box fast-today tn-view">
        <div className="fast-today-head tn-head">
          {t ? (
            <h2>
              <button type="button" className="tn-title" aria-label={`토너먼트 정보 고치기: ${title}`} onClick={() => setSheet(true)}>
                <span>{title}</span>
                <i>✎</i>
              </button>
            </h2>
          ) : (
            <h2>{title}</h2>
          )}
        </div>
        <p className="tn-meta">
          {meta}
          {end !== null && (
            <span className="tn-end">
              {endLead}
              {chipsText(end)}
              {endBb && (
                <>
                  {" "}
                  <Bb v={endBb} />
                </>
              )}
            </span>
          )}
          {g.others ? ` · 남의 핸드 ${g.others}` : ""}
        </p>
        {memo && <p className="tn-memo">메모: {memo}</p>}
        {g.hands.length ? (
          <>
            <ChipsBlock hands={g.hands} view={view} onView={setView} startStack={t?.startStack ?? null} checks={checks} title="칩 흐름" />
            <FastStatsRow stats={fastStats(g.hands.filter(fastActed))} other={false} />
            <div className="fast-list">
              {rows.map((r) =>
                r.k === 1 ? (
                  <CheckRow key={`c${r.c.at}`} c={r.c} level={levelNear(g.hands, r.c.at)} />
                ) : (
                  <FastItem key={r.h.id} h={r.h} view={view} other={false} editing={false} onClick={() => openHand(r.h, go)} />
                ),
              )}
            </div>
            {g.hands.length > limit && (
              <button type="button" className="ghost" onClick={() => setLimit(limit + 100)}>
                더 보기 ({g.hands.length - limit}개 남음)
              </button>
            )}
            <p className="muted small">핸드를 누르면 빠른 기록에서 고치거나 지울 수 있어요</p>
            <div className="fast-today-foot">
              <button
                type="button"
                className="ghost small"
                onClick={async () => setCopied((await copyText(sessionText(g.hands, "mine", t ? infoOf(t, hands) : undefined))) ? "복사했어요 · 카톡이나 Claude에 붙여 넣으세요" : "복사하지 못했어요")}
              >
                요약 복사
              </button>
            </div>
            {copied && <p className="fast-hint ok">{copied}</p>}
          </>
        ) : (
          <p className="muted small">{g.others ? "이 토너먼트에는 남의 핸드만 있어요 (지난 기록 › 남의 핸드)." : "아직 이 토너먼트에 핸드가 없어요."}</p>
        )}
        {t && total === 0 && (
          <button type="button" className="ghost small danger tn-delete" onClick={remove}>
            이 토너먼트 삭제
          </button>
        )}
      </section>
      {sheet && t && (
        <TourneySheet
          mode="edit"
          initial={fieldsOf(t)}
          defaultName={tourneyTitle({ ...t, name: "" }, hands)}
          levelText={(clock) => sheetLevelText(clock, t, hands, Date.now())}
          note={startNote(t, hands, g.current, Date.now())}
          canDelete={total === 0}
          current={g.current}
          onSave={(f) => {
            if (!editTourney(t.id, f)) return FULL_MSG;
            setSheet(false);
            return null;
          }}
          onDelete={() => {
            setSheet(false);
            if (deleteTourney(t.id)) back();
            else setMsg(FULL_MSG);
          }}
          onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}
