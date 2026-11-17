import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { loadSolver, solverLoaded, subscribeSolver } from "./charts";

export type SolverStatus = "ready" | "loading" | "error";

/**
 * Loads the solver set's stage chunks when `needed` (docs §6.3) and reports whether getSet("solver") can be read:
 * "ready" (always when not needed), "loading", or "error" when a chunk failed to load (offline before the app cached
 * it); `retry` starts the load again. The charts page and the preflop quiz pass whether the picked set is the solver
 * set, the calculator always needs it (its villain ranges list every set). Nothing is fetched when not needed.
 */
export function useSolver(needed = true): { status: SolverStatus; retry: () => void } {
  const loaded = useSyncExternalStore(subscribeSolver, solverLoaded, solverLoaded);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needed || loaded) return;
    let live = true;
    loadSolver().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [needed, loaded, attempt]);
  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);
  return { status: !needed || loaded ? "ready" : failed ? "error" : "loading", retry };
}
