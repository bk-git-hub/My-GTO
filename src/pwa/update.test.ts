import { describe, expect, it } from "vitest";
import {
  COLD_START_MS,
  INTERVAL_MS,
  ONLINE_THROTTLE_MS,
  VISIBLE_THROTTLE_MS,
  holdUpdates,
  isTextEntry,
  shouldAutoApply,
  shouldCheck,
  statusAfterCheck,
  statusOnWorkerChange,
  updateStore,
  type CheckInput,
  type UpdateStatus,
} from "./update";
import { formatKst } from "./version";

const T0 = Date.UTC(2026, 10, 6, 6, 0, 0);
const MIN = 60 * 1000;

function input(patch: Partial<CheckInput> = {}): CheckInput {
  return { now: T0, lastCheckAt: null, lastFailed: false, visible: true, online: true, busy: false, ready: false, ...patch };
}

describe("shouldCheck", () => {
  it("checks right after registration", () => {
    expect(shouldCheck("startup", input())).toBe(true);
    expect(shouldCheck("startup", input({ lastCheckAt: T0 - 1000 }))).toBe(true);
  });

  it("throttles coming back to the foreground to once per 5 minutes", () => {
    expect(shouldCheck("visible", input())).toBe(true);
    expect(shouldCheck("visible", input({ lastCheckAt: T0 - 1 * MIN }))).toBe(false);
    expect(shouldCheck("visible", input({ lastCheckAt: T0 - VISIBLE_THROTTLE_MS + 1 }))).toBe(false);
    expect(shouldCheck("visible", input({ lastCheckAt: T0 - VISIBLE_THROTTLE_MS }))).toBe(true);
    expect(shouldCheck("visible", input({ lastCheckAt: T0 - 3 * 60 * MIN }))).toBe(true);
  });

  it("does not run foreground or interval checks while hidden", () => {
    expect(shouldCheck("visible", input({ visible: false }))).toBe(false);
    expect(shouldCheck("interval", input({ visible: false, lastCheckAt: T0 - 2 * INTERVAL_MS }))).toBe(false);
  });

  it("checks every 30 minutes while visible", () => {
    expect(shouldCheck("interval", input({ lastCheckAt: T0 - 29 * MIN }))).toBe(false);
    expect(shouldCheck("interval", input({ lastCheckAt: T0 - INTERVAL_MS }))).toBe(true);
    expect(shouldCheck("interval", input())).toBe(true);
  });

  it("checks when the connection comes back, but not on every flap", () => {
    expect(shouldCheck("online", input({ lastCheckAt: T0 - 10 * MIN }))).toBe(true);
    expect(shouldCheck("online", input({ lastCheckAt: T0 - ONLINE_THROTTLE_MS + 1 }))).toBe(false);
    expect(shouldCheck("online", input({ visible: false }))).toBe(true);
  });

  it("retries as soon as the connection comes back after a failed check", () => {
    expect(shouldCheck("online", input({ lastCheckAt: T0 - 1000, lastFailed: true }))).toBe(true);
    // ...but the foreground throttle still holds.
    expect(shouldCheck("visible", input({ lastCheckAt: T0 - 1000, lastFailed: true }))).toBe(false);
  });

  it("skips automatic checks when offline, busy or already holding an update", () => {
    for (const reason of ["startup", "visible", "online", "interval"] as const) {
      expect(shouldCheck(reason, input({ online: false }))).toBe(false);
      expect(shouldCheck(reason, input({ busy: true }))).toBe(false);
      expect(shouldCheck(reason, input({ ready: true }))).toBe(false);
    }
  });

  it("always runs a manual check unless one is already running", () => {
    expect(shouldCheck("manual", input({ lastCheckAt: T0 - 1000 }))).toBe(true);
    expect(shouldCheck("manual", input({ online: false }))).toBe(true); // reports "offline"
    expect(shouldCheck("manual", input({ ready: true, visible: false }))).toBe(true);
    expect(shouldCheck("manual", input({ busy: true }))).toBe(false);
  });

  it("treats a clock that jumped backwards as long ago", () => {
    expect(shouldCheck("visible", input({ lastCheckAt: T0 + 60 * MIN }))).toBe(true);
  });
});

describe("shouldAutoApply", () => {
  const base = { sinceStart: 10_000, interacted: true, hidden: false, typing: false, held: false };

  it("applies when the user switches away", () => {
    expect(shouldAutoApply({ ...base, hidden: true })).toBe(true);
  });

  it("applies within ~3 s of a cold start before any input", () => {
    expect(shouldAutoApply({ ...base, sinceStart: 800, interacted: false })).toBe(true);
    expect(shouldAutoApply({ ...base, sinceStart: COLD_START_MS, interacted: false })).toBe(true);
    expect(shouldAutoApply({ ...base, sinceStart: COLD_START_MS + 1, interacted: false })).toBe(false);
    expect(shouldAutoApply({ ...base, sinceStart: 800, interacted: true })).toBe(false);
  });

  it("asks (banner) while the user is using the app", () => {
    expect(shouldAutoApply(base)).toBe(false);
  });

  it("never reloads while the user is typing", () => {
    expect(shouldAutoApply({ ...base, hidden: true, typing: true })).toBe(false);
    expect(shouldAutoApply({ ...base, sinceStart: 500, interacted: false, typing: true })).toBe(false);
  });

  it("never reloads while held (a coach reply streaming, a hand in progress)", () => {
    expect(shouldAutoApply({ ...base, hidden: true, held: true })).toBe(false);
    expect(shouldAutoApply({ ...base, sinceStart: 500, interacted: false, held: true })).toBe(false);
    // released: the app in the background applies it
    expect(shouldAutoApply({ ...base, hidden: true, held: false })).toBe(true);
  });
});

describe("holdUpdates", () => {
  it("returns a release that is safe to call twice (no browser here)", () => {
    const release = holdUpdates();
    const other = holdUpdates();
    release();
    release();
    other();
    expect(updateStore.get().status).toBe("unsupported");
  });
});

describe("isTextEntry", () => {
  it("counts text inputs, textareas and contenteditable", () => {
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "password" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("ignores buttons, toggles and fields that cannot be typed in", () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry({ tagName: "BODY" })).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(isTextEntry({ tagName: "TEXTAREA", disabled: true })).toBe(false);
  });
});

describe("statusAfterCheck", () => {
  it("reads the registration after update()", () => {
    expect(statusAfterCheck({ installing: false, waiting: false, controlled: true })).toBe("latest");
    expect(statusAfterCheck({ installing: true, waiting: false, controlled: true })).toBe("downloading");
    expect(statusAfterCheck({ installing: false, waiting: true, controlled: true })).toBe("ready");
    // A newer version still installing behind a waiting one: wait for it.
    expect(statusAfterCheck({ installing: true, waiting: true, controlled: true })).toBe("downloading");
    // First install: nothing older is running.
    expect(statusAfterCheck({ installing: true, waiting: false, controlled: false })).toBe("latest");
  });
});

describe("statusOnWorkerChange", () => {
  const reg = (installing: boolean, waiting: boolean, controlled = true) => ({ installing, waiting, controlled });

  it("reports a new version once it is installed and waiting, whatever workbox-window said", () => {
    // e.g. a retry after a failed install, or any update found over a minute after registering
    for (const cur of ["downloading", "error", "latest", "offline", "checking"] as UpdateStatus[]) {
      expect(statusOnWorkerChange(cur, reg(false, true))).toBe("ready");
    }
  });

  it("a newer version replacing a waiting one ends at ready, not error", () => {
    // E was waiting (ready), F found by a manual check: downloading while F installs
    expect(statusOnWorkerChange("downloading", reg(true, true))).toBe("downloading");
    // E goes redundant when F is installed: F is still `installing` at that moment
    expect(statusOnWorkerChange("downloading", reg(true, false))).toBe("downloading");
    // F installed, or F failed to install and E is still waiting: either way something waits
    expect(statusOnWorkerChange("downloading", reg(false, true))).toBe("ready");
  });

  it("a failed install with nothing waiting is an error", () => {
    expect(statusOnWorkerChange("downloading", reg(false, false))).toBe("error");
    // ...but not while something else is going on
    expect(statusOnWorkerChange("latest", reg(false, false))).toBeNull();
    expect(statusOnWorkerChange("ready", reg(false, false))).toBeNull();
  });

  it("leaves an update being applied and first installs alone", () => {
    expect(statusOnWorkerChange("applying", reg(false, true))).toBeNull();
    expect(statusOnWorkerChange("applying", reg(false, false))).toBeNull();
    expect(statusOnWorkerChange("idle", reg(false, true, false))).toBeNull();
  });
});

describe("updateStore", () => {
  it("starts unsupported outside a browser and can be subscribed to", () => {
    expect(updateStore.get().status).toBe("unsupported");
    let calls = 0;
    const off = updateStore.subscribe(() => calls++);
    off();
    expect(calls).toBe(0);
  });
});

describe("formatKst", () => {
  it("formats the last check time in Korea time", () => {
    expect(formatKst(Date.parse("2026-11-06T06:12:00.000Z"))).toBe("11월 6일 오후 3:12");
    expect(formatKst(Date.parse("2026-11-05T15:05:00Z"))).toBe("11월 6일 오전 12:05"); // past midnight in Seoul
    expect(formatKst(Date.parse("2026-11-06T03:00:00Z"))).toBe("11월 6일 오후 12:00");
    expect(formatKst(Date.parse("2026-12-31T23:59:00Z"))).toBe("1월 1일 오전 8:59");
  });

  it("returns empty for no time", () => {
    expect(formatKst(null)).toBe("");
    expect(formatKst(Number.NaN)).toBe("");
  });
});
