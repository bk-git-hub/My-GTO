import { useMemo } from "react";
import type { PackEntry, SummaryNodeDef } from "../../presolve/format";
import { Legend, MiniCards, MixBar } from "./parts";
import {
  TEXTURE_CHIPS,
  actionColors,
  averageNodeFreq,
  cardsText,
  filterRows,
  formatName,
  fmtBb,
  nextSort,
  pct,
  playerName,
  reportColumns,
  reportRows,
  sortRows,
  startStack,
  textureTags,
  toggleChip,
  weightScope,
  weightedAverage,
  type ChipGroup,
  type ReportColumn,
  type ReportRow,
  type SortKey,
  type SortState,
} from "./view";

export interface ReportState {
  chips: string[];
  sort: SortState;
  /** Which of `reportColumns(pack).oop` the OOP column shows. */
  oopCol: number;
}

export const DEFAULT_REPORT: ReportState = { chips: [], sort: { key: "board", desc: true }, oopCol: 0 };

/** Filter rows: chip groups shown together on one line. */
const GROUPS: { groups: ChipGroup[]; label: string }[] = [
  { groups: ["suit"], label: "무늬" },
  { groups: ["pair", "conn"], label: "모양" },
  { groups: ["high"], label: "하이카드" },
];

const colorsOf = (def: SummaryNodeDef | undefined) => (def ? actionColors(def.labels.map((label, a) => ({ label, kind: def.kinds[a] }))) : []);

/** One mix column of the table: an OOP or IP decision with its number. */
interface MixColumn {
  key: "oop" | "ip";
  def: SummaryNodeDef | undefined;
  colors: string[];
  label: string;
  sub: string;
  freq: (r: ReportRow) => number[] | null;
  stat: (r: ReportRow) => number;
  avgFreq: number[] | null;
  avgStat: number;
}

/** Aggregate report of a pack from the manifest summaries only (no flop files downloaded). */
export function ReportView({
  pack,
  state,
  onState,
  onOpen,
  onBack,
}: {
  pack: PackEntry;
  state: ReportState;
  onState: (s: ReportState) => void;
  onOpen: (board: string) => void;
  onBack: () => void;
}) {
  const meta = pack.scenario;
  const defs = pack.summaryNodes;
  const cols = useMemo(() => reportColumns(pack), [pack]);
  const oopChoice = state.oopCol >= 0 && state.oopCol < cols.oop.length ? state.oopCol : 0;
  const oopCol = cols.oop[oopChoice] ?? null;
  const all = useMemo(() => reportRows(pack, oopChoice), [pack, oopChoice]);
  const totalWeight = all.reduce((s, r) => s + r.entry.weight, 0);
  const rows = useMemo(() => sortRows(filterRows(all, state.chips), state.sort), [all, state.chips, state.sort]);
  const avg = useMemo(() => weightedAverage(rows), [rows]);
  const oopName = playerName(meta, 0);
  const ipName = playerName(meta, 1);
  const start = startStack(pack.id);
  const filtered = state.chips.length > 0;

  // Average card: every decision the table can show, in tree order (OOP's first action, IP after the check, OOP vs each bet).
  const avgLines = [...cols.oop.filter((c) => !c.vs), ...(cols.ip ? [cols.ip] : []), ...cols.oop.filter((c) => c.vs)].map((c) => ({
    c,
    def: defs[c.node],
    colors: colorsOf(defs[c.node]),
    freq: averageNodeFreq(rows, c.node),
    title:
      c.vs !== undefined ? (
        <>
          <b>{oopName}</b> vs {ipName} {c.vs}
        </>
      ) : c.player === 0 ? (
        <>
          <b>{oopName}</b> 첫 액션
        </>
      ) : (
        <>
          <b>{ipName}</b> ({oopName} 체크 후)
        </>
      ),
  }));

  const mix = (key: "oop" | "ip", col: ReportColumn | null): MixColumn => {
    const def = col ? defs[col.node] : undefined;
    const name = key === "oop" ? oopName : ipName;
    return {
      key,
      def,
      colors: colorsOf(def),
      label: `${name} ${col?.metric === "fold" ? "폴드" : "벳"}`,
      sub: col?.context ?? "",
      freq: (r) => (key === "oop" ? r.oop : r.ip),
      stat: (r) => (key === "oop" ? r.oopStat : r.ipStat),
      avgFreq: key === "oop" ? avg.oop : avg.ip,
      avgStat: key === "oop" ? avg.oopStat : avg.ipStat,
    };
  };
  // Columns in tree order: OOP's first action comes before IP's bet, OOP's answer to the bet after it.
  const oopMix = mix("oop", oopCol);
  const ipMix = mix("ip", cols.ip);
  const mixCols = oopCol && oopCol.vs === undefined ? [oopMix, ipMix] : [ipMix, oopMix];

  const header = (key: SortKey, label: string, sub?: string) => {
    const on = state.sort.key === key;
    return (
      <div key={key} className="sv-thc" role="columnheader" aria-sort={on ? (state.sort.desc ? "descending" : "ascending") : undefined}>
        <button className={`sv-th ${on ? "on" : ""}`} onClick={() => onState({ ...state, sort: nextSort(state.sort, key) })}>
          <span>
            {label}
            {on && <em aria-hidden="true">{state.sort.desc ? "▼" : "▲"}</em>}
          </span>
          {sub && <small>{sub}</small>}
        </button>
      </div>
    );
  };

  return (
    <div className="page sv">
      <div className="sv-top">
        <button className="ghost small" onClick={onBack}>
          ← 시나리오
        </button>
        <span className="sv-top-title">플랍 리포트</span>
      </div>

      <section className="card-box">
        <div className="row-between">
          <h2>{pack.title}</h2>
          <span className={`sv-tier ${pack.tier}`}>{pack.tier === "pro" ? "Pro" : "무료"}</span>
        </div>
        <div className="sv-tags">
          <span className="sv-tag">{formatName(meta)}</span>
          {start !== null && <span className="sv-tag">{start}bb</span>}
          <span className="sv-tag">
            {oopName} vs {ipName}
          </span>
          <span className="sv-tag">
            팟 {fmtBb(meta.pot)} · 스택 {fmtBb(meta.stack)}
          </span>
        </div>
        {meta.preflop && <p className="muted small">{meta.preflop}</p>}
      </section>

      <section className="card-box sv-filter">
        {GROUPS.map(({ groups, label }) => (
          <div key={label} className="sv-chiprow">
            <span>{label}</span>
            <div className="chips">
              {TEXTURE_CHIPS.filter((c) => groups.includes(c.group)).map((c) => {
                const on = state.chips.includes(c.id);
                return (
                  <button key={c.id} className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onState({ ...state, chips: toggleChip(state.chips, c.id) })}>
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {filtered && (
          <button className="ghost small sv-clear" onClick={() => onState({ ...state, chips: [] })}>
            필터 지우기
          </button>
        )}
      </section>

      <section className="card-box sv-avg">
        <div className="row-between">
          <h3>{filtered ? "필터 평균" : "전체 평균"}</h3>
          <span className="muted small">
            플랍 {avg.count}개{totalWeight > 0 ? ` · 비중 ${pct(avg.weight / totalWeight)}` : ""}
          </span>
        </div>
        {avgLines.map((l) => (
          <div key={l.c.node} className="sv-avg-line">
            <span>{l.title}</span>
            <MixBar freq={l.freq} colors={l.colors} labels={l.def.labels} />
            <Legend labels={l.def.labels} colors={l.colors} freq={l.freq ?? undefined} />
          </div>
        ))}
      </section>

      {cols.oop.length > 1 && (
        <div className="sv-chiprow sv-colpick" role="group" aria-label={`표의 ${oopName} 열`}>
          <span>{oopName} 열</span>
          <div className="chips">
            {cols.oop.map((c, i) => (
              <button key={c.node} className={`chip ${i === oopChoice ? "on" : ""}`} aria-pressed={i === oopChoice} onClick={() => onState({ ...state, oopCol: i })}>
                {c.context}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sv-table" role="table" aria-label="플랍별 요약">
        <div className="sv-tr head" role="row">
          {header("board", "보드")}
          {header("weight", "비중")}
          {mixCols.map((m) => header(m.key, m.label, m.sub))}
          {header("equity", "에퀴티", oopName)}
        </div>
        <div className="sv-tr avg" role="row">
          <span className="sv-td-board" role="rowheader">
            {filtered ? "필터 평균" : "전체 평균"}
          </span>
          <span className="sv-num" role="cell">
            {totalWeight > 0 ? pct(avg.weight / totalWeight) : "–"}
          </span>
          {mixCols.map((m) => (
            <span key={m.key} className="sv-td-mix" role="cell">
              <MixBar freq={m.avgFreq} colors={m.colors} labels={m.def?.labels} thin />
              <b>{pct(m.avgStat)}</b>
            </span>
          ))}
          <span className="sv-num" role="cell">
            {pct(avg.equity)}
          </span>
        </div>
        {rows.map((r) => (
          <div key={r.entry.path} className="sv-tr" role="row">
            <span className="sv-td-board" role="rowheader">
              {/* The button covers the whole row (styles.css), so a tap anywhere on it opens the flop. */}
              <button className="sv-open" onClick={() => onOpen(r.entry.board)} aria-label={`${cardsText(r.board)} 열기`} title={textureTags(r.texture).join(" · ")}>
                <MiniCards cards={r.board} />
              </button>
            </span>
            <span className="sv-num" role="cell">
              {totalWeight > 0 ? pct(r.entry.weight / totalWeight, 1) : r.entry.weight}
            </span>
            {mixCols.map((m) => (
              <span key={m.key} className="sv-td-mix" role="cell">
                <MixBar freq={m.freq(r)} colors={m.colors} labels={m.def?.labels} thin />
                <b>{pct(m.stat(r))}</b>
              </span>
            ))}
            <span className="sv-num" role="cell">
              {pct(r.equity)}
            </span>
          </div>
        ))}
      </div>
      {rows.length === 0 && <p className="muted center small sv-none">조건에 맞는 플랍이 없어요.</p>}

      <p className="muted small disclaimer">
        비중 = 이 보드로 대신 보는 실제 플랍의 비율 ({weightScope(pack)}). 보드 무늬는 대표 무늬로 보여요. 평균은 비중으로 가중했어요. 플랍을 누르면 핸드별 전략을 볼 수
        있어요.
      </p>
    </div>
  );
}
