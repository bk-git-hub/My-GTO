import { describe, expect, it } from "vitest";
import { backStep, flowTabs, initialStep, lowerStep, prevStep, reopenStep, type FlowState, type FlowTab } from "./flowSteps";

const state = (over: Partial<FlowState> = {}): FlowState => ({ seat: false, cards: false, street: "preflop", done: false, ...over });
/** One letter per tab: O on, P passed (tappable), E ahead but tappable, - not reached. */
const shape = (tabs: FlowTab[]) => tabs.map((t) => (t.on ? "O" : t.passed ? "P" : t.enabled ? "E" : "-")).join("");

describe("hand recorder step tabs", () => {
  it("has seven steps, the hand first and the table second", () => {
    expect(flowTabs("hand", state()).map((t) => t.label)).toEqual(["핸드", "테이블", "프리플랍", "플랍", "턴", "리버", "결과"]);
    expect(flowTabs("hand", state()).map((t) => t.step)).toEqual(["hand", "setup", "play", "play", "play", "play", "result"]);
  });

  it("a fresh hand: the hand and the table are reachable, the streets wait for the seat and both cards", () => {
    expect(shape(flowTabs("hand", state()))).toBe("OE-----");
    expect(shape(flowTabs("hand", state({ cards: true })))).toBe("OE-----");
    expect(shape(flowTabs("setup", state({ cards: true })))).toBe("PO-----");
    expect(shape(flowTabs("setup", state({ seat: true, cards: true })))).toBe("POE----");
    // the table before the cards: the hand is still a step back
    expect(shape(flowTabs("setup", state({ seat: true })))).toBe("PO-----");
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

  it("going back to the hand or the table keeps the later steps tappable", () => {
    expect(shape(flowTabs("setup", state({ seat: true, cards: true, street: "turn" })))).toBe("POEEE--");
    expect(shape(flowTabs("hand", state({ seat: true, cards: true, street: "turn" })))).toBe("OEEEE--");
  });

  it("starts a hand at its first missing piece: the cards, then the seat", () => {
    expect(initialStep({ seat: "", hole: [] })).toBe("hand");
    expect(initialStep({ seat: "BTN", hole: [] })).toBe("hand");
    expect(initialStep({ seat: "BTN", hole: [0] })).toBe("hand");
    expect(initialStep({ seat: "", hole: [0, 5] })).toBe("setup");
    expect(initialStep({ seat: "BTN", hole: [0, 5] })).toBe("play");
  });

  it("opens another player's hand jotted on the quick screen on the table (my seat and stacks go there)", () => {
    expect(initialStep({ seat: "CO", hole: [0, 5], kind: "other", steps: [] })).toBe("setup");
    expect(initialStep({ seat: "CO", hole: [], kind: "other", steps: [] })).toBe("hand");
    // recorded on the table already: back to the action
    expect(initialStep({ seat: "CO", hole: [0, 5], kind: "other", steps: [{ s: "UTG", k: "fold" }] })).toBe("play");
    expect(initialStep({ seat: "CO", hole: [0, 5], steps: [] })).toBe("play");
  });
});

describe("the header's back inside the hand recorder", () => {
  it("the step before each: 결과 → 액션 → 테이블 → 핸드, none before the hand", () => {
    expect(prevStep("result")).toBe("play");
    expect(prevStep("play")).toBe("setup");
    expect(prevStep("setup")).toBe("hand");
    expect(prevStep("hand")).toBeNull();
  });

  it("the lower of two steps", () => {
    expect(lowerStep("play", "setup")).toBe("setup");
    expect(lowerStep("hand", "result")).toBe("hand");
    expect(lowerStep("play", "play")).toBe("play");
  });

  it("from the first screen (opened on the hand) back steps all the way down, then leaves the screen", () => {
    expect(backStep("result", "hand")).toBe("play");
    expect(backStep("play", "hand")).toBe("setup");
    expect(backStep("setup", "hand")).toBe("hand");
    expect(backStep("hand", "hand")).toBeNull();
  });

  it("a hand opened further on steps back only through the steps shown, then leaves for the list", () => {
    // a saved hand opened on its action: back leaves at once; from its result, one step to the action first
    expect(backStep("play", "play")).toBeNull();
    expect(backStep("result", "play")).toBe("play");
    // its table looked at on the way: back goes there before leaving
    expect(backStep("play", "setup")).toBe("setup");
    expect(backStep("setup", "setup")).toBeNull();
  });

  it("a hand stepped back to reopens on the step it was left on, while that step can still show it", () => {
    const ready = { seat: "BTN", hole: [0, 5] };
    expect(reopenStep(undefined, ready)).toBeNull();
    for (const s of ["hand", "setup", "play", "result"] as const) expect(reopenStep(s, ready)).toBe(s);
    // the seat or the cards gone meanwhile (edited on another screen): the action and the result can't show it
    expect(reopenStep("play", { seat: "", hole: [0, 5] })).toBeNull();
    expect(reopenStep("result", { seat: "BTN", hole: [0] })).toBeNull();
    expect(reopenStep("setup", { seat: "", hole: [] })).toBe("setup");
  });
});
