import { useEffect, useMemo, useRef, useState } from "react";
import { CardRow } from "../../components/Cards";
import { ALL_HANDS, type HandClass } from "../../poker/cards";
import {
  aggregateByHandClass,
  nodeActionTotals,
  pathKey,
  rangesAfter,
  turnStart,
  type DecodedFlop,
  type DecodedNode,
  type PackAction,
  type PackEntry,
} from "../../presolve/format";
import type { Player } from "../../solver/types";
import { ComboDetail } from "./ComboDetail";
import type { Integrity, LoadedFlop } from "./packs";
import { MixBar } from "./parts";
import { SolverGrid, type GridCell } from "./SolverGrid";
import {
  actionColors,
  boardTexture,
  effectiveStack,
  fmtBb,
  lineSteps,
  mixGradient,
  nextHint,
  pct,
  playerName,
  rangeByClass,
  rangeSize,
  resolvePath,
  textureTags,
  toCall,
  unblockedCounts,
  weightScope,
} from "./view";

export type GridMode = "strategy" | "range";

function useIntegrity(p: Promise<Integrity>): Integrity | "pending" {
  const [state, setState] = useState<{ p: Promise<Integrity>; v: Integrity | "pending" }>({ p, v: "pending" });
  useEffect(() => {
    let live = true;
    p.then((v) => live && setState({ p, v }));
    return () => {
      live = false;
    };
  }, [p]);
  return state.p === p ? state.v : "pending";
}


export function FlopView({
  pack,
  loaded,
  path,
  selected,
  onSelect,
  onPath,
  onReport,
  gridMode,
  onGridMode,
}: {
  pack: PackEntry;
  loaded: LoadedFlop;
  path: number[];
  selected: HandClass | null;
  onSelect: (h: HandClass | null) => void;
  onPath: (path: number[]) => void;
  onReport: () => void;
  gridMode: GridMode;
  onGridMode: (m: GridMode) => void;
}) {
  const { flop, entry } = loaded;
  const meta = pack.scenario;
  const integrity = useIntegrity(loaded.integrity);
  // Memo on the path's key: `path` is a new array on every render.
  const key = pathKey(path);
  const target = useMemo(() => resolvePath(flop, key ? key.split(".").map(Number) : []), [flop, key]);
  const steps = lineSteps(flop, path, meta);
  const tags = textureTags(boardTexture(flop.board));
  const packWeight = pack.files.reduce((s, f) => s + f.weight, 0);

  return (
    <div className="page sv">
      <div className="sv-top">
        <button className="ghost small" onClick={onReport}>
          ← 리포트
        </button>
        <span className="sv-top-title">{pack.title}</span>
      </div>

      <section className="card-box sv-board">
        <CardRow cards={flop.board} size="md" />
        <div className="sv-board-meta">
          <div className="sv-tags">
            {tags.map((t) => (
              <span key={t} className="sv-tag">
                {t}
              </span>
            ))}
          </div>
          <span className="muted small sv-board-facts">
            <span title={`비중: 이 보드로 대신 보는 실제 플랍 ${entry.weight}개 / ${packWeight}개 (${weightScope(pack)})`}>
              비중 {packWeight > 0 ? pct(entry.weight / packWeight, 1) : "–"}
            </span>
            <span>익스플로잇 {fmtBb(flop.exploitability, 2)}%</span>
            {integrity === "ok" && (
              <span className="ok-text" title="sha256이 팩 목록과 일치해요">
                ✓ 검증됨
              </span>
            )}
          </span>
        </div>
      </section>
      {integrity === "mismatch" && <div className="notice error small">파일 해시가 목록과 달라요. 표시는 하지만 내용이 바뀌었을 수 있어요.</div>}

      <nav className="sv-crumbs" aria-label="액션 라인">
        <button className={path.length === 0 ? "on" : ""} onClick={() => onPath([])}>
          플랍
        </button>
        {steps.map((s, i) => (
          <button key={i} className={i === steps.length - 1 ? "on" : ""} onClick={() => onPath(path.slice(0, i + 1))}>
            <b>{s.who}</b> {s.action.label}
          </button>
        ))}
      </nav>

      {target.kind === "node" ? (
        <NodeView
          pack={pack}
          flop={flop}
          node={target.node}
          selected={selected}
          onSelect={onSelect}
          onAction={(i) => onPath([...path, i])}
          gridMode={gridMode}
          onGridMode={onGridMode}
        />
      ) : target.kind === "end" ? (
        <EndView pack={pack} flop={flop} path={path} parent={target.parent} action={target.action} />
      ) : (
        <div className="notice error">
          이 라인은 이 파일에 없어요.
          <button className="ghost small" onClick={() => onPath([])}>
            처음으로
          </button>
        </div>
      )}
    </div>
  );
}

function NodeView({
  pack,
  flop,
  node,
  selected,
  onSelect,
  onAction,
  gridMode,
  onGridMode,
}: {
  pack: PackEntry;
  flop: DecodedFlop;
  node: DecodedNode;
  selected: HandClass | null;
  onSelect: (h: HandClass | null) => void;
  onAction: (i: number) => void;
  gridMode: GridMode;
  onGridMode: (m: GridMode) => void;
}) {
  const meta = pack.scenario;
  const who = playerName(meta, node.player);
  const labels = node.actions.map((a) => a.label);
  const colors = useMemo(() => actionColors(node.actions, node), [node]);
  const totals = useMemo(() => nodeActionTotals(node), [node]);
  const agg = useMemo(() => aggregateByHandClass(node), [node]);
  const unblocked = useMemo(() => unblockedCounts(flop.board), [flop]);
  const combos = useMemo(() => {
    let w = 0;
    for (const x of node.weight) w += x;
    return w;
  }, [node]);

  const cells = useMemo(() => {
    const out = {} as Record<HandClass, GridCell>;
    for (const h of ALL_HANDS) {
      const g = agg[h];
      const empty = g.combos === 0 || !(g.weight > 0);
      out[h] = {
        fill: empty ? null : mixGradient(g.freq, colors),
        height: gridMode === "range" ? (unblocked[h] ? g.weight / unblocked[h] : 0) : 1,
        empty,
        title: empty ? `${h}: 없음` : `${h}: ${labels.map((l, a) => `${l} ${pct(g.freq[a])}`).join(" / ")}`,
      };
    }
    return out;
  }, [agg, colors, labels, gridMode, unblocked]);

  const call = toCall(node);
  const stack = effectiveStack(node);

  // After a tap on the grid, bring the top of the detail panel into view if it is below the screen.
  const detailRef = useRef<HTMLDivElement>(null);
  const tapped = useRef(false);
  useEffect(() => {
    const el = detailRef.current;
    if (!tapped.current || !el || !selected) return;
    tapped.current = false;
    const top = el.getBoundingClientRect().top;
    const reveal = Math.min(320, window.innerHeight * 0.45);
    if (top > window.innerHeight - reveal) window.scrollBy({ top: top - (window.innerHeight - reveal), behavior: "smooth" });
  }, [selected]);

  return (
    <>
      <section className="card-box sv-node">
        <div className="sv-actor">
          <b>{who}</b> 차례
          {call > 0 && <span className="muted small"> · {fmtBb(call)}bb 콜해야 함</span>}
        </div>
        <div className="sv-stats">
          <div>
            <span>팟</span>
            <b>{fmtBb(node.pot)}</b>
          </div>
          <div>
            <span>유효 스택</span>
            <b>{fmtBb(stack)}</b>
          </div>
          <div>
            <span>SPR</span>
            <b>{node.pot > 0 ? fmtBb(stack / node.pot) : "–"}</b>
          </div>
        </div>
        <MixBar freq={totals} colors={colors} labels={labels} />
        <div className="sv-acts">
          {node.actions.map((a, i) => (
            <button key={i} className="sv-act" style={{ ["--c" as string]: colors[i] }} onClick={() => onAction(i)}>
              <i />
              <span className="sv-act-l">{a.label}</span>
              <b>{pct(totals[i], 1)}</b>
              <small>{nextHint(a, flop.node([...node.path, i]) !== undefined, meta, node.player)}</small>
            </button>
          ))}
        </div>
        <p className="muted small">
          {who} 레인지 {fmtBb(combos, 0)}콤보 기준 빈도 · 버튼을 누르면 그 다음으로 가요.
        </p>
      </section>

      <div className="row-between">
        <div className="seg small sv-mode">
          <button className={gridMode === "strategy" ? "on" : ""} onClick={() => onGridMode("strategy")}>
            전략
          </button>
          <button className={gridMode === "range" ? "on" : ""} onClick={() => onGridMode("range")}>
            레인지 비중
          </button>
        </div>
      </div>

      <SolverGrid
        cells={cells}
        selected={selected}
        onPick={(h) => {
          tapped.current = true;
          onSelect(selected === h ? null : h);
        }}
      />

      {selected ? (
        <div ref={detailRef}>
          <ComboDetail
            node={node}
            hand={selected}
            agg={agg[selected]}
            colors={colors}
            who={who}
            unblocked={unblocked[selected]}
            onClose={() => onSelect(null)}
          />
        </div>
      ) : (
        <p className="muted center small">칸을 누르면 콤보별 빈도와 EV를 볼 수 있어요.</p>
      )}
    </>
  );
}

const RANGE_COLOR = "#fbbf24";

function EndView({ pack, flop, path, parent, action }: { pack: PackEntry; flop: DecodedFlop; path: number[]; parent: DecodedNode; action: PackAction }) {
  const meta = pack.scenario;
  const actor = parent.player;
  const other = (1 - actor) as Player;
  const who = playerName(meta, actor);
  const otherName = playerName(meta, other);
  const [show, setShow] = useState<Player>(other);
  const key = pathKey(path);
  const ts = useMemo(() => {
    if (action.next !== "street" && action.next !== "allin-runout") return null;
    try {
      return turnStart(flop, path);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `path`
  }, [flop, key, action]);
  const ranges = useMemo(() => {
    try {
      return rangesAfter(flop, path);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `path`
  }, [flop, key]);

  const cells = useMemo(() => {
    if (!ranges) return null;
    const byClass = rangeByClass(ranges[show], flop.board);
    const out = {} as Record<HandClass, GridCell>;
    for (const h of ALL_HANDS) {
      const c = byClass[h];
      const empty = !(c.weight > 0.0005);
      out[h] = { fill: RANGE_COLOR, height: c.frac, empty, title: `${h}: ${pct(c.frac)}` };
    }
    return out;
  }, [ranges, show, flop]);

  let title: string;
  let body: string;
  switch (action.next) {
    case "fold": {
      // No particle right after a position name: BTN (비티엔) would need 이/은, BB (비비) 가/는.
      const lost = meta.stack - parent.stacks[actor];
      title = `${who} 폴드 · 핸드 종료`;
      body =
        `${otherName} 승리 · 팟 ${fmtBb(parent.pot)}bb. ` +
        (lost > 0.0005 ? `${who} 쪽은 플랍에서 넣은 ${fmtBb(lost)}bb를 잃어요.` : `${who} 쪽은 플랍에서 추가로 잃은 칩이 없어요.`);
      break;
    }
    case "street":
      title = "플랍 종료 → 턴";
      body = "이 라인에서 두 사람의 레인지(아래)와 팟으로 턴을 기기에서 직접 풀 수 있게 준비하고 있어요.";
      break;
    case "allin-runout":
      title = "올인 콜 → 런아웃";
      body = "남은 카드가 모두 깔리고 더 이상 결정은 없어요.";
      break;
    case "showdown":
      title = "쇼다운";
      body = "카드를 공개하고 승부를 가려요.";
      break;
    default:
      title = `${who} ${action.label} 다음`;
      body = "이 다음 노드는 팩에 저장되지 않았어요. 파일 용량 때문에 깊은 레이즈 라인은 일부만 저장돼요.";
  }

  return (
    <>
      <section className={`card-box sv-end ${action.next}`}>
        <h3>{title}</h3>
        <p className="small">{body}</p>
        {ts && (
          <div className="sv-stats">
            <div>
              <span>{action.next === "street" ? "턴 팟" : "최종 팟"}</span>
              <b>{fmtBb(ts.pot)}</b>
            </div>
            <div>
              <span>유효 스택</span>
              <b>{fmtBb(ts.stack)}</b>
            </div>
            <div>
              <span>SPR</span>
              <b>{ts.pot > 0 ? fmtBb(ts.stack / ts.pot) : "–"}</b>
            </div>
          </div>
        )}
        {action.next === "street" && <div className="sv-soon">턴은 실시간 계산 예정</div>}
      </section>

      {ranges && cells && (
        <>
          <div className="row-between">
            <div className="seg small sv-mode">
              {([0, 1] as Player[]).map((p) => (
                <button key={p} className={show === p ? "on" : ""} onClick={() => setShow(p)}>
                  {playerName(meta, p)} 레인지
                </button>
              ))}
            </div>
            <span className="muted small">{fmtBb(rangeSize(ranges[show]), 0)}콤보</span>
          </div>
          <SolverGrid cells={cells} />
          <p className="muted center small">칸이 찬 높이 = 이 라인에 도달하는 콤보 비율</p>
        </>
      )}
    </>
  );
}
