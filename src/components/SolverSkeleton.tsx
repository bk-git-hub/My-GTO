import type { SolverStatus } from "../data/useSolver";

/** Holds about a chart's height, so the page does not jump when the chart comes in. */
const BOX = { minHeight: 320 } as const;

/**
 * What a solver screen shows while its stage chunks load (docs §6.3): from the precache about one frame, so it stays
 * quiet; a failed load (offline before the app cached the chunks) says so and offers a retry, which reloads the page
 * (useSolver's reloadForSolver: a failed chunk is never fetched again in the same document).
 */
export function SolverSkeleton({ status, retry }: { status: SolverStatus; retry: () => void }) {
  if (status === "error")
    return (
      <section className="card-box solver-skeleton" role="alert" style={BOX}>
        <p>솔버 차트를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.</p>
        <button className="ghost small" onClick={retry}>
          다시 시도
        </button>
      </section>
    );
  return (
    <section className="card-box solver-skeleton" aria-busy="true" style={BOX}>
      <p className="muted">솔버 차트 불러오는 중…</p>
    </section>
  );
}
