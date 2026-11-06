import { describe, expect, it } from "vitest";
import { actedPreflop, cleanPre, knownStage, openPresets, preRows, preSteps, shoveCap, stageFor, stageOf, summaryOf, summaryOfGame, summaryText, threeBetBb, threeBetShown, tidyPre, withAction, type PreContext, type QuickPre } from "./quickPre";
import { amountLabel, POSITIONS, replay, streetLines, type LogStep, type TableInput } from "./recorder";

const NINE = POSITIONS[9];
const table = (heroSeat: string, over: Partial<TableInput> = {}): TableInput => ({ heroSeat, heroStack: 40, stacks: {}, seats: NINE, bbAnte: true, ...over });
const bb = (x: number) => amountLabel(x, null);
const folds = (...seats: string[]): LogStep[] => seats.map((s) => ({ s, k: "fold", a: 1 }));
/** The steps replay in full, and what the preflop line then says. */
function line(t: TableInput, steps: LogStep[]): string[] {
  const r = replay(t, steps);
  expect(r.applied).toBe(steps.length);
  return streetLines(r.game, bb)[0]?.actions ?? [];
}

describe("quick preflop block: the record", () => {
  it("keeps valid fields in one key order and drops the rest", () => {
    const pre = cleanPre({ threeBetX: 3.5, openerSeat: "BTN", openBb: 3, action: "3bet", stage: "deep", pinned: true, extra: 1 }, NINE);
    expect(pre).toEqual({ stage: "deep", pinned: true, action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3.5 });
    expect(Object.keys(pre!)).toEqual(["stage", "pinned", "action", "openBb", "openerSeat", "threeBetX"]);
    // malformed values are dropped one by one
    expect(cleanPre({ stage: "huge", action: "call", openBb: -2, openerSeat: "MP", threeBetX: 0.5, pinned: "yes" }, NINE)).toEqual({ action: "call" });
    expect(cleanPre({ action: "call", openBb: Number.NaN, openAllIn: true }, NINE)).toEqual({ action: "call", openAllIn: true });
    // a size beats an all-in flag next to it
    expect(cleanPre({ action: "open", openBb: 2.5, openAllIn: true }, NINE)).toEqual({ action: "open", openBb: 2.5 });
    expect(cleanPre({ action: "3bet", threeBetX: 3, threeBetAllIn: true }, NINE)).toEqual({ action: "3bet", threeBetX: 3 });
    // an opener has to be a seat at this table (MP only exists 10-handed)
    expect(cleanPre({ action: "call", openerSeat: "MP" }, POSITIONS[10])).toEqual({ action: "call", openerSeat: "MP" });
    // nothing entered: no record (a stage that only follows the stack isn't an entry)
    expect(cleanPre({ stage: "mid" }, NINE)).toBeUndefined();
    expect(cleanPre({ stage: "mid", pinned: true }, NINE)).toEqual({ stage: "mid", pinned: true });
    expect(cleanPre({ pinned: true }, NINE)).toBeUndefined();
    for (const junk of [null, undefined, "call", 3, [], {}]) expect(cleanPre(junk, NINE)).toBeUndefined();
  });

  it("picks the stage from my stack until one is tapped, then keeps the tapped one", () => {
    expect([stageFor(100), stageFor(85), stageFor(40), stageFor(30), stageFor(12), stageFor(8)]).toEqual(["deep", "deep", "mid", "mid", "short", "push"]);
    // from the stack (32,000 at Lv6 = 40bb), whatever was last used or kept
    expect(stageOf(undefined, 40, "deep")).toBe("mid");
    expect(stageOf({ stage: "short", action: "call" }, 40, null)).toBe("mid");
    // no stack: as kept on the hand, else the last stage used, else mid
    expect(stageOf({ stage: "short", action: "call" }, null, "deep")).toBe("short");
    expect(stageOf(undefined, null, "deep")).toBe("deep");
    expect(stageOf(undefined, null, null)).toBe("mid");
    // tapped: it sticks even when the stack says otherwise
    expect(stageOf({ stage: "deep", pinned: true }, 12, null)).toBe("deep");
    // a junk "last" doesn't leak in
    expect(stageOf(undefined, null, "huge" as never)).toBe("mid");
    // what the next hand starts from
    expect(knownStage({ stage: "push", pinned: true }, 40)).toBe("push");
    expect(knownStage({ stage: "push" }, 40)).toBe("mid");
    expect(knownStage({ stage: "push" }, null)).toBeNull();
  });

  it("keeps the block in step with the stack, seat and table", () => {
    const ctx = (over: Partial<PreContext> = {}): PreContext => ({ bb: 40, seats: NINE, seat: "BB", last: null, ...over });
    // the stack moves: an unpinned stage follows, a pinned one stays
    expect(tidyPre({ stage: "mid", action: "call" }, ctx({ bb: 100 }))).toEqual({ stage: "deep", action: "call" });
    expect(tidyPre({ stage: "mid", pinned: true, action: "call" }, ctx({ bb: 100 }))).toEqual({ stage: "mid", pinned: true, action: "call" });
    // the stack cleared: the stage stays as it was
    expect(tidyPre({ stage: "deep", action: "call" }, ctx({ bb: null, last: "push" }))).toEqual({ stage: "deep", action: "call" });
    // a first tap with no stack takes the last stage used
    expect(tidyPre({ action: "open" }, ctx({ bb: null, last: "short" }))).toEqual({ stage: "short", action: "open" });
    // my seat became the opener's, or the opener isn't at this table any more
    expect(tidyPre({ action: "call", openerSeat: "CO" }, ctx({ seat: "CO" }))).toEqual({ stage: "mid", action: "call" });
    expect(tidyPre({ action: "call", openerSeat: "UTG+1" }, ctx({ seats: POSITIONS[6], seat: "BB" }))).toEqual({ stage: "mid", action: "call" });
    // the action cleared: nothing is left
    expect(tidyPre({ stage: "mid", openBb: 2.5, openerSeat: "CO" }, ctx())).toBeUndefined();
    expect(tidyPre(undefined, ctx())).toBeUndefined();
  });

  it("offers open sizes by stage, and the rows each action needs", () => {
    expect(openPresets("deep", "open")).toEqual([3, 3.5, 4]);
    expect(openPresets("mid", "call")).toEqual([2.2, 2.5, 3]);
    expect(openPresets("short", "open")).toEqual([2, 2.2, "allin"]);
    expect(openPresets("push", "open")).toEqual(["allin"]);
    expect(openPresets("push", "call")).toEqual(["allin"]);
    // an open I 3-bet or shove over is a size, not an all-in
    expect(openPresets("short", "3bet")).toEqual([2, 2.2]);
    expect(openPresets("push", "allin")).toEqual([2, 2.2]);
    expect(preRows({ action: "fold" })).toEqual({ size: false, opener: false, threeBet: false });
    expect(preRows({ action: "limp" })).toEqual({ size: false, opener: false, threeBet: false });
    expect(preRows({ action: "open" })).toEqual({ size: true, opener: false, threeBet: false });
    expect(preRows({ action: "call" })).toEqual({ size: true, opener: true, threeBet: false });
    expect(preRows({ action: "3bet" })).toEqual({ size: true, opener: true, threeBet: true });
    // 올인: who opened only once there was an open before me
    expect(preRows({ action: "allin" })).toEqual({ size: true, opener: false, threeBet: false });
    expect(preRows({ action: "allin", openBb: 2.2 })).toEqual({ size: true, opener: true, threeBet: false });
    expect(preRows({ action: "allin", openerSeat: "UTG" })).toEqual({ size: true, opener: true, threeBet: false });
    expect(preRows(undefined)).toEqual({ size: false, opener: false, threeBet: false });
    expect(preRows({ stage: "mid", pinned: true })).toEqual({ size: false, opener: false, threeBet: false });
    expect(threeBetBb({ openBb: 3, threeBetX: 3.5 })).toBe(10.5);
    expect(threeBetBb({ openBb: 2.5, threeBetX: 3.5 })).toBe(8.8);
    expect(threeBetBb({ threeBetX: 3 })).toBeNull();
  });

  it("clears the open when my action moves between my open and an open before me", () => {
    // my 2.5bb open never becomes an unknown opener's 2.5bb open I shoved over
    expect(withAction({ stage: "mid", action: "open", openBb: 2.5 }, "allin")).toEqual({ stage: "mid", action: "allin" });
    expect(withAction({ stage: "mid", action: "open", openAllIn: true }, "call")).toEqual({ stage: "mid", action: "call" });
    // and the other way
    expect(withAction({ stage: "deep", action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3 }, "open")).toEqual({ stage: "deep", action: "open" });
    // 폴드 · 림프, or the action tapped off: nothing is left behind out of sight
    expect(withAction({ action: "call", openBb: 2.5, openerSeat: "CO" }, "fold")).toEqual({ action: "fold" });
    expect(withAction({ stage: "mid", action: "open", openBb: 2.5 }, undefined)).toEqual({ stage: "mid" });
    // between 콜 · 3벳 · 올인 it is the same open: kept
    expect(withAction({ action: "call", openBb: 2.5, openerSeat: "CO" }, "3bet")).toEqual({ action: "3bet", openBb: 2.5, openerSeat: "CO" });
    expect(withAction({ action: "3bet", openBb: 2.5, openerSeat: "CO", threeBetX: 3 }, "allin")).toEqual({ action: "allin", openBb: 2.5, openerSeat: "CO", threeBetX: 3 });
    // ...but a shove I called can't be 3-bet or shoved over
    expect(withAction({ action: "call", openAllIn: true, openerSeat: "CO" }, "3bet")).toEqual({ action: "3bet", openerSeat: "CO" });
    // a stage tapped stays whatever the action
    expect(withAction({ stage: "short", pinned: true, action: "open", openBb: 2 }, "call")).toEqual({ stage: "short", pinned: true, action: "call" });
  });

  it("caps my raises at my stack, less the BB's ante", () => {
    expect(shoveCap(12, "CO", true)).toBe(12);
    expect(shoveCap(12, "SB", true)).toBe(12);
    expect(shoveCap(12, "BB", true)).toBe(11);
    expect(shoveCap(12, "BB", false)).toBe(12);
    expect(shoveCap(0.8, "BB", true)).toBeNull();
    expect(shoveCap(null, "CO", true)).toBeNull();
    expect(threeBetShown({ openBb: 2.2, threeBetX: 4 }, 8)).toBe("allin");
    expect(threeBetShown({ openBb: 2.2, threeBetX: 3 }, 8)).toBe(6.6);
    expect(threeBetShown({ openBb: 2.2, threeBetX: 4 }, null)).toBe(8.8);
    expect(threeBetShown({ threeBetAllIn: true }, null)).toBe("allin");
  });
});

describe("quick preflop block: as text", () => {
  const text = (pre: QuickPre, me: string, myBb: number | null = 40) => summaryText(summaryOf(pre, me, myBb)!);

  it("reads like the hand", () => {
    expect(text({ action: "open", openBb: 2.5 }, "UTG")).toBe("UTG 오픈 2.5bb");
    expect(text({ action: "call", openBb: 2.5, openerSeat: "CO" }, "BB")).toBe("CO 2.5bb 오픈 → 콜");
    expect(text({ action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3 }, "SB")).toBe("BTN 3bb → 3벳 9bb");
    // a 3-bet all-in over an open reads as the table will record it
    expect(text({ action: "3bet", openBb: 3, openerSeat: "BTN", threeBetAllIn: true }, "SB")).toBe("BTN 3bb → 올인 40bb");
    expect(text({ action: "3bet", threeBetAllIn: true }, "SB", null)).toBe("3벳 올인");
    expect(text({ action: "allin" }, "CO", 12)).toBe("CO 올인 12bb");
    expect(text({ action: "open", openAllIn: true }, "CO", 12)).toBe("CO 올인 12bb");
    expect(text({ action: "allin", openBb: 2.2, openerSeat: "UTG" }, "BTN", 14)).toBe("UTG 2.2bb → 올인 14bb");
    expect(text({ action: "call", openAllIn: true, openerSeat: "CO" }, "BB")).toBe("CO 올인 → 콜");
    expect(text({ action: "limp" }, "SB")).toBe("SB 림프");
    expect(text({ action: "fold" }, "UTG")).toBe("UTG 폴드");
    // what isn't known is left out
    expect(text({ action: "call" }, "BB")).toBe("콜");
    expect(text({ action: "call", openerSeat: "CO" }, "BB")).toBe("CO 오픈 → 콜");
    expect(text({ action: "call", openBb: 2.5 }, "BB")).toBe("2.5bb 오픈 → 콜");
    expect(text({ action: "open" }, "")).toBe("오픈");
    expect(text({ action: "allin" }, "CO", null)).toBe("CO 올인");
    // rows the action doesn't show don't count (an opener kept from an earlier tap on 콜)
    expect(text({ action: "fold", openBb: 2.5, openerSeat: "CO" }, "BB")).toBe("BB 폴드");
    expect(text({ action: "open", openBb: 3, openerSeat: "CO", threeBetX: 3 }, "BTN")).toBe("BTN 오픈 3bb");
    expect(summaryOf({ stage: "mid", pinned: true }, "BB", 40)).toBeNull();
    // a raise of mine that reaches my stack is an all-in
    expect(text({ action: "3bet", openBb: 2.2, openerSeat: "CO", threeBetX: 4 }, "BTN", 8)).toBe("CO 2.2bb → 올인 8bb");
    expect(text({ action: "open", openBb: 4 }, "CO", 3)).toBe("CO 올인 3bb");
  });

  it("reads the same off the table's steps once the hand is carried on", () => {
    const from = (pre: QuickPre, t: TableInput) => {
      const g = replay(t, preSteps(t, pre)).game;
      return summaryText(summaryOfGame(g, t.heroSeat, t.heroStack)!);
    };
    expect(from({ action: "open", openBb: 2.5 }, table("UTG"))).toBe("UTG 오픈 2.5bb");
    expect(from({ action: "call", openBb: 2.5, openerSeat: "CO" }, table("BB"))).toBe("CO 2.5bb 오픈 → 콜");
    expect(from({ action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3 }, table("SB"))).toBe("BTN 3bb → 3벳 9bb");
    expect(from({ action: "allin" }, table("CO", { heroStack: 12 }))).toBe("CO 올인 12bb");
    expect(from({ action: "limp" }, table("BTN"))).toBe("BTN 림프");
    // the BB's shove and a 3-bet past my stack read the same before and after
    const same = (pre: QuickPre, t: TableInput) => {
      const before = summaryText(summaryOf(pre, t.heroSeat, shoveCap(t.heroStack, t.heroSeat, t.bbAnte ?? true))!);
      expect(from(pre, t)).toBe(before);
      return before;
    };
    expect(same({ action: "allin", openBb: 2, openerSeat: "BTN" }, table("BB", { heroStack: 12 }))).toBe("BTN 2bb → 올인 11bb");
    expect(same({ action: "3bet", openBb: 2.2, openerSeat: "CO", threeBetX: 4 }, table("BTN", { heroStack: 8 }))).toBe("CO 2.2bb → 올인 8bb");
    expect(same({ action: "3bet", openBb: 3, openerSeat: "BTN", threeBetAllIn: true }, table("SB", { heroStack: 40 }))).toBe("BTN 3bb → 올인 40bb");
    expect(same({ action: "allin" }, table("CO", { heroStack: 12 }))).toBe("CO 올인 12bb");
    // my first action facing a 3-bet doesn't fit one line
    const t = table("BB");
    const steps: LogStep[] = [...folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"), { s: "CO", k: "raise", to: 2.5 }, { s: "BTN", k: "raise", to: 7.5 }, ...folds("SB"), { s: "BB", k: "call" }];
    expect(summaryOfGame(replay(t, steps).game, "BB", 40)).toBeNull();
  });
});

describe("quick preflop block: onto the table", () => {
  it("I open UTG 2.5bb", () => {
    const t = table("UTG");
    const steps = preSteps(t, { stage: "mid", action: "open", openBb: 2.5 });
    expect(steps).toEqual([{ s: "UTG", k: "raise", to: 2.5 }]);
    expect(line(t, steps)).toEqual(["UTG(나) 오픈 2.5bb"]);
    // the table flow carries on with the next seat
    expect(replay(t, steps).game.players[replay(t, steps).game.toAct!].seat).toBe("UTG+1");
  });

  it("CO opens 2.5bb, I call from the BB: the flop is next", () => {
    const t = table("BB");
    const steps = preSteps(t, { stage: "mid", action: "call", openBb: 2.5, openerSeat: "CO" });
    expect(steps).toEqual([...folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"), { s: "CO", k: "raise", to: 2.5 }, ...folds("BTN", "SB"), { s: "BB", k: "call" }]);
    expect(line(t, steps)).toEqual(["CO 오픈 2.5bb", "BB(나) 콜 2.5bb"]);
    expect(replay(t, steps).game.street).toBe("flop");
  });

  it("BTN opens 3bb, I 3-bet ×3.5 from the SB: the BB is next", () => {
    const t = table("SB", { heroStack: 100 });
    const steps = preSteps(t, { stage: "deep", action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3.5 });
    expect(steps).toEqual([...folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"), { s: "BTN", k: "raise", to: 3 }, { s: "SB", k: "raise", to: 10.5 }]);
    expect(line(t, steps)).toEqual(["BTN 오픈 3bb", "SB(나) 3벳 10.5bb"]);
    const g = replay(t, steps).game;
    expect(g.players[g.toAct!].seat).toBe("BB");
    // a 3-bet shove goes in for my whole stack
    const shove = preSteps(t, { action: "3bet", openBb: 3, openerSeat: "BTN", threeBetAllIn: true });
    expect(shove[shove.length - 1]).toEqual({ s: "SB", k: "raise", to: 100 });
    // a 3-bet without a size stops at my turn
    expect(preSteps(t, { action: "3bet", openBb: 3, openerSeat: "BTN" })).toEqual([...folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"), { s: "BTN", k: "raise", to: 3 }]);
  });

  it("I shove 12bb from the CO", () => {
    const t = table("CO", { heroStack: 12 });
    for (const pre of [{ stage: "short", action: "allin" }, { stage: "short", action: "open", openAllIn: true }] as QuickPre[]) {
      const steps = preSteps(t, pre);
      expect(steps).toEqual([...folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"), { s: "CO", k: "raise", to: 12 }]);
      expect(line(t, steps)).toEqual(["CO(나) 오픈 12bb 올인"]);
    }
    // an open bigger than my stack is an all-in too
    expect(preSteps(t, { action: "open", openBb: 15 }).at(-1)).toEqual({ s: "CO", k: "raise", to: 12 });
  });

  it("limps, folds, and shoves over an open", () => {
    const btn = table("BTN");
    const limp = preSteps(btn, { action: "limp" });
    expect(limp).toEqual([...folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"), { s: "BTN", k: "call" }]);
    expect(line(btn, limp)).toEqual(["BTN(나) 림프 1bb"]);
    // the SB completes
    expect(line(table("SB"), preSteps(table("SB"), { action: "limp" }))).toEqual(["SB(나) 림프 1bb"]);
    const fold = preSteps(btn, { action: "fold" });
    expect(fold.at(-1)).toEqual({ s: "BTN", k: "fold" });
    expect(line(btn, fold)).toEqual(["BTN(나) 폴드"]);
    // an open kept from an earlier tap doesn't count for 폴드
    expect(preSteps(btn, { action: "fold", openBb: 2.5, openerSeat: "CO" })).toEqual(fold);
    const over = preSteps(table("BTN", { heroStack: 14 }), { action: "allin", openBb: 2.2, openerSeat: "UTG" });
    expect(line(table("BTN", { heroStack: 14 }), over)).toEqual(["UTG 오픈 2.2bb", "BTN(나) 3벳 14bb 올인"]);
    // the opener shoved and I call it
    const call = preSteps(table("BB", { heroStack: 20 }), { action: "call", openAllIn: true, openerSeat: "BTN" });
    // (the BB's ante came out of its 20bb)
    expect(line(table("BB", { heroStack: 20 }), call)).toEqual(["BTN 오픈 20bb 올인", "BB(나) 콜 19bb 올인"]);
  });

  it("keeps what fits of combos the table can't take, and never throws", () => {
    // the opener sits after me: everyone before me folds, then it's my turn
    const co = table("CO");
    const after = preSteps(co, { action: "call", openBb: 2.5, openerSeat: "BTN" });
    expect(after).toEqual(folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"));
    expect(replay(co, after).game.players[replay(co, after).game.toAct!].seat).toBe("CO");
    // the table hasn't got my action yet (the block still says what I did)
    expect(actedPreflop(replay(co, after).game, "CO")).toBe(false);
    expect(actedPreflop(replay(co, [...after, { s: "CO", k: "call" }]).game, "CO")).toBe(true);
    // the opener isn't known: nothing can be placed
    expect(preSteps(co, { action: "call", openBb: 2.5 })).toEqual([]);
    expect(preSteps(co, { action: "3bet", openBb: 2.5, openerSeat: "CO" })).toEqual([]);
    // the open's size isn't known, or the table can't take it (below a min-raise): the opener is next
    expect(preSteps(table("BB"), { action: "call", openerSeat: "CO" })).toEqual(folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"));
    expect(preSteps(table("BB"), { action: "call", openerSeat: "CO", openBb: 1.5 })).toEqual(folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"));
    // I open without a size: they fold to me and the table asks
    expect(preSteps(co, { action: "open" })).toEqual(folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ"));
    // no seat, no action, no block
    expect(preSteps(table(""), { action: "open", openBb: 2.5 })).toEqual([]);
    expect(preSteps(co, { stage: "mid", pinned: true })).toEqual([]);
    expect(preSteps(co, undefined)).toEqual([]);
    // the BB can't limp: the folds stop short of ending the hand, and the SB is next
    const bbLimp = preSteps(table("BB"), { action: "limp" });
    expect(bbLimp).toEqual(folds("UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"));
    expect(replay(table("BB"), bbLimp).game.done).toBe(false);
    // heads-up the SB acts first: nothing to fill in for the BB
    expect(preSteps(table("BB", { seats: POSITIONS[2] }), { action: "fold" })).toEqual([]);

    // every combination replays in full
    const actions = ["fold", "limp", "open", "call", "3bet", "allin"] as const;
    const sizes = [undefined, 1.5, 2.5, 50];
    for (const players of [2, 3, 6, 9, 10]) {
      const seats = POSITIONS[players];
      for (const me of seats) {
        for (const action of actions) {
          for (const openerSeat of [undefined, ...seats]) {
            for (const openBb of sizes) {
              for (const x of [undefined, 3]) {
                const t = table(me, { seats, heroStack: 25 });
                const pre: QuickPre = { action, openBb, openerSeat, threeBetX: x };
                const steps = preSteps(t, pre);
                expect(replay(t, steps).applied, `${players} ${me} ${JSON.stringify(pre)}`).toBe(steps.length);
              }
            }
          }
        }
      }
    }
  });
});
