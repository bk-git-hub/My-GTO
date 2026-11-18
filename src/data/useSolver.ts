import { useEffect, useState, useSyncExternalStore } from "react";
import { loadSolver, solverLoaded, subscribeSolver } from "./charts";

export type SolverStatus = "ready" | "loading" | "error";

/**
 * A new document: the only way to fetch a stage chunk again after a failed load. The browser keeps a dynamic import's
 * failure in the document's module map, so a second import() of the same chunk rejects at once, without a request
 * (measured in Chromium: three retries, no request). The route is in the hash and the picked set in the settings, so
 * the reload comes back to the same screen; the service worker serves the shell offline once it is installed.
 */
export function reloadForSolver(): void {
  window.location.reload();
}

/**
 * Loads the solver set's stage chunks when `needed` (docs §6.3) and reports whether getSet("solver") can be read:
 * "ready" (always when not needed), "loading", or "error" when a chunk failed to load (offline before the app cached
 * it); `retry` reloads the page (reloadForSolver: a failed chunk cannot be imported again in the same document). The
 * charts page and the preflop quiz pass whether the picked set is the solver set, the calculator always needs it (its
 * villain ranges list every set). Nothing is fetched when not needed.
 */
export function useSolver(needed = true): { status: SolverStatus; retry: () => void } {
  const loaded = useSyncExternalStore(subscribeSolver, solverLoaded, solverLoaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!needed || loaded) return;
    let live = true;
    loadSolver().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [needed, loaded]);
  return { status: !needed || loaded ? "ready" : failed ? "error" : "loading", retry: reloadForSolver };
}
