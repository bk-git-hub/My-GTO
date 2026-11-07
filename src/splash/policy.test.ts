import { describe, expect, it } from "vitest";
import {
  CSS_BAIL_MS,
  FADE_MS,
  MAX_SHOW_MS,
  MIN_SHOW_MS,
  MIN_SHOW_REDUCED_MS,
  SESSION_KEY,
  SKIP_FADE_MS,
  CSS_BAIL_DELAY_MS,
  fadeMs,
  hideDelay,
  leavePlan,
  safetyDelay,
  splashDecision,
  splashStart,
  takeSessionFlag,
  type StorageLike,
} from "./policy";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("session flag", () => {
  it("is unset on a cold start, then set for the rest of the session", () => {
    const s = memoryStorage();
    expect(takeSessionFlag(() => s)).toBe(false);
    expect(s.data.get(SESSION_KEY)).toBe("1");
    expect(takeSessionFlag(() => s)).toBe(true);
  });

  it("returns null instead of throwing when storage is missing or blocked", () => {
    expect(takeSessionFlag(() => null)).toBeNull();
    expect(
      takeSessionFlag(() => {
        throw new DOMException("denied", "SecurityError");
      }),
    ).toBeNull();
    const readOnly: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    expect(takeSessionFlag(() => readOnly)).toBeNull();
  });
});

describe("show or skip", () => {
  it("follows the inline script when it ran (it already read and set the flag)", () => {
    expect(splashDecision({ inline: "show", seen: true, navigationType: "reload" })).toBe("show");
    expect(splashDecision({ inline: "skip", seen: false, navigationType: "navigate" })).toBe("skip");
  });

  it("shows on a cold start and skips on a reload in the same session (update flow, manual reload)", () => {
    expect(splashDecision({ inline: null, seen: false, navigationType: "navigate" })).toBe("show");
    expect(splashDecision({ inline: null, seen: true, navigationType: "navigate" })).toBe("skip");
    expect(splashDecision({ inline: null, seen: false, navigationType: "reload" })).toBe("skip");
  });

  it("without storage, still skips reloads and shows otherwise", () => {
    expect(splashDecision({ inline: null, seen: null, navigationType: "reload" })).toBe("skip");
    expect(splashDecision({ inline: null, seen: null, navigationType: null })).toBe("show");
    expect(splashDecision({ inline: "garbage", seen: null })).toBe("show");
  });
});

describe("start time", () => {
  it("is the earliest animation start, ignoring unstarted and bogus entries", () => {
    expect(splashStart([180, 120.5, null, undefined, NaN, -5], 400)).toBe(120.5);
  });

  it("falls back to navigation start when nothing has started", () => {
    expect(splashStart([], 400)).toBe(0);
    expect(splashStart([null, NaN], 400)).toBe(0);
  });

  it("never lies in the future", () => {
    expect(splashStart([900], 400)).toBe(400);
  });
});

describe("hide delay", () => {
  const cold = { reducedMotion: false };

  it("keeps the splash until the intro has played, counted from when it appeared", () => {
    expect(hideDelay({ ...cold, now: 300, shownAt: 100 })).toBe(100 + MIN_SHOW_MS - 300);
    expect(hideDelay({ ...cold, now: 300, shownAt: 0 })).toBe(MIN_SHOW_MS - 300);
  });

  it("fades out right away when the app was slower than the minimum", () => {
    expect(hideDelay({ ...cold, now: 1600, shownAt: 100 })).toBe(0);
  });

  it("never lets the splash outlast the cap, whatever the minimum", () => {
    for (const now of [0, 500, 1000, 2000, 2400, 5000]) {
      for (const shownAt of [0, 100, 900]) {
        for (const reducedMotion of [false, true]) {
          const end = now + hideDelay({ now, shownAt, reducedMotion }) + fadeMs("ready", reducedMotion);
          expect(end).toBeLessThanOrEqual(Math.max(now + FADE_MS, Math.min(shownAt, now) + MAX_SHOW_MS));
        }
      }
    }
  });

  it("is short with reduced motion", () => {
    expect(hideDelay({ now: 200, shownAt: 50, reducedMotion: true })).toBe(50 + MIN_SHOW_REDUCED_MS - 200);
    expect(MIN_SHOW_REDUCED_MS).toBeLessThan(MIN_SHOW_MS);
  });

  it("treats a broken clock as 'now' rather than waiting forever", () => {
    expect(hideDelay({ ...cold, now: NaN, shownAt: 0 })).toBe(0);
    expect(hideDelay({ ...cold, now: 300, shownAt: NaN })).toBe(MIN_SHOW_MS - 300);
    // A start "in the future" counts from now: one full minimum, never more.
    expect(hideDelay({ ...cold, now: 300, shownAt: 10_000 })).toBe(MIN_SHOW_MS);
  });

  it("shows the whole splash for about 1.2 to 1.3 s on a fast cold start", () => {
    const total = hideDelay({ ...cold, now: 250, shownAt: 0 }) + 250 + fadeMs("ready", false);
    expect(total).toBeGreaterThanOrEqual(1150);
    expect(total).toBeLessThanOrEqual(1300);
  });
});

describe("failure fallback", () => {
  it("the safety timer fades out in time to be gone by the cap", () => {
    expect(safetyDelay(200, 100)).toBe(100 + MAX_SHOW_MS - FADE_MS - 200);
    expect(safetyDelay(3000, 100)).toBe(0);
    expect(safetyDelay(NaN, 0)).toBe(0);
    expect(safetyDelay(200, NaN)).toBe(MAX_SHOW_MS - FADE_MS - 200);
  });

  it("the CSS-only bail (no JS at all) also ends within ~2.7 s, after the JS cap", () => {
    expect(CSS_BAIL_MS).toBeGreaterThan(MAX_SHOW_MS);
    expect(CSS_BAIL_MS).toBeLessThanOrEqual(2700);
  });

  it("a bundle that arrives after the CSS bail started leaves that fade alone (no flash back)", () => {
    const at = (now: number) => leavePlan("ready", { now, shownAt: 50, reducedMotion: false });
    expect(at(1300)).toEqual({ fade: FADE_MS });
    expect(at(50 + MAX_SHOW_MS - FADE_MS)).toEqual({ fade: FADE_MS }); // the JS safety timer, before the bail
    expect(at(50 + CSS_BAIL_DELAY_MS + 100)).toEqual({ bailing: CSS_BAIL_MS - CSS_BAIL_DELAY_MS - 100 });
    expect(at(4000)).toEqual({ bailing: 0 });
    expect(leavePlan("skip", { now: NaN, shownAt: 0, reducedMotion: false })).toEqual({ fade: SKIP_FADE_MS });
  });

  it("the JS safety timer always fires before the CSS bail starts", () => {
    expect(MAX_SHOW_MS - FADE_MS).toBeLessThan(CSS_BAIL_DELAY_MS);
  });

  it("a tap fades faster than the ready fade", () => {
    expect(fadeMs("skip", false)).toBe(SKIP_FADE_MS);
    expect(fadeMs("skip", true)).toBe(SKIP_FADE_MS);
    expect(SKIP_FADE_MS).toBeLessThan(FADE_MS);
  });
});
