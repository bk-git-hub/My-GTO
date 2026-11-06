import type { Street } from "../../play/engine";
import { LOG_STREET_LABEL, LOG_STREETS, type LoggedHand } from "./handLog";

/**
 * The hand recorder's steps and its seven-tab header: 테이블 · 핸드 · 프리플랍 · 플랍 · 턴 · 리버 · 결과.
 * While the hand is being recorded the four street tabs all stand for the one action step (the one
 * lit is the street being recorded); once the action is over each opens the result replay at its street.
 */

export type FlowStep = "setup" | "hand" | "play" | "result";

export interface FlowTab {
  key: "setup" | "hand" | Street | "result";
  label: string;
  /** The step the tab opens. */
  step: FlowStep;
  /** A finished hand's street tab: the street the result replay opens on. */
  street: Street | null;
  /** Highlighted: the step (or street) on screen. */
  on: boolean;
  /** Tapping it leads somewhere (or it is the one on screen). Other tabs are shown dimmed. */
  enabled: boolean;
  /** Before the highlighted tab and tappable: a step to go back to. */
  passed: boolean;
}

export interface FlowState {
  /** My seat is chosen. */
  seat: boolean;
  /** Both my cards are in. */
  cards: boolean;
  /** The street the action is on (the last street once the hand is over). */
  street: Street;
  /** The action is over. */
  done: boolean;
}

/** Where a hand opens: the first step still missing something. */
export function initialStep(h: Pick<LoggedHand, "seat" | "hole">): FlowStep {
  return !h.seat ? "setup" : h.hole.length < 2 ? "hand" : "play";
}

export function flowTabs(step: FlowStep, s: FlowState): FlowTab[] {
  const at = LOG_STREETS.indexOf(s.street);
  const playable = s.seat && s.cards;
  const tabs: Omit<FlowTab, "passed">[] = [
    { key: "setup", label: "테이블", step: "setup", street: null, on: step === "setup", enabled: true },
    { key: "hand", label: "핸드", step: "hand", street: null, on: step === "hand", enabled: s.seat },
    ...LOG_STREETS.map((st, i): Omit<FlowTab, "passed"> => {
      const on = step === "play" && i === at;
      const reached = playable && i <= at;
      // Recording: every street is the one action step, so from there the others lead nowhere new.
      if (!s.done) return { key: st, label: LOG_STREET_LABEL[st], step: "play", street: null, on, enabled: reached && (on || step !== "play") };
      return { key: st, label: LOG_STREET_LABEL[st], step: "result", street: st, on, enabled: reached };
    }),
    { key: "result", label: "결과", step: "result", street: null, on: step === "result", enabled: playable && s.done },
  ];
  const current = tabs.findIndex((t) => t.on);
  return tabs.map((t, i) => ({ ...t, passed: t.enabled && i < current }));
}
