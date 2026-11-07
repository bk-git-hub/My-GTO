/**
 * The launch splash painted by index.html (#splash, above #root) before the bundle loads: the
 * 아재 on the J♥ lifts his shades for a moment, then the A♠ and J♥ fan out into the logo. All
 * motion is CSS; this module only decides when it goes away (policy.ts). Nothing here may keep
 * the app from being usable: every path ends with the node removed, and index.html hides it with
 * CSS alone at ~2.65 s if this never runs.
 *
 * Timeline (ms from the splash's first paint), all in index.html's inline CSS:
 *      0–200   the two cards pop in, stacked upright (J on top, a sliver of A behind it)
 *    200–680   the 아재 pushes his shades up onto his forehead (eyes, raised brows), winks
 *              (330–470), drops them back with a small bounce (lands at ~585)
 *    580–880   "샥": the cards fan out to the logo's exact poses (A −14°, J +8°), snappy ease-out
 *              with a tiny overshoot; yellow snap marks flick off the outer edges, a gold sheen
 *              sweeps across each card as it settles (740–1060)
 *    660–1000  the wordmark "PubAJ 펍아재", then the tagline, rise in
 *    840–1100  a glint and a streak cross the left lens (runs into the fade)
 *   ≥1000      once the app has rendered: fade + slight zoom out, 250 ms (a tap: 140 ms)
 *    2400      CSS-only bail when no JS ran at all (gone by ~2.65 s)
 * The pop, shades, brows, fan, snap marks and sheens move HTML boxes, which WebKit animates on
 * the compositor, so they play through the bundle's start-up long task; only the wink and the
 * glint animate SVG (main thread).
 * Reduced motion: no movement, the settled frame fades in and out.
 */
import { hideDelay, leavePlan, safetyDelay, splashDecision, splashStart, takeSessionFlag } from "./policy";

let el: HTMLElement | null = null;
let started = false;
let leaving = false;
let pointerDown = false;
let readyTimer = 0;
let safetyTimer = 0;

const now = () => performance.now();

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function navigationType(): string | null {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type ?? null;
  } catch {
    return null;
  }
}

/** performance.now() time the splash's CSS animations started (≈ its first paint). */
function shownAt(node: HTMLElement): number {
  try {
    const times = node.getAnimations({ subtree: true }).map((a) => (typeof a.startTime === "number" ? a.startTime : null));
    return splashStart(times, now());
  } catch {
    return 0;
  }
}

function detach() {
  window.clearTimeout(readyTimer);
  window.clearTimeout(safetyTimer);
  const node = el;
  el = null;
  if (!node) return;
  node.removeEventListener("pointerdown", onPointerDown);
  window.removeEventListener("keydown", onKey, true);
  node.remove();
}

/**
 * Removes the node once its fade is over and no finger is still on it. The faded splash stays
 * hit-testable until then (spl-out has no visibility:hidden), so a long press lands on it.
 */
function removeWhenDone(ms: number) {
  const deadline = now() + ms;
  const tick = () => {
    if (!el) return;
    if (now() < deadline || (pointerDown && now() < deadline + 1500)) {
      window.setTimeout(tick, 30);
      return;
    }
    detach();
  };
  window.setTimeout(tick, ms);
}

function leave(reason: "ready" | "skip") {
  if (!el || leaving) return;
  leaving = true;
  window.clearTimeout(readyTimer);
  window.clearTimeout(safetyTimer);
  try {
    const plan = leavePlan(reason, { now: now(), shownAt: shownAt(el), reducedMotion: reducedMotion() });
    if ("bailing" in plan) {
      removeWhenDone(plan.bailing + 40);
      return;
    }
    el.style.setProperty("--spl-out", `${plan.fade}ms`);
    el.classList.add("spl-out");
    removeWhenDone(plan.fade + 40);
  } catch {
    detach();
  }
}

/** After the pointerup that ends a skipping tap, its click arrives within this window. */
const CLICK_AFTER_UP_MS = 400;

/**
 * The click that follows a skipping tap must not land on whatever is under the splash, however
 * long the finger stayed down: armed at pointerdown, the window closes CLICK_AFTER_UP_MS after
 * the matching pointerup (or pointercancel). Listens on window, so it still works once the
 * splash node is gone.
 */
function swallowTapClick() {
  let until = Infinity;
  let closeTimer = 0;
  let capTimer = 0;
  const done = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.clearTimeout(closeTimer);
    window.clearTimeout(capTimer);
  };
  const swallow = (e: MouseEvent) => {
    if (now() <= until) {
      e.preventDefault();
      e.stopPropagation();
    }
    done();
  };
  const up = () => {
    pointerDown = false;
    until = now() + CLICK_AFTER_UP_MS;
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    closeTimer = window.setTimeout(done, CLICK_AFTER_UP_MS + 50);
  };
  // A pointerup that never arrives must not leave the next real click swallowed.
  capTimer = window.setTimeout(() => {
    pointerDown = false;
    done();
  }, 10_000);
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}

function onPointerDown() {
  pointerDown = true;
  swallowTapClick();
  leave("skip");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" || e.key === "Enter" || e.key === " ") leave("skip");
}

/**
 * Call once at startup, before the first render: removes the splash right away on a reload in
 * the same session, otherwise arms tap-to-skip and the safety timer.
 */
export function startSplash(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  try {
    el = document.getElementById("splash");
    if (!el) return;
    const inline = document.documentElement.getAttribute("data-splash");
    const mode = splashDecision({
      inline,
      // The inline script already read and set the flag; only fall back when it did not run.
      seen: inline ? null : takeSessionFlag(() => window.sessionStorage),
      navigationType: navigationType(),
    });
    if (mode === "skip") {
      detach();
      return;
    }
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey, true);
    safetyTimer = window.setTimeout(() => leave("ready"), safetyDelay(now(), shownAt(el)));
  } catch {
    detach();
  }
}

/** Call after the app's first render: fades the splash out once its minimum time is up. */
export function hideSplash(): void {
  if (!started) startSplash();
  if (!el || leaving || readyTimer) return;
  try {
    const delay = hideDelay({ now: now(), shownAt: shownAt(el), reducedMotion: reducedMotion() });
    readyTimer = window.setTimeout(() => leave("ready"), delay);
  } catch {
    leave("ready");
  }
}
