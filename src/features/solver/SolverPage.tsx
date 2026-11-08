import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { pushRoute, type Go, type GoHow } from "../../backNav";
import type { HandClass } from "../../poker/cards";
import type { FileEntry } from "../../presolve/format";
import { FlopView, type GridMode } from "./FlopView";
import { packClient, type LoadedFlop, type ManifestState, type PackClient } from "./packs";
import { DEFAULT_REPORT, ReportView, type ReportState } from "./ReportView";
import { ScenarioPicker } from "./ScenarioPicker";
import { parseRoute, routeOf } from "./view";

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "done"; value: T };

function useManifest(client: PackClient, attempt: number): Load<ManifestState> {
  const [state, setState] = useState<Load<ManifestState>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    client.manifest().then(
      (value) => live && setState({ status: "done", value }),
      (e: Error) => live && setState({ status: "error", message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [client, attempt]);
  return state;
}

function useFlop(client: PackClient, entry: FileEntry | undefined, attempt: number): Load<LoadedFlop> | null {
  const [state, setState] = useState<{ path: string; load: Load<LoadedFlop> } | null>(null);
  useEffect(() => {
    if (!entry) return;
    let live = true;
    setState({ path: entry.path, load: { status: "loading" } });
    client.flop(entry).then(
      (value) => live && setState({ path: entry.path, load: { status: "done", value } }),
      (e: Error) => live && setState({ path: entry.path, load: { status: "error", message: e.message } }),
    );
    return () => {
      live = false;
    };
  }, [client, entry, attempt]);
  if (!entry) return null;
  return state && state.path === entry.path ? state.load : { status: "loading" };
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page sv">
      <section className="card-box sv-msg">
        <h3>{title}</h3>
        {children}
      </section>
    </div>
  );
}

/** `next` is a line above `path` (a crumb, 처음으로): back up the tree, not a new step down it. */
function isAbove(next: number[], path: number[]): boolean {
  return next.length < path.length && next.every((x, i) => x === path[i]);
}

/**
 * "솔버 차트": precomputed flop strategies (docs/solver-packs.md). Routes under #solver:
 * solver → scenario list, solver/<pack> → flop report, solver/<pack>/<board>[/<path>] → a flop node.
 * The links back up ("← 시나리오", "← 리포트", a crumb) go back to the screen (GoHow "back"), so the header's
 * ‹ doesn't lead down again into the screen just left.
 */
export function SolverPage({ sub = "", go, client: given }: { sub?: string; go?: Go; client?: PackClient }) {
  const client = useMemo(() => given ?? packClient(), [given]);
  const navigate = useCallback(
    (route: string, how?: GoHow) => {
      if (go) go(route, how);
      else pushRoute(route);
    },
    [go],
  );
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    client.reset();
    setAttempt((n) => n + 1);
  };
  const manifest = useManifest(client, attempt);
  const route = parseRoute(sub);
  const [report, setReport] = useState<ReportState>(DEFAULT_REPORT);
  const [selected, setSelected] = useState<HandClass | null>(null);
  const [gridMode, setGridMode] = useState<GridMode>("strategy");

  const ready = manifest.status === "done" && manifest.value.status === "ready" ? manifest.value.manifest : null;
  const pack = ready?.packs.find((p) => p.id === route.packId);
  const entry = pack?.files.find((f) => f.board === route.board);
  const flop = useFlop(client, entry, attempt);

  if (manifest.status === "loading") return <Message title="팩 목록 불러오는 중…" />;
  if (manifest.status === "error")
    return (
      <Message title="팩 목록을 불러오지 못했어요">
        <p className="muted small">{manifest.message}</p>
        <button className="primary small" onClick={retry}>
          다시 시도
        </button>
      </Message>
    );
  if (!ready)
    return (
      <Message title="아직 계산된 팩이 없음">
        <p className="muted small">
          미리 계산한 플랍 전략(솔버 팩)이 아직 올라오지 않았어요. 매일 밤 계산 작업이 새 플랍을 추가하면 여기에서 볼 수 있어요.
        </p>
        <button className="ghost small" onClick={retry}>
          다시 확인
        </button>
      </Message>
    );

  if (!pack) {
    return (
      <>
        {route.packId && <p className="notice small sv-gone">이 시나리오는 지금 팩 목록에 없어요.</p>}
        <ScenarioPicker packs={ready.packs} onPick={(id) => navigate(routeOf(id))} />
      </>
    );
  }

  const toReport = () => navigate(routeOf(pack.id), "back");
  if (!route.board) {
    return <ReportView pack={pack} state={report} onState={setReport} onOpen={(b) => navigate(routeOf(pack.id, b))} onBack={() => navigate(routeOf(), "back")} />;
  }
  if (!entry || route.badPath) {
    return (
      <Message title={entry ? "잘못된 라인 주소예요" : "이 보드는 팩에 없어요"}>
        <button className="ghost small" onClick={entry ? () => navigate(routeOf(pack.id, entry.board), "back") : toReport}>
          {entry ? "플랍 처음으로" : "← 리포트"}
        </button>
      </Message>
    );
  }
  if (!flop || flop.status === "loading") return <Message title="플랍 불러오는 중…" />;
  if (flop.status === "error")
    return (
      <Message title="플랍을 불러오지 못했어요">
        <p className="muted small">{flop.message}</p>
        <div className="row-gap">
          <button className="primary small" onClick={retry}>
            다시 시도
          </button>
          <button className="ghost small" onClick={toReport}>
            ← 리포트
          </button>
        </div>
      </Message>
    );

  return (
    <FlopView
      pack={pack}
      loaded={flop.value}
      path={route.path}
      selected={selected}
      onSelect={setSelected}
      onPath={(p) => navigate(routeOf(pack.id, entry.board, p), isAbove(p, route.path) ? "back" : "push")}
      onReport={toReport}
      gridMode={gridMode}
      onGridMode={setGridMode}
    />
  );
}
