import { describe, expect, it } from "vitest";
import { ALL_HANDS, RANKS } from "../../poker/cards";
import { AJAE_CRAMPED, AJAE_MOVES, AJAE_ROOM, AJAE_SPECIALS, AJAE_START, BALL_ROOM, BODY_MOVES, POP_ROOM, SPECIAL_MOVES, ajaeKey, ajaeMove, ajaePair, ajaePairMove, ajaeQuiet, ajaeSeen, ajaeStep, ajaeTier, laterSeats, type AjaeMove, type AjaeState, type AjaeTier } from "./ajae";
import { afterSave, cancelEdit, fastHand, forgetHands, newDraft, pickSuited, startEdit, tapRank, undoTap, withSeat, withSpot, type FastDraft, type FastState } from "./fastLog";
import { fastVerdict } from "./fastVerdict";
import { emptyHand } from "./handLog";
import { PRE_STAGES, type PreStage } from "./quickPre";
import { positionsFor } from "./recorder";

const tier = (cls: string, seat: string, stage: PreStage = "mid", players = 9) => ajaeTier(cls, seat, stage, players);
/** The class's tier at every seat of a table. */
const atEvery = (cls: string, stage: PreStage = "mid", players = 9) => positionsFor(players).map((s) => tier(cls, s, stage, players));
const R = (k: string) => RANKS.indexOf(k);
/** The chart's first-in fold frequency for the hand at the seat, as 빠른 기록's verdict reads it. */
const foldsFirstIn = (cls: string, seat: string, stage: PreStage, players: number) => fastVerdict({ stage, players, seat, cls, spot: "none", act: "fold" }).freq === 1;
const bbFoldsToButton = (cls: string, stage: PreStage, players: number) =>
  fastVerdict({ stage, players, seat: "BB", cls, spot: "open", opener: positionsFor(players).includes("BTN") ? "BTN" : "SB", act: "fold" }).freq === 1;

describe("ajaeTier: how good my two cards are from my seat (pub chart, first in)", () => {
  it("grades the agreed examples at the middle stage, 9-handed", () => {
    expect(tier("K9o", "UTG")).toBe("fold");
    expect(tier("A4o", "HJ")).toBe("fold");
    expect(tier("J4o", "CO")).toBe("trash");
    expect(tier("93o", "BTN")).toBe("trash");
    expect(tier("T8o", "BB")).toBe("trash");
    expect(tier("72o", "BTN")).toBe("hammer");
    expect(tier("AA", "UTG")).toBe("monster");
    expect(tier("JTs", "UTG")).toBe("good");
    expect(tier("87s", "BTN")).toBe("good");
  });

  it("calls AA KK QQ AK a monster and 72o the hammer from every seat, at every stage", () => {
    for (const stage of PRE_STAGES) {
      for (const cls of ["AA", "KK", "QQ", "AKs", "AKo"]) expect(new Set(atEvery(cls, stage))).toEqual(new Set(["monster"]));
      expect(new Set(atEvery("72o", stage))).toEqual(new Set(["hammer"]));
    }
  });

  it("kicks only the 41 offsuit hands the BB folds even to the button's open at the middle stage (72o is the hammer)", () => {
    const bbFolds = ALL_HANDS.filter((h) => bbFoldsToButton(h, "mid", 9));
    expect(bbFolds).toHaveLength(41);
    expect(bbFolds.every((h) => h.endsWith("o"))).toBe(true);
    for (const h of ["T8o", "J7o", "T7o", "97o", "J6o", "Q5o", "J4o", "93o", "32o", "72o"]) expect(bbFolds).toContain(h);
    // the same set from every seat: bad from anywhere
    for (const seat of positionsFor(9)) {
      const kicked = ALL_HANDS.filter((h) => ["trash", "hammer"].includes(tier(h, seat)));
      expect(kicked).toEqual(bbFolds);
    }
    expect(ALL_HANDS.filter((h) => tier(h, "CO") === "trash")).toHaveLength(40);
  });

  it("never kicks a hand any seat plays first in, at any stage or table size (K9o, A4o: a ponder at most)", () => {
    for (const stage of PRE_STAGES) {
      for (const players of [3, 4, 5, 6, 7, 8, 9, 10]) {
        const seats = positionsFor(players);
        for (const h of ALL_HANDS) {
          if (tier(h, seats[0], stage, players) !== "trash") continue;
          // the middle stage's BB folds it: the kick is for the same junk at every stack depth
          expect(bbFoldsToButton(h, "mid", players)).toBe(true);
          for (const s of seats.filter((x) => x !== "BB")) expect(foldsFirstIn(h, s, stage, players)).toBe(true);
          // trash at one seat is trash at all of them
          expect(new Set(atEvery(h, stage, players))).toEqual(new Set(["trash"]));
        }
        for (const h of ["K9o", "A4o", "A2o"]) expect(atEvery(h, stage, players)).not.toContain("trash");
        // Q9o, T9o, 76s: the short stage's BB folds them to an open, but they are no junk, so never a kick
        for (const h of ["Q9o", "T9o", "76s", "87o"]) expect(atEvery(h, stage, players)).not.toContain("trash");
      }
    }
  });

  it("counts a shove as playing the hand: the push stage's button shoves 87s, its SB shoves K2o", () => {
    expect(tier("87s", "BTN", "push")).toBe("good");
    expect(tier("K2o", "SB", "push")).toBe("good");
    // nobody calls or shoves 92o there
    expect(tier("92o", "UTG", "push")).toBe("trash");
    // the short stage: the SB shoves 87s though the BB folds it to the button's open, so it is no trash
    expect(bbFoldsToButton("87s", "short", 9)).toBe(true);
    expect(tier("87s", "SB", "short")).toBe("good");
    expect(tier("87s", "UTG", "short")).not.toBe("trash");
  });

  it("is good where my seat opens it, meh where one of the next two seats does, else the seat's fault", () => {
    expect(tier("KJo", "UTG")).toBe("meh"); // UTG+2 opens KJo+
    expect(tier("KTo", "UTG")).toBe("fold"); // neither UTG+1 nor UTG+2 does, though the BB defends it
    expect(tier("ATo", "UTG+1")).toBe("meh"); // UTG+2 opens ATo+
    expect(tier("Q9o", "CO")).toBe("meh"); // the button opens Q9o+
    expect(tier("A4o", "BTN")).toBe("meh"); // the BB defends it against the button
    expect(tier("A2o", "SB")).toBe("fold"); // the button opens A5o+ only
    expect(tier("A6o", "SB")).toBe("meh");
    // the button has no fold: what it folds the BB defends, or nobody plays (trash)
    for (const h of ALL_HANDS) expect(tier(h, "BTN")).not.toBe("fold");
  });

  it("grades the BB by the button's open: good where the button opens it, else meh", () => {
    for (const h of ALL_HANDS) {
      const t = tier(h, "BB");
      if (["monster", "hammer", "trash"].includes(t)) continue;
      expect(t).toBe(foldsFirstIn(h, "BTN", "mid", 9) ? "meh" : "good");
    }
    expect(tier("JTs", "BB")).toBe("good");
    expect(tier("K8o", "BB")).toBe("meh");
  });

  it("gives the BB a fold where its own chart folds to the button (a short stack), never a good", () => {
    for (const stage of PRE_STAGES) {
      for (const h of ALL_HANDS) {
        const t = tier(h, "BB", stage);
        if (["monster", "hammer", "trash"].includes(t)) continue;
        expect(t === "fold").toBe(bbFoldsToButton(h, stage, 9));
      }
    }
    expect(bbFoldsToButton("87s", "short", 9)).toBe(true);
    expect(tier("87s", "BB", "short")).toBe("fold");
  });

  it("kicks at most the middle stage's junk at any stage (about a third of hands, not two thirds at 숏)", () => {
    const mid = new Set(ALL_HANDS.filter((h) => tier(h, "CO") === "trash"));
    for (const stage of PRE_STAGES) {
      const kicked = ALL_HANDS.filter((h) => tier(h, "CO", stage) === "trash");
      for (const h of kicked) expect(mid.has(h)).toBe(true);
    }
  });

  it("works at every table size the screen offers (10-handed MP plays UTG+2's chart, 6-handed UTG is the first seat)", () => {
    for (const players of [3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const seat of positionsFor(players)) for (const h of ["AA", "72o", "JTs", "K9o", "J4o", "87s"]) expect(["monster", "good", "meh", "fold", "trash", "hammer"]).toContain(tier(h, seat, "mid", players));
    }
    expect(tier("KJo", "MP", "mid", 10)).toBe(tier("KJo", "UTG+2", "mid", 9));
    expect(tier("JTs", "UTG", "mid", 6)).toBe("good");
    expect(tier("J4o", "BTN", "mid", 3)).toBe("trash");
  });

  it("names the seats whose open makes my fold only meh", () => {
    expect(laterSeats(9, "UTG")).toEqual(["UTG+1", "UTG+2"]);
    expect(laterSeats(9, "HJ")).toEqual(["CO", "BTN"]);
    expect(laterSeats(9, "CO")).toEqual(["BTN"]);
    expect(laterSeats(9, "BTN")).toEqual([]);
    expect(laterSeats(9, "SB")).toEqual(["BTN"]);
    expect(laterSeats(6, "UTG")).toEqual(["HJ", "CO"]);
    expect(laterSeats(10, "UTG+2")).toEqual(["MP", "LJ"]);
    expect(laterSeats(2, "SB")).toEqual([]);
  });
});

describe("the pairs' own shows: AA flies a plane, KK is a gorilla or gets crowned, QQ waltzes, JJ splits into two jacks", () => {
  /** The 아재 after typing the pair at `seat` (its second rank completes it). */
  const pair = (s: AjaeState, seat: string, r: string, stage: PreStage = "mid", players = 9, room?: number) => ajaeStep(s, tapRank(newDraft(seat), R(r)), tapRank(tapRank(newDraft(seat), R(r)), R(r)), stage, players, room);
  const other = (s: AjaeState, seat: string, a: string, b: string, suited: boolean, room?: number) => {
    const two = tapRank(tapRank(newDraft(seat), R(a)), R(b));
    return ajaeStep(s, two, pickSuited(two, suited), "mid", 9, room);
  };

  it("has a show for AA, KK (two, in turn), QQ and JJ: body moves of their own, in no tier's list", () => {
    expect(AJAE_SPECIALS).toEqual({ AA: ["plane"], KK: ["gorilla", "crown"], QQ: ["waltz"], JJ: ["split"] });
    expect([...SPECIAL_MOVES].sort()).toEqual(["crown", "gorilla", "plane", "split", "waltz"]);
    for (const m of SPECIAL_MOVES) {
      expect(BODY_MOVES.has(m)).toBe(true);
      for (const moves of Object.values(AJAE_MOVES)) expect(moves as readonly string[]).not.toContain(m);
      expect(Object.values(AJAE_CRAMPED) as string[]).not.toContain(m);
      // it knows the room it needs, and fits with the page at the top (96 px)
      expect(AJAE_ROOM[m]).toBeGreaterThan(0);
      expect(AJAE_ROOM[m]).toBeLessThanOrEqual(96);
    }
    // only those four classes have one
    expect(ALL_HANDS.filter((h) => ajaePair(h))).toEqual(["AA", "KK", "QQ", "JJ"]);
    expect(ajaePair("AKs")).toBeUndefined();
    expect(ajaePair("TT")).toBeUndefined();
  });

  it("plays AA's plane, QQ's waltz and JJ's jacks every time, at every seat, stage and table size, resting on the hand's tier", () => {
    for (const stage of PRE_STAGES) {
      for (const players of [3, 6, 9, 10]) {
        for (const seat of positionsFor(players)) {
          for (const [r, move] of [["A", "plane"], ["Q", "waltz"], ["J", "split"]] as const) {
            let s = AJAE_START;
            for (let i = 0; i < 3; i++) {
              s = pair(s, seat, r, stage, players);
              expect(s.cue, `${r}${r} ${seat} ${stage} ${players}`).toMatchObject({ cls: `${r}${r}`, move, tier: ajaeTier(`${r}${r}`, seat, stage, players) });
            }
          }
        }
      }
    }
    expect(ajaeTier("AA", "UTG", "mid", 9)).toBe("monster");
    expect(ajaeTier("QQ", "BB", "push", 9)).toBe("monster");
  });

  it("alternates KK's two shows, the gorilla first, whatever comes between", () => {
    let s = AJAE_START;
    const kk: string[] = [];
    for (let i = 0; i < 5; i++) {
      s = pair(s, i % 2 ? "BTN" : "UTG", "K");
      kk.push(s.cue!.move);
      // other hands between, pairs with shows of their own too, don't move KK's turn
      s = pair(s, "CO", "A");
      s = other(s, "CO", "A", "K", true);
      s = other(s, "UTG", "J", "T", true);
    }
    expect(kk).toEqual(["gorilla", "crown", "gorilla", "crown", "gorilla"]);
    expect(s.pairs).toEqual({ KK: 5, AA: 5 });
    // the same taps, the same shows: nothing random
    let t = AJAE_START;
    const again: string[] = [];
    for (let i = 0; i < 5; i++) {
      t = pair(t, i % 2 ? "BTN" : "UTG", "K");
      again.push(t.cue!.move);
      t = pair(t, "CO", "A");
      t = other(t, "CO", "A", "K", true);
      t = other(t, "UTG", "J", "T", true);
    }
    expect(again).toEqual(kk);
  });

  it("leaves the tiers' turns alone: AK still shoves every time, good hands still go shuffle, robot, shuffle", () => {
    let s = AJAE_START;
    s = other(s, "UTG", "J", "T", true);
    expect(s.cue!.move).toBe("shuffle");
    s = pair(s, "UTG", "J");
    expect(s.cue).toMatchObject({ tier: "good", move: "split" });
    s = pair(s, "UTG", "A");
    s = pair(s, "UTG", "K");
    s = pair(s, "UTG", "Q");
    s = other(s, "UTG", "J", "T", true);
    expect(s.cue!.move).toBe("robot");
    s = other(s, "UTG", "A", "K", false);
    expect(s.cue!.move).toBe("shove");
    // the pairs count on their own, not on their tier's turn
    expect(s.seen).toEqual({ good: 2, monster: 1 });
    expect(s.pairs).toEqual({ JJ: 1, AA: 1, KK: 1, QQ: 1 });
    expect(s.n).toBe(7);
    // the cue says nothing more than any other reaction's
    expect(Object.keys(s.cue!).sort()).toEqual(["cls", "key", "move", "n", "tier"]);
    expect(Object.keys(pair(s, "UTG", "A").cue!).sort()).toEqual(["cls", "key", "move", "n", "tier"]);
  });

  it("plays what fits when the page is scrolled: the pair's other show, else what any hand of its tier would (AK's shove, then the cheer)", () => {
    const need = (m: AjaeMove) => AJAE_ROOM[m]!;
    // AA: the plane from exactly its room; less, the shove; less still, the face cheers (popping smaller)
    expect(pair(AJAE_START, "UTG", "A", "mid", 9, need("plane")).cue!.move).toBe("plane");
    expect(pair(AJAE_START, "UTG", "A", "mid", 9, need("plane") - 1).cue!.move).toBe("shove");
    expect(pair(AJAE_START, "UTG", "A", "mid", 9, need("shove") - 1).cue).toMatchObject({ move: "cheer", low: true });
    expect(pair(AJAE_START, "UTG", "A", "mid", 9, -20).cue).toMatchObject({ move: "cheer", low: true });
    // QQ the same way
    expect(pair(AJAE_START, "UTG", "Q", "mid", 9, need("waltz")).cue!.move).toBe("waltz");
    expect(pair(AJAE_START, "UTG", "Q", "mid", 9, need("waltz") - 1).cue!.move).toBe(need("waltz") - 1 >= need("shove") ? "shove" : "cheer");
    expect(pair(AJAE_START, "UTG", "Q", "mid", 9, 20).cue!.move).toBe("cheer");
    // KK: the crown's turn without room for the crown plays the gorilla if that fits
    const k1 = pair(AJAE_START, "UTG", "K");
    expect(k1.cue!.move).toBe("gorilla");
    expect(pair(k1, "UTG", "K", "mid", 9, need("crown")).cue!.move).toBe("crown");
    expect(need("gorilla")).toBeLessThan(need("crown"));
    expect(pair(k1, "UTG", "K", "mid", 9, need("crown") - 1).cue!.move).toBe("gorilla");
    expect(pair(k1, "UTG", "K", "mid", 9, need("gorilla") - 1).cue!.move).toBe("shove");
    expect(pair(k1, "UTG", "K", "mid", 9, 10).cue!.move).toBe("cheer");
    // the turn is taken all the same: after a cramped KK the next one is the other show
    const cramped = pair(k1, "UTG", "K", "mid", 9, 10);
    expect(pair(cramped, "UTG", "K").cue!.move).toBe("gorilla");
    // JJ (good at UTG): the good hands' dance, without its ball when scrolled, and the tier's turn left alone; then the nod
    const jj = pair(AJAE_START, "UTG", "J", "mid", 9, need("split") - 1);
    expect(jj.cue).toMatchObject({ tier: "good", move: "shuffle", noBall: true });
    expect(jj.seen).toEqual({});
    expect(other(jj, "UTG", "J", "T", true).cue!.move).toBe("shuffle");
    expect(pair(AJAE_START, "UTG", "J", "mid", 9, 30).cue).toMatchObject({ move: "nod", low: true });
    // ajaePairMove itself
    expect(ajaePairMove("KK", 1, "monster", 0)).toBe("crown");
    expect(ajaePairMove("KK", 2, "monster", 0, need("gorilla"))).toBe("gorilla");
    expect(ajaePairMove("AA", 0, "monster", 0, 0)).toBe("cheer");
    expect(ajaePairMove("JJ", 0, "good", 1, 55)).toBe("robot");
  });

  it("settles like any reaction: gone with its hand, at rest once the tier on screen changes", () => {
    const s = pair(AJAE_START, "UTG", "A");
    const aa = tapRank(tapRank(newDraft("UTG"), R("A")), R("A"));
    expect(ajaeSeen(s, withSeat(aa, "BB", 9), "mid", 9)).toBe(s);
    expect(ajaeSeen(s, undoTap(aa), "mid", 9).cue).toBeNull();
    // JJ where its tier changes with the seat, if any table has one: settled, it never plays again
    for (const stage of PRE_STAGES) {
      const tiers = positionsFor(9).map((seat) => ajaeTier("JJ", seat, stage, 9));
      const i = tiers.findIndex((t) => t !== tiers[0]);
      if (i < 0) continue;
      const jj = pair(AJAE_START, positionsFor(9)[0], "J", stage);
      const d = tapRank(tapRank(newDraft(positionsFor(9)[0]), R("J")), R("J"));
      expect(ajaeSeen(jj, withSeat(d, positionsFor(9)[i], 9), stage, 9).cue).toMatchObject({ move: "split", settled: true });
    }
  });
});

describe("ajaeStep: he reacts to a class completed by a tap, and only then", () => {
  const typed = (seat: string, a: string, b?: string): FastDraft => {
    let d = tapRank(newDraft(seat), R(a));
    if (b) d = tapRank(d, R(b));
    return d;
  };
  /** One tap on the hand, the 아재 after it. */
  const tap = (s: AjaeState, before: FastDraft, after: FastDraft, stage: PreStage = "mid") => ajaeStep(s, before, after, stage, 9);

  it("reacts on the pair's second rank and on 수딧 / 오프수트, not before", () => {
    const one = typed("UTG", "A");
    let s = tap(AJAE_START, newDraft("UTG"), one);
    expect(s.cue).toBeNull();
    s = tap(s, one, typed("UTG", "A", "A"));
    expect(s.cue).toEqual({ n: 1, cls: "AA", tier: "monster", move: "plane", key: "AA|" });
    // two different ranks wait for the suitedness
    const jt = typed("UTG", "J", "T");
    s = tap(AJAE_START, typed("UTG", "J"), jt);
    expect(s.cue).toBeNull();
    s = tap(s, jt, pickSuited(jt, true));
    expect(s.cue).toEqual({ n: 1, cls: "JTs", tier: "good", move: "shuffle", key: "JTs|" });
  });

  it("goes at once when the class is cleared (⌫ or a third rank starting a new hand)", () => {
    const k9 = typed("UTG", "K", "9");
    const k9o = pickSuited(k9, false);
    const s = tap(AJAE_START, k9, k9o);
    expect(s.cue?.tier).toBe("fold");
    expect(tap(s, k9o, undoTap(k9o)).cue).toBeNull();
    expect(tap(s, k9o, tapRank(k9o, R("Q"))).cue).toBeNull();
  });

  it("keeps the reaction through a new seat or spot (the face shows the new seat's tier at rest), and reacts anew to a switch to 수딧", () => {
    const k9 = typed("UTG", "K", "9");
    const k9o = pickSuited(k9, false);
    const s = tap(AJAE_START, k9, k9o);
    const btn = withSeat(k9o, "BTN", 9);
    expect(tap(s, k9o, btn)).toBe(s);
    expect(tap(s, k9o, withSpot(k9o, "limp"))).toBe(s);
    const k9s = pickSuited(k9o, true);
    expect(tap(s, k9o, k9s).cue).toMatchObject({ n: 2, cls: "K9s" });
    // a reaction left over from another hand (not yet cleared by ajaeSeen) goes with the next tap that doesn't react
    const stale: AjaeState = { ...s, cue: { ...s.cue!, key: "AA|" } };
    expect(tap(stale, k9o, btn)).toEqual({ ...s, cue: null });
  });

  it("takes the next move of the tier each time, whatever came between: trash kick → mallet → slam, good shuffle → robot", () => {
    const say = (seat: string, a: string, b: string, suited: boolean | null, s: AjaeState, room?: number) => {
      const two = typed(seat, a, b);
      return suited === null ? ajaeStep(s, typed(seat, a), two, "mid", 9, room) : ajaeStep(s, two, pickSuited(two, suited), "mid", 9, room);
    };
    let s = AJAE_START;
    const folds: string[] = [];
    const trash: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = say("UTG", "K", "9", false, s);
      expect(s.cue!.tier).toBe("fold");
      folds.push(s.cue!.move);
      s = say("CO", "J", "4", false, s);
      expect(s.cue!.tier).toBe("trash");
      trash.push(s.cue!.move);
    }
    expect(folds).toEqual(["ponder", "glare", "ponder", "glare"]);
    expect(trash).toEqual(["kick", "mallet", "slam", "kick"]);
    // good alternates, the mirror-ball shuffle first: at least every other good hand
    s = say("UTG", "J", "T", true, s);
    expect(s.cue!.move).toBe("shuffle");
    s = say("CO", "J", "4", false, s);
    expect(s.cue!.move).toBe("mallet");
    s = say("UTG", "J", "T", true, s);
    expect(s.cue!.move).toBe("robot");
    s = say("UTG", "J", "T", true, s);
    expect(s.cue!.move).toBe("shuffle");
    // AK, the monster with no show of its own, always shoves; 72o always rages; meh ponders, then "흠", in turn
    for (const suited of [true, false, true]) {
      s = say("UTG", "A", "K", suited, s);
      expect(s.cue).toMatchObject({ tier: "monster", move: "shove" });
    }
    for (let i = 0; i < 2; i++) {
      s = say("BTN", "7", "2", false, s);
      expect(s.cue).toMatchObject({ tier: "hammer", move: "rage" });
    }
    const mehs: string[] = [];
    for (let i = 0; i < 3; i++) {
      s = say("CO", "Q", "9", false, s);
      expect(s.cue!.tier).toBe("meh");
      mehs.push(s.cue!.move);
    }
    expect(mehs).toEqual(["ponder", "hmm", "ponder"]);
    // n counts every reaction; seen counts per tier
    expect(s.cue!.n).toBe(20);
    expect(s.seen).toEqual({ fold: 4, trash: 5, good: 3, monster: 3, hammer: 2, meh: 3 });
    // no words anywhere: the cue carries the move, nothing to say
    expect(Object.keys(s.cue!).sort()).toEqual(["cls", "key", "move", "n", "tier"]);
  });

  it("has a move list for every tier, the main move first; the body moves are the whole 아재's", () => {
    expect(AJAE_MOVES).toEqual({ monster: ["shove"], good: ["shuffle", "robot"], meh: ["ponder", "hmm"], fold: ["ponder", "glare"], trash: ["kick", "mallet", "slam"], hammer: ["rage"] });
    for (const t of ["monster", "good", "meh", "fold", "trash", "hammer"] as AjaeTier[]) {
      expect(AJAE_MOVES[t].length).toBeGreaterThan(0);
      // each tier's move in turn, from the k-th reaction
      for (let k = 0; k < 6; k++) expect(ajaeMove(t, k)).toBe(AJAE_MOVES[t][k % AJAE_MOVES[t].length]);
    }
    expect([...BODY_MOVES].sort()).toEqual(["crown", "gorilla", "kick", "mallet", "plane", "rage", "robot", "shove", "shuffle", "slam", "split", "waltz"]);
    // every body move knows the room it needs; the face's stand-ins are face moves
    for (const m of BODY_MOVES) expect(AJAE_ROOM[m]).toBeGreaterThan(0);
    for (const m of Object.values(AJAE_CRAMPED)) expect(BODY_MOVES.has(m)).toBe(false);
  });

  it("ponders the seat's call: meh and fold both open with the ponder, then take their own move (흠, the glare) in turn", () => {
    for (const t of ["meh", "fold"] as AjaeTier[]) {
      expect(AJAE_MOVES[t][0]).toBe("ponder");
      expect([0, 1, 2, 3, 4].map((k) => ajaeMove(t, k))).toEqual(["ponder", AJAE_MOVES[t][1], "ponder", AJAE_MOVES[t][1], "ponder"]);
      // face moves only: they play however far the page is scrolled
      for (const room of [96, 30, 0, -40]) expect(ajaeMove(t, 0, room)).toBe("ponder");
    }
    expect(AJAE_MOVES.meh[1]).toBe("hmm");
    expect(AJAE_MOVES.fold[1]).toBe("glare");
    expect(BODY_MOVES.has("ponder")).toBe(false);
    // the seat-dependent hands of the agreed examples ponder; a hand bad from every seat never does
    const k9 = typed("UTG", "K", "9");
    expect(ajaeStep(AJAE_START, k9, pickSuited(k9, false), "mid", 9).cue).toMatchObject({ tier: "fold", move: "ponder" });
    const q9 = typed("CO", "Q", "9");
    expect(ajaeStep(AJAE_START, q9, pickSuited(q9, false), "mid", 9).cue).toMatchObject({ tier: "meh", move: "ponder" });
    const j4 = typed("CO", "J", "4");
    expect(ajaeStep(AJAE_START, j4, pickSuited(j4, false), "mid", 9).cue?.move).not.toBe("ponder");
  });

  it("goes into a rage for 72o, and only 72o: a body move of its own, beyond the trash moves; scrolled, the furious face (fume)", () => {
    expect(AJAE_MOVES.hammer).toEqual(["rage"]);
    expect(BODY_MOVES.has("rage")).toBe(true);
    for (const [t, moves] of Object.entries(AJAE_MOVES)) if (t !== "hammer") expect(moves as readonly string[]).not.toContain("rage");
    for (let k = 0; k < 3; k++) expect(ajaeMove("hammer", k)).toBe("rage");
    // it needs its room above the row like any body move; without it he boils over in the face, as trash does
    const need = AJAE_ROOM.rage!;
    expect(need).toBeGreaterThan(0);
    expect(ajaeMove("hammer", 0, need)).toBe("rage");
    expect(ajaeMove("hammer", 0, need - 1)).toBe("fume");
    expect(AJAE_CRAMPED.hammer).toBe("fume");
    expect(AJAE_CRAMPED.hammer).toBe(AJAE_CRAMPED.trash);
    const h = typed("BTN", "7", "2");
    expect(ajaeStep(AJAE_START, h, pickSuited(h, false), "mid", 9, need - 1).cue).toMatchObject({ tier: "hammer", move: "fume", low: true });
    expect(ajaeStep(AJAE_START, h, pickSuited(h, false), "mid", 9).cue).toMatchObject({ tier: "hammer", move: "rage" });
  });

  it("has no beer, no yawn and no doze left anywhere in the moves", () => {
    const all = [...Object.values(AJAE_MOVES).flat(), ...Object.values(AJAE_CRAMPED), ...BODY_MOVES, ...Object.keys(AJAE_ROOM)] as string[];
    for (const m of all) expect(m).not.toMatch(/beer|yawn|doze|sleep|sip|cheers|drink/);
  });

  it("plays what fits above the hand row when the page is scrolled under the stage bar (no headless dancing)", () => {
    // the page at the top: 96 px between the stage bar and the hand row, everything fits, the ball too
    const top = 96;
    for (const t of ["monster", "good", "meh", "fold", "trash", "hammer"] as AjaeTier[]) for (let k = 0; k < 3; k++) expect(ajaeMove(t, k, top)).toBe(ajaeMove(t, k));
    expect(top).toBeGreaterThanOrEqual(BALL_ROOM);
    expect(Math.max(...Object.values(AJAE_ROOM))).toBeLessThanOrEqual(top);
    // scrolled a little: the mallet overhead would be cut, so the next trash move that fits plays instead
    expect(ajaeMove("trash", 1, 60)).toBe("slam");
    expect(ajaeMove("trash", 0, 60)).toBe("kick");
    // the spin-hop needs more than the robot
    expect(ajaeMove("good", 0, 54)).toBe("robot");
    expect(ajaeMove("good", 1, 54)).toBe("robot");
    // scrolled far: the face does it, popping in its slot
    expect(ajaeMove("trash", 0, 30)).toBe("fume");
    expect(ajaeMove("good", 0, 30)).toBe("nod");
    expect(ajaeMove("monster", 0, 30)).toBe("cheer");
    expect(ajaeMove("fold", 1, 30)).toBe("glare");
    expect(ajaeMove("hammer", 0, 0)).toBe("fume");
    // the row itself under the stage bar (negative room): the face's own moves still take their turn
    expect(ajaeMove("fold", 1, -5)).toBe("glare");
    expect(ajaeMove("fold", 0, -5)).toBe("ponder");
    expect(ajaeMove("meh", 0, -20)).toBe("ponder");
    expect(ajaeMove("meh", 1, -20)).toBe("hmm");
    expect(ajaeMove("trash", 2, -5)).toBe("fume");
    // each body move plays from exactly the room it asks for, not a pixel less
    for (const [t, moves] of Object.entries(AJAE_MOVES) as [AjaeTier, readonly string[]][]) {
      moves.forEach((m, k) => {
        const need = AJAE_ROOM[m as keyof typeof AJAE_ROOM];
        if (need === undefined) return;
        expect(ajaeMove(t, k, need)).toBe(m);
        expect(ajaeMove(t, k, need - 1)).not.toBe(m);
      });
    }
    expect(ajaeMove("trash", 1, 74)).toBe("mallet");
    expect(ajaeMove("trash", 1, 73)).toBe("slam");
    // the cue: the dance without its ball below BALL_ROOM; the rotation counts the reaction whatever plays
    const jt = typed("UTG", "J", "T");
    const low = ajaeStep(AJAE_START, jt, pickSuited(jt, true), "mid", 9, BALL_ROOM - 1);
    expect(low.cue).toMatchObject({ move: "shuffle", noBall: true });
    expect(low.seen).toEqual({ good: 1 });
    expect(ajaeStep(AJAE_START, jt, pickSuited(jt, true), "mid", 9, BALL_ROOM).cue?.noBall).toBeUndefined();
    expect(ajaeStep(AJAE_START, jt, pickSuited(jt, true), "mid", 9).cue?.noBall).toBeUndefined();
    const j4 = typed("CO", "J", "4");
    expect(ajaeStep(AJAE_START, j4, pickSuited(j4, false), "mid", 9, 20).cue).toMatchObject({ tier: "trash", move: "fume", low: true });
  });

  it("pops the face smaller when the full pop would reach under the stage bar (cue.low), a face move only", () => {
    const k9 = typed("UTG", "K", "9");
    const k9o = pickSuited(k9, false);
    const fold = (room?: number) => ajaeStep(AJAE_START, k9, k9o, "mid", 9, room).cue!;
    expect(fold(POP_ROOM - 1)).toMatchObject({ move: "ponder", low: true });
    expect(fold(POP_ROOM).low).toBeUndefined();
    expect(fold(96).low).toBeUndefined();
    expect(fold().low).toBeUndefined();
    expect(fold(-10)).toMatchObject({ move: "ponder", low: true });
    // a body move never: it plays only with the room it needs, and its face comes in after it, in the slot
    const j4 = typed("CO", "J", "4");
    const kick = ajaeStep(AJAE_START, j4, pickSuited(j4, false), "mid", 9, POP_ROOM - 1).cue!;
    expect(kick).toMatchObject({ move: "kick" });
    expect(kick.low).toBeUndefined();
    // the full pop needs more room than any of the tiers' body moves but the mallet, and the ball more still
    for (const m of BODY_MOVES) if (m !== "mallet" && !SPECIAL_MOVES.has(m)) expect(AJAE_ROOM[m]).toBeLessThan(POP_ROOM);
    expect(POP_ROOM).toBeLessThan(BALL_ROOM);
  });

  it("shows nothing for a class restored from storage or opened to correct, and goes when the hand is saved", () => {
    // a reload: the editor comes back with the class, the 아재 starts empty
    const aa = typed("UTG", "A", "A");
    expect(ajaeSeen(AJAE_START, aa, "mid", 9)).toBe(AJAE_START);
    // a reaction stays while the draft it reacted to is on screen, at any seat
    const s = tap(AJAE_START, typed("UTG", "A"), aa);
    expect(ajaeSeen(s, aa, "mid", 9)).toBe(s);
    expect(ajaeSeen(s, withSeat(aa, "CO", 9), "mid", 9)).toBe(s);
    // the same class, but a saved hand opened to correct: not this reaction
    const h = fastHand(aa, "open", { ...emptyHand(null), id: "h1", createdAt: 1, updatedAt: 1 }, "mid", 9)!;
    const editing = startEdit({ stage: "mid", players: 9, draft: aa, parked: null }, h).draft;
    expect(ajaeKey(editing)).toBe("AA|h1");
    expect(ajaeSeen(s, editing, "mid", 9).cue).toBeNull();
    // saved: the next hand on screen has no class, he goes (the counts carry on)
    const next = afterSave({ stage: "mid", players: 9, draft: aa, parked: null }, h, [h]).draft;
    expect(ajaeSeen(s, next, "mid", 9)).toEqual({ ...s, cue: null });
    expect(ajaeQuiet(s).cue).toBeNull();
    expect(ajaeQuiet(s).n).toBe(1);
    expect(ajaeQuiet(AJAE_START)).toBe(AJAE_START);
  });

  it("never replays a reaction whose hand left the screen and came back (취소, the corrected hand deleted, its correction saved)", () => {
    // K9o typed at UTG: he ponders
    const k9 = typed("UTG", "K", "9");
    const k9o = pickSuited(k9, false);
    const pondered = tap(AJAE_START, k9, k9o);
    expect(pondered.cue).toMatchObject({ key: "K9o|", tier: "fold", move: "ponder" });
    // JTs from earlier opened to correct: K9o is put aside, the screen shows JTs and he goes
    const jts = fastHand(pickSuited(typed("UTG", "J", "T"), true), "open", { ...emptyHand(null), id: "h1", createdAt: 1, updatedAt: 1 }, "mid", 9)!;
    const correcting = startEdit({ stage: "mid", players: 9, draft: k9o, parked: null } satisfies FastState, jts);
    const seen = ajaeSeen(pondered, correcting.draft, "mid", 9);
    expect(seen.cue).toBeNull();
    // K9o back on screen, the same class at the same table: 취소, JTs deleted (삭제 or 지난 기록), the correction saved
    for (const back of [cancelEdit(correcting), forgetHands(correcting, ["h1"]), afterSave(correcting, jts, [jts])]) {
      expect(ajaeKey(back.draft)).toBe("K9o|");
      expect(ajaeSeen(seen, back.draft, "mid", 9).cue).toBeNull();
    }
    // typing it in again is mine: a new reaction, the fold's next move
    const again = tap(seen, k9, k9o);
    expect(again.cue).toMatchObject({ n: 2, key: "K9o|", move: "glare" });
    expect(again.cue?.settled).toBeUndefined();
  });

  it("settles for good once my seat, the stage or the table size changes the tier: going back doesn't replay it", () => {
    const k9 = typed("UTG", "K", "9");
    const k9o = pickSuited(k9, false);
    const s = tap(AJAE_START, k9, k9o);
    // the button opens K9o: the face shows its "good" at rest, and the reaction is over
    const btn = withSeat(k9o, "BTN", 9);
    const atBtn = ajaeSeen(tap(s, k9o, btn), btn, "mid", 9);
    expect(atBtn.cue).toMatchObject({ n: 1, cls: "K9o", tier: "fold", settled: true });
    // back at UTG, a fold again: still over
    const utg = withSeat(btn, "UTG", 9);
    expect(ajaeSeen(tap(atBtn, btn, utg), utg, "mid", 9)).toBe(atBtn);
    // a seat with the same tier changes nothing: AA is a monster everywhere
    const aa = typed("UTG", "A", "A");
    const a = tap(AJAE_START, typed("UTG", "A"), aa);
    expect(ajaeSeen(a, withSeat(aa, "BB", 9), "mid", 9)).toBe(a);
    // the stage: Q9o at CO is meh in the middle, a fold at 숏; back in the middle it stays over
    const q9 = typed("CO", "Q", "9");
    const q9o = pickSuited(q9, false);
    const q = tap(AJAE_START, q9, q9o);
    expect(q.cue?.tier).toBe("meh");
    expect(ajaeSeen(q, q9o, "mid", 9)).toBe(q);
    const atShort = ajaeSeen(q, q9o, "short", 9);
    expect(atShort.cue).toMatchObject({ tier: "meh", settled: true });
    expect(ajaeSeen(atShort, q9o, "mid", 9)).toBe(atShort);
    // the table size: 9 → 3 players puts me on the button (FastView's pickPlayers), where K9o is no fold
    expect(ajaeTier("K9o", "BTN", "mid", 3)).not.toBe("fold");
    expect(ajaeSeen(s, withSeat(k9o, "BTN", 3), "mid", 3).cue?.settled).toBe(true);
  });
});
