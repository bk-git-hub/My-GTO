import { describe, expect, it } from "vitest";
import { cleanTourney, cleanTourneys, MAX_TOURNEYS, mergeTourneys, withoutTourney, withTourney, type Tourney } from "./tourney";

const T = 1_800_000_000_000;
const rec = (id: string, extra: Partial<Tourney> = {}): Tourney => ({ id, createdAt: T, updatedAt: T, activeAt: T, name: "", memo: "", start: T, startStack: null, ...extra });

describe("빠른 기록 tournaments: a stored record", () => {
  it("keeps a valid record as it is, and drops one without an id or a time it was made", () => {
    const t = rec("t-1", { name: "수요일 펍", memo: "테이블 3", startSet: true, startStack: 50000, auto: true });
    expect(cleanTourney(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(cleanTourney({ ...t, id: "" })).toBeNull();
    expect(cleanTourney({ ...t, id: 5 })).toBeNull();
    expect(cleanTourney({ ...t, id: "x".repeat(65) })).toBeNull();
    expect(cleanTourney({ ...t, createdAt: "today" })).toBeNull();
    expect(cleanTourney(null)).toBeNull();
    expect(cleanTourney("t-1")).toBeNull();
  });

  it("fills missing times from when it was made, and trims and cuts the name and the memo", () => {
    const c = cleanTourney({ id: "t-2", createdAt: T, name: "  " + "가".repeat(50) + " ", memo: "m".repeat(600) })!;
    expect([c.updatedAt, c.activeAt, c.start]).toEqual([T, T, T]);
    expect(c.name).toBe("가".repeat(40));
    expect(c.memo).toHaveLength(500);
    expect(cleanTourney({ id: "t-3", createdAt: T, name: 7, memo: null })).toMatchObject({ name: "", memo: "" });
  });

  it("keeps a start stack only as a whole number of chips from 1 to 999,999,999; the marks only as true", () => {
    for (const bad of [0, -1, 1.5, "50000", 1e10, NaN, Infinity, null]) expect(cleanTourney({ ...rec("t"), startStack: bad })?.startStack).toBeNull();
    expect(cleanTourney({ ...rec("t"), startStack: 999_999_999 })?.startStack).toBe(999_999_999);
    const c = cleanTourney({ ...rec("t"), startSet: "yes", auto: 1 })!;
    expect(c).not.toHaveProperty("startSet");
    expect(c).not.toHaveProperty("auto");
  });

  it("keeps one record per id (the later edited; a tie: the later entry), oldest made first, at most MAX_TOURNEYS", () => {
    const a = rec("a", { createdAt: T + 2, name: "old" });
    const a2 = { ...a, updatedAt: T + 10, name: "new" };
    const b = rec("b", { createdAt: T + 1 });
    expect(cleanTourneys([a2, b, a, "junk", { id: "" }]).map((t) => [t.id, t.name])).toEqual([
      ["b", ""],
      ["a", "new"],
    ]);
    expect(cleanTourneys([a, { ...a, name: "same time, later entry" }])[0].name).toBe("same time, later entry");
    expect(cleanTourneys("nope")).toEqual([]);
    const many = Array.from({ length: MAX_TOURNEYS + 5 }, (_, i) => rec(`t${i}`, { createdAt: T + i }));
    const kept = cleanTourneys(many);
    expect(kept).toHaveLength(MAX_TOURNEYS);
    expect(kept[0].id).toBe("t5");
  });
});

describe("빠른 기록 tournaments: merging a backup and changing the list", () => {
  it("takes the later edited record of each id from either side (a tie: ours), and ignores garbage", () => {
    const ours = [rec("a", { updatedAt: T + 5, name: "ours" }), rec("b", { updatedAt: T + 5, name: "ours b" })];
    const theirs = [rec("a", { updatedAt: T + 9, name: "theirs" }), rec("b", { updatedAt: T + 5, name: "theirs b" }), rec("c", { name: "new" }), { id: 3 }];
    expect(mergeTourneys(ours, theirs).map((t) => t.name)).toEqual(["theirs", "ours b", "new"]);
    expect(mergeTourneys(ours, undefined).map((t) => t.name)).toEqual(["ours", "ours b"]);
    expect(mergeTourneys(undefined, "x")).toEqual([]);
  });

  it("adds or replaces one record, and takes one away (the field goes with the last)", () => {
    const s = { hands: [], tourneys: [rec("a")] };
    const added = withTourney(s, rec("b", { createdAt: T + 1 }));
    expect(added.tourneys.map((t) => t.id)).toEqual(["a", "b"]);
    expect(withTourney(added, rec("a", { name: "renamed" })).tourneys.map((t) => t.name)).toEqual(["renamed", ""]);
    const bare: { hands: never[]; tourneys?: Tourney[] } = { hands: [] };
    expect(withTourney(bare, rec("x")).tourneys).toHaveLength(1);
    expect(withoutTourney(added, "a").tourneys?.map((t) => t.id)).toEqual(["b"]);
    expect(withoutTourney(withoutTourney(added, "a"), "b")).toEqual({ hands: [] });
  });
});
