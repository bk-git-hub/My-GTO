import type { Attempt } from "../../shared/contracts";
import { newId } from "../../shared/ids";

export const SECRET = "test-secret-0123456789-abcdefghijklmnop";
/** 2026-11-05 12:00 KST */
export const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
export const DEVICE = newId(NOW - 1000);

let n = 0;
export function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  n++;
  return {
    id: newId(NOW - 60_000 + n),
    v: 1,
    at: NOW - 60_000 + n,
    kind: "preflop",
    keys: ["preflop", "preflop:pub-deep-rfi-BTN"],
    spot: "preflop:pub-deep-rfi-BTN:A5s",
    title: "BTN 오픈 · 딥 · A5s",
    chosen: "레이즈 2.2bb",
    correct: "레이즈 2.2bb",
    grade: "correct",
    deviceId: DEVICE,
    ...overrides,
  };
}
