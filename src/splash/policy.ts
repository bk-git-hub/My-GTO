/**
 * Launch splash policy: when it shows and for how long. Pure, so it is unit-tested
 * (policy.test.ts); the DOM side lives in splash.ts, the markup and motion in index.html.
 */

/** sessionStorage key: set on the first show, so a reload in the same session skips the splash. */
export const SESSION_KEY = "pubaj.splash";

/**
 * The intro (shades lift and drop, cards fan, wordmark) has played by about 1.0 s; the lens glint
 * that ends it runs into the fade.
 */
export const MIN_SHOW_MS = 1000;
/** With reduced motion there is nothing to wait for but a short, calm fade in. */
export const MIN_SHOW_REDUCED_MS = 500;
/** Never on screen longer than this, however slow the app is (the fade ends by then). */
export const MAX_SHOW_MS = 2500;
/** Fade (and slight zoom) out once the app is ready. */
export const FADE_MS = 250;
/** Fade out after a tap: quick, the user asked for the app. */
export const SKIP_FADE_MS = 140;
/**
 * The CSS-only fallback in index.html (`spl-bail`, 2.4 s delay + 0.25 s fade): hides the splash
 * even when the JS bundle never runs. Must match index.html; it stays behind the JS cap.
 */
export const CSS_BAIL_DELAY_MS = 2400;
export const CSS_BAIL_MS = CSS_BAIL_DELAY_MS + 250;

export type SplashMode = "show" | "skip";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reads the "already shown this session" flag and sets it. null when storage is unavailable
 * (blocked, private mode, quota): every access is guarded, nothing here can throw.
 */
export function takeSessionFlag(getStorage: () => StorageLike | null | undefined): boolean | null {
  try {
    const s = getStorage();
    if (!s) return null;
    const seen = s.getItem(SESSION_KEY) === "1";
    if (!seen) s.setItem(SESSION_KEY, "1");
    return seen;
  } catch {
    return null;
  }
}

export interface DecisionInput {
  /** What the inline script in index.html decided (data-splash on <html>), null if it did not run. */
  inline: string | null;
  /** takeSessionFlag(), read only when the inline script did not run. */
  seen: boolean | null;
  /** PerformanceNavigationTiming.type ("navigate", "reload", "back_forward", ...), if known. */
  navigationType?: string | null;
}

/**
 * Cold starts only: a reload in the same session (the PWA update flow reloads the page, or a
 * manual reload) goes straight to the app. Without storage, a "reload" navigation still counts.
 */
export function splashDecision(s: DecisionInput): SplashMode {
  if (s.inline === "show" || s.inline === "skip") return s.inline;
  if (s.seen === true || s.navigationType === "reload") return "skip";
  return "show";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * When the splash started animating, in performance.now() time: the earliest start time of its
 * CSS animations, else navigation start (0). A start in the future (a clock oddity) is ignored.
 */
export function splashStart(startTimes: ReadonlyArray<number | null | undefined>, now: number): number {
  let start = Infinity;
  for (const t of startTimes) if (finite(t) && t >= 0 && t < start) start = t;
  if (!Number.isFinite(start)) return 0;
  return finite(now) ? Math.min(start, now) : start;
}

export interface HideInput {
  /** performance.now() */
  now: number;
  /** splashStart() */
  shownAt: number;
  reducedMotion: boolean;
}

/**
 * How long to keep the splash before fading out, once the app has rendered: until the minimum
 * time has passed since it appeared, but always early enough that the fade ends by MAX_SHOW_MS.
 */
export function hideDelay(s: HideInput): number {
  if (!finite(s.now)) return 0;
  const shownAt = finite(s.shownAt) ? Math.min(Math.max(0, s.shownAt), s.now) : 0;
  const min = s.reducedMotion ? MIN_SHOW_REDUCED_MS : MIN_SHOW_MS;
  const untilMin = shownAt + min - s.now;
  const untilCap = shownAt + MAX_SHOW_MS - FADE_MS - s.now;
  return Math.max(0, Math.min(untilMin, untilCap));
}

/**
 * The safety net when the app never reports its first render (it threw, a chunk failed): fade out
 * anyway so the splash ends by MAX_SHOW_MS.
 */
export function safetyDelay(now: number, shownAt: number): number {
  if (!finite(now)) return 0;
  const start = finite(shownAt) ? Math.min(Math.max(0, shownAt), now) : 0;
  return Math.max(0, start + MAX_SHOW_MS - FADE_MS - now);
}

export function fadeMs(reason: "ready" | "skip", reducedMotion: boolean): number {
  if (reason === "skip") return SKIP_FADE_MS;
  return reducedMotion ? 200 : FADE_MS;
}

export type LeavePlan =
  /** Fade out over this many ms, then remove. */
  | { fade: number }
  /**
   * The CSS bail is already fading (or has hidden) the splash: a JS fade now would replace that
   * animation and bring the splash back for a moment. Leave it alone, remove it in this many ms.
   */
  | { bailing: number };

export function leavePlan(reason: "ready" | "skip", s: HideInput): LeavePlan {
  if (finite(s.now)) {
    const start = finite(s.shownAt) ? Math.min(Math.max(0, s.shownAt), s.now) : 0;
    if (s.now - start >= CSS_BAIL_DELAY_MS) return { bailing: Math.max(0, start + CSS_BAIL_MS - s.now) };
  }
  return { fade: fadeMs(reason, s.reducedMotion) };
}
