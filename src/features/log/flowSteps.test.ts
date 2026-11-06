import { describe, expect, it } from "vitest";
import { flowTabs, initialStep, type FlowState, type FlowTab } from "./flowSteps";

const state = (over: Partial<FlowState> = {}): FlowState => ({ seat: false, cards: false, street: "preflop", done: false, ...over });
/** One letter per tab: O on, P passed (tappable), E ahead but tappable, - not reached. */
const shape = (tabs: FlowTab[]) => tabs.map((t) => (t.on ? "O" : t.passed ? "P" : t.enabled ? "E" : "-")).join("");

describe("hand recorder step tabs", () => {
  it("has the seven steps of the mockup, in order", () => {
    expect(flowTabs("setup", state()).map((t) => t.label)).toEqual(["테이블", "핸드", "프리플랍", "플랍", "턴", "리버", "결과"]);
    expect(flowTabs("setup", state()).map((t) => t.step)).toEqual(["setup", "hand", "play", "play", "play", "play", "result"]);
  });

  it("a fresh hand: only the table is reachable", () => {
    expect(shape(flowTabs("setup", state()))).toBe("O------");
    // my seat picked: the hand step opens up, the streets wait for my cards
    expect(shape(flowTabs("setup", state({ seat: true })))).toBe("OE-----");
    expect(shape(flowTabs("hand", state({ seat: true })))).toBe("PO-----");
    expect(shape(flowTabs("hand", state({ seat: true, cards: true })))).toBe("POE----");
  });

  it("lights the street being recorded; streets already played aren't tappable then (same screen)", () => {
    expect(shape(flowTabs("play", state({ seat: true, cards: true })))).toBe("PPO----");
    expect(shape(flowTabs("play", state({ seat: true, cards: true, street: "flop" })))).toBe("PP-O---");
    expect(shape(flowTabs("play", state({ seat: true, cards: true, street: "river" })))).toBe("PP---O-");
    // from the table, every reached street leads back to the one action step
    const tabs = flowTabs("setup", state({ seat: true, cards: true, street: "turn" }));
    expect(tabs.filter((t) => t.enabled && t.step === "play").map((t) => t.key)).toEqual(["preflop", "flop", "turn"]);
  });

  it("once the action is over, each street played opens the result replay at that street", () => {
    const over = state({ seat: true, cards: true, street: "flop", done: true });
    expect(shape(flowTabs("play", over))).toBe("PPPO--E");
    expect(shape(flowTabs("result", over))).toBe("PPPP--O");
    const streets = flowTabs("result", over).filter((t) => t.enabled && t.street !== null);
    expect(streets.map((t) => [t.key, t.step, t.street])).toEqual([
      ["preflop", "result", "preflop"],
      ["flop", "result", "flop"],
    ]);
    // the result tab itself starts the replay from the beginning
    expect(flowTabs("play", over)[6]).toMatchObject({ key: "result", step: "result", street: null, enabled: true });
  });

  it("going back to the table keeps the later steps tappable", () => {
    expect(shape(flowTabs("setup", state({ seat: true, cards: true, street: "turn" })))).toBe("OEEEE--");
  });

  it("starts a hand at its first missing piece", () => {
    expect(initialStep({ seat: "", hole: [] })).toBe("setup");
    expect(initialStep({ seat: "BTN", hole: [0] })).toBe("hand");
    expect(initialStep({ seat: "BTN", hole: [0, 5] })).toBe("play");
  });
});
