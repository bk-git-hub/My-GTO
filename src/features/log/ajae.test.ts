import { describe, expect, it } from "vitest";
import { ALL_HANDS, RANKS } from "../../poker/cards";
import { AJAE_LINES, AJAE_SPECIAL, AJAE_START, ajaeKey, ajaeQuiet, ajaeSeen, ajaeStep, ajaeTier, laterSeats, lineSet, type AjaeState, type AjaeTier } from "./ajae";
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

  it("never kicks a hand any seat plays first in, at any stage or table size (K9o, A4o: a yawn at most)", () => {
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
    expect(s.cue).toMatchObject({ n: 1, cls: "AA", tier: "monster", line: "주머니 로켓!", key: "AA|" });
    // two different ranks wait for the suitedness
    const jt = typed("UTG", "J", "T");
    s = tap(AJAE_START, typed("UTG", "J"), jt);
    expect(s.cue).toBeNull();
    s = tap(s, jt, pickSuited(jt, true));
    expect(s.cue).toMatchObject({ n: 1, cls: "JTs", tier: "good", line: "좋지~" });
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
  });

  it("says the next line of the tier each time: three in a row cycle, AA and KK have their own", () => {
    const say = (seat: string, a: string, b: string, suited: boolean | null, s: AjaeState) => {
      const two = typed(seat, a, b);
      return suited === null ? tap(s, typed(seat, a), two) : tap(s, two, pickSuited(two, suited));
    };
    let s = AJAE_START;
    const folds: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = say("UTG", "K", "9", false, s);
      folds.push(s.cue!.line);
      s = say("CO", "J", "4", false, s);
      expect(s.cue!.tier).toBe("trash");
      expect(s.cue!.line).toBe(AJAE_LINES.kick[i]);
    }
    expect(folds).toEqual(["자리가 아쉽네", "뒤였으면 열었지", "패스~", "자리가 아쉽네"]);
    s = say("UTG", "K", "K", null, s);
    expect(s.cue!.line).toBe("킹 두 장!");
    s = say("UTG", "Q", "Q", null, s);
    expect(AJAE_LINES.monster).toContain(s.cue!.line);
    expect(s.cue!.n).toBe(10);
    expect(AJAE_SPECIAL).toEqual({ AA: "주머니 로켓!", KK: "킹 두 장!" });
    expect(lineSet("trash")).toBe("kick");
    // every tier has its lines
    for (const t of ["monster", "good", "meh", "fold", "trash", "hammer"] as AjaeTier[]) expect(AJAE_LINES[lineSet(t)].length).toBeGreaterThan(1);
    expect(AJAE_LINES.fold).toEqual(["자리가 아쉽네", "뒤였으면 열었지", "패스~"]);
    expect(AJAE_LINES.kick).toEqual(["에잉!", "저리 가!", "이걸 왜 줘", "퉤!"]);
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
    // saved: the next hand on screen has no class, he goes without a word (the counts carry on)
    const next = afterSave({ stage: "mid", players: 9, draft: aa, parked: null }, h, [h]).draft;
    expect(ajaeSeen(s, next, "mid", 9)).toEqual({ ...s, cue: null });
    expect(ajaeQuiet(s).cue).toBeNull();
    expect(ajaeQuiet(s).n).toBe(1);
    expect(ajaeQuiet(AJAE_START)).toBe(AJAE_START);
  });

  it("never replays a reaction whose hand left the screen and came back (취소, the corrected hand deleted, its correction saved)", () => {
    // K9o typed at UTG: he yawns
    const k9 = typed("UTG", "K", "9");
    const k9o = pickSuited(k9, false);
    const yawned = tap(AJAE_START, k9, k9o);
    expect(yawned.cue).toMatchObject({ key: "K9o|", tier: "fold" });
    // JTs from earlier opened to correct: K9o is put aside, the screen shows JTs and he goes
    const jts = fastHand(pickSuited(typed("UTG", "J", "T"), true), "open", { ...emptyHand(null), id: "h1", createdAt: 1, updatedAt: 1 }, "mid", 9)!;
    const correcting = startEdit({ stage: "mid", players: 9, draft: k9o, parked: null } satisfies FastState, jts);
    const seen = ajaeSeen(yawned, correcting.draft, "mid", 9);
    expect(seen.cue).toBeNull();
    // K9o back on screen, the same class at the same table: 취소, JTs deleted (삭제 or 지난 기록), the correction saved
    for (const back of [cancelEdit(correcting), forgetHands(correcting, ["h1"]), afterSave(correcting, jts, [jts])]) {
      expect(ajaeKey(back.draft)).toBe("K9o|");
      expect(ajaeSeen(seen, back.draft, "mid", 9).cue).toBeNull();
    }
    // typing it in again is mine: a new reaction, the next fold line
    const again = tap(seen, k9, k9o);
    expect(again.cue).toMatchObject({ n: 2, key: "K9o|", line: "뒤였으면 열었지" });
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
