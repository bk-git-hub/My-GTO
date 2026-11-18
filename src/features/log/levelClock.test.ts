import { describe, expect, it } from "vitest";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import {
  clockText,
  durationText,
  estimateLabel,
  estimateLevel,
  levelAt,
  levelRow,
  levelSince,
  levelStartMinutes,
  localOffsetMinutes,
  parseClock,
  parseStartTime,
  PUB_BREAKS,
  PUB_SCHEDULE,
  startForHand,
  type LevelRow,
} from "./levelClock";

const MIN = 60_000;
const KST = 540;
/** Epoch ms of a Korea wall-clock time, built without the machine's timezone. */
const kst = (y: number, mo: number, d: number, h: number, m = 0, s = 0) => Date.UTC(y, mo - 1, d, h, m, s) - KST * MIN;
const START = kst(2026, 11, 7, 19, 0);
const at = (minutes: number) => levelAt(START, START + minutes * MIN);

describe("pub schedule data (docs/game-profile.md)", () => {
  it("has every level 1-30 with the BB ante equal to the big blind", () => {
    expect(PUB_SCHEDULE.map((r) => r.level)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const r of PUB_SCHEDULE) {
      expect(r.ante).toBe(r.bb);
      expect(r.sb).toBeLessThan(r.bb);
      expect(r.minutes).toBe(r.level <= 14 ? 20 : 12);
    }
    expect(levelRow(11)).toEqual({ level: 11, sb: 1500, bb: 2500, ante: 2500, minutes: 20 });
    expect(levelRow(14)).toEqual({ level: 14, sb: 2500, bb: 5000, ante: 5000, minutes: 20 });
    expect(levelRow(15)).toEqual({ level: 15, sb: 3000, bb: 6000, ante: 6000, minutes: 12 });
    expect(levelRow(27)).toEqual({ level: 27, sb: 75000, bb: 150000, ante: 150000, minutes: 12 });
    expect(levelRow(30)).toEqual({ level: 30, sb: 200000, bb: 400000, ante: 400000, minutes: 12 });
    expect(levelRow(31)).toBeNull();
    expect(levelRow(null)).toBeNull();
  });

  it("agrees with the quiz's blind table where both have the level", () => {
    for (const [lv, sb, bb] of BLIND_LEVELS) expect(levelRow(lv)).toMatchObject({ sb, bb });
  });

  it("has the six breaks", () => {
    expect(PUB_BREAKS).toEqual([
      { afterLevel: 3, minutes: 10 },
      { afterLevel: 6, minutes: 10 },
      { afterLevel: 10, minutes: 10 },
      { afterLevel: 14, minutes: 20 },
      { afterLevel: 19, minutes: 10 },
      { afterLevel: 25, minutes: 10 },
    ]);
  });

  it("matches the doc's elapsed times (Lv6 at 1h50, Lv10 at 3h20, Lv14 at 4h50)", () => {
    expect(at(110)).toMatchObject({ level: 6, phase: "level", minutesIn: 0 });
    expect(at(200)).toMatchObject({ level: 10, phase: "level", minutesIn: 0 });
    expect(at(290)).toMatchObject({ level: 14, phase: "level", minutesIn: 0 });
  });
});

describe("levelAt", () => {
  it("handles exact level starts and ends (half-open)", () => {
    expect(at(0)).toEqual({ level: 1, phase: "level", minutesIn: 0, minutesLeft: 20, nextLevel: 2, elapsedMinutes: 0 });
    expect(levelAt(START, START + 20 * MIN - 1)).toMatchObject({ level: 1, phase: "level", minutesIn: 19, minutesLeft: 1 });
    expect(at(20)).toMatchObject({ level: 2, phase: "level", minutesIn: 0, minutesLeft: 20, nextLevel: 3 });
    expect(at(59)).toMatchObject({ level: 3, phase: "level", minutesLeft: 1 });
  });

  it("reports a break as the level that just ended, with the next level", () => {
    expect(at(60)).toEqual({ level: 3, phase: "break", minutesIn: 0, minutesLeft: 10, nextLevel: 4, elapsedMinutes: 60 });
    expect(at(69)).toMatchObject({ level: 3, phase: "break", minutesIn: 9, minutesLeft: 1, nextLevel: 4 });
    expect(at(70)).toMatchObject({ level: 4, phase: "level", minutesIn: 0, minutesLeft: 20 });
    expect(at(130)).toMatchObject({ level: 6, phase: "break", nextLevel: 7 });
    expect(at(220)).toMatchObject({ level: 10, phase: "break", nextLevel: 11 });
    expect(at(230)).toMatchObject({ level: 11, phase: "level" });
    expect(at(390)).toMatchObject({ level: 19, phase: "break", minutesLeft: 10, nextLevel: 20 });
    expect(at(472)).toMatchObject({ level: 25, phase: "break", nextLevel: 26 });
    expect(at(482)).toMatchObject({ level: 26, phase: "level" });
  });

  it("switches to 12-minute levels after the 20-minute break at Lv14", () => {
    expect(at(309)).toMatchObject({ level: 14, phase: "level", minutesLeft: 1 });
    expect(at(310)).toMatchObject({ level: 14, phase: "break", minutesLeft: 20, nextLevel: 15 });
    expect(at(329)).toMatchObject({ level: 14, phase: "break", minutesIn: 19, minutesLeft: 1 });
    expect(at(330)).toMatchObject({ level: 15, phase: "level", minutesIn: 0, minutesLeft: 12, nextLevel: 16 });
    expect(at(341)).toMatchObject({ level: 15, phase: "level", minutesLeft: 1 });
    expect(at(342)).toMatchObject({ level: 16, phase: "level", minutesLeft: 12 });
    expect(at(378)).toMatchObject({ level: 19, phase: "level" });
    expect(at(400)).toMatchObject({ level: 20, phase: "level" });
  });

  it("rounds partial minutes: whole minutes in, minutes left rounded up", () => {
    const r = levelAt(START, START + 185 * MIN + 30_000);
    expect(r).toMatchObject({ level: 9, phase: "level", minutesIn: 5, minutesLeft: 15, elapsedMinutes: 185 });
  });

  it("before the start and after the last level", () => {
    expect(levelAt(START, START - 1)).toEqual({ level: null, phase: "before", minutesIn: 0, minutesLeft: 1, nextLevel: 1, elapsedMinutes: -1 });
    expect(at(-45)).toMatchObject({ level: null, phase: "before", minutesLeft: 45 });
    expect(at(541)).toMatchObject({ level: 30, phase: "level", minutesLeft: 1 });
    expect(at(541).nextLevel).toBeUndefined();
    expect(at(542)).toEqual({ level: 30, phase: "after", minutesIn: 0, minutesLeft: 0, elapsedMinutes: 542 });
    expect(at(600)).toMatchObject({ level: 30, phase: "after", minutesIn: 58 });
  });

  it("walks the whole schedule without gaps", () => {
    let prev = at(0);
    let levelsSeen = 1;
    for (let m = 1; m < 542; m++) {
      const r = at(m);
      expect(r.phase === "level" || r.phase === "break").toBe(true);
      if (r.phase === "level" && r.level !== prev.level) {
        expect(r.level).toBe((prev.phase === "break" ? prev.nextLevel : prev.level! + 1) as number);
        levelsSeen++;
      }
      prev = r;
    }
    expect(levelsSeen).toBe(30);
  });

  it("reuses the previous duration for a row without one, ignores a break after the last level", () => {
    const sched: LevelRow[] = [
      { level: 1, sb: 1, bb: 2, ante: 2, minutes: 15 },
      { level: 2, sb: 2, bb: 4, ante: 4, minutes: 0 },
      { level: 3, sb: 3, bb: 6, ante: 6, minutes: Number.NaN },
    ];
    const r = (m: number) => levelAt(0, m * MIN, sched, [{ afterLevel: 3, minutes: 30 }]);
    expect(r(15)).toMatchObject({ level: 2, minutesLeft: 15 });
    expect(r(30)).toMatchObject({ level: 3, minutesLeft: 15 });
    expect(r(45)).toMatchObject({ level: 3, phase: "after" });
    expect(levelAt(0, 5 * MIN, [], [])).toMatchObject({ level: null, phase: "after" });
    expect(levelAt(Number.NaN, 0)).toMatchObject({ level: null, phase: "before" });
  });
});

describe("a level picked, moved on by the clock", () => {
  it("knows when each level starts, the breaks before it included", () => {
    expect(levelStartMinutes(1)).toBe(0);
    expect(levelStartMinutes(3)).toBe(40);
    // the 10-minute break after Lv3, and after Lv6
    expect(levelStartMinutes(4)).toBe(70);
    expect(levelStartMinutes(7)).toBe(140);
    expect(levelStartMinutes(99)).toBeNull();
  });

  it("takes the pick as the level's start, and moves on from there by the schedule", () => {
    const t = START + 3 * 60 * MIN;
    expect(levelSince(4, t, t)).toBe(4);
    expect(levelSince(4, t, t + 19 * MIN)).toBe(4);
    expect(levelSince(4, t, t + 20 * MIN)).toBe(5);
    expect(levelSince(4, t, t + 60 * MIN)).toBe(6);
    // the break after Lv6 keeps Lv6, then Lv7
    expect(levelSince(6, t, t + 25 * MIN)).toBe(6);
    expect(levelSince(6, t, t + 30 * MIN)).toBe(7);
    // past the schedule: its last level
    expect(levelSince(29, t, t + 10 * 60 * MIN)).toBe(30);
    // a clock behind the pick, or a level off the schedule: the level itself
    expect(levelSince(4, t, t - MIN)).toBe(4);
    expect(levelSince(99, t, t + 60 * MIN)).toBe(99);
    expect(levelSince(4, Number.NaN, t)).toBe(4);
  });
});

describe("start time", () => {
  it("reads the usual clock formats", () => {
    const cases: [string, [number, number] | null][] = [
      ["19:00", [19, 0]],
      ["7:30", [7, 30]],
      ["19시", [19, 0]],
      ["19시 30분", [19, 30]],
      ["19시30", [19, 30]],
      ["7시 반", [7, 30]],
      ["1930", [19, 30]],
      ["730", [7, 30]],
      ["19", [19, 0]],
      [" 19 : 05 ", [19, 5]],
      ["19.30", [19, 30]],
      ["0:00", [0, 0]],
      ["오후 7시", [19, 0]],
      ["오후 7:30", [19, 30]],
      ["오후 12시", [12, 0]],
      ["오전 12시", [0, 0]],
      ["오전 9시", [9, 0]],
      ["7pm", [19, 0]],
      ["7:30 PM", [19, 30]],
      ["24:00", null],
      ["25시", null],
      ["19:60", null],
      ["2400", null],
      ["오전 19시", null],
      ["", null],
      ["저녁", null],
      ["19:0", null],
    ];
    for (const [text, want] of cases) expect(parseClock(text), text).toEqual(want ? { h: want[0], m: want[1] } : null);
    expect(clockText("1930")).toBe("19:30");
    expect(clockText("7시")).toBe("07:00");
    expect(clockText("x")).toBeNull();
  });

  it("puts the clock time on the hand's local day, with an explicit offset", () => {
    const noon = kst(2026, 11, 7, 12);
    expect(parseStartTime("19:00", noon, KST)).toBe(kst(2026, 11, 7, 19));
    expect(parseStartTime("7:30", noon, KST)).toBe(kst(2026, 11, 7, 7, 30));
    expect(parseStartTime("19시", noon, KST)).toBe(kst(2026, 11, 7, 19));
    expect(parseStartTime("1930", noon, KST)).toBe(kst(2026, 11, 7, 19, 30));
    // the local day, not the UTC day: 00:30 KST on the 8th is still the 7th in UTC
    expect(parseStartTime("19:00", kst(2026, 11, 7, 23, 30), KST)).toBe(kst(2026, 11, 7, 19));
    expect(parseStartTime("19:00", kst(2026, 11, 8, 0, 30), KST)).toBe(kst(2026, 11, 8, 19));
    // other offsets work the same way
    expect(parseStartTime("19:00", Date.UTC(2026, 10, 7, 12), 0)).toBe(Date.UTC(2026, 10, 7, 19));
    expect(parseStartTime("19:00", Date.UTC(2026, 10, 8, 2), -300)).toBe(Date.UTC(2026, 10, 8, 0)); // 21:00 on the 7th in UTC-5
    expect(parseStartTime("nope", noon, KST)).toBeNull();
    expect(parseStartTime("19:00", Number.NaN, KST)).toBeNull();
  });

  it("uses the runtime's timezone when no offset is given", () => {
    const day = Date.UTC(2026, 10, 7, 6);
    const t = parseStartTime("19:30", day)!;
    const d = new Date(t);
    const ref = new Date(day);
    expect([d.getHours(), d.getMinutes()]).toEqual([19, 30]);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([ref.getFullYear(), ref.getMonth(), ref.getDate()]);
    expect(localOffsetMinutes(day)).toBe(-ref.getTimezoneOffset());
    // and the explicit offset matching the runtime gives the same answer
    expect(parseStartTime("19:30", day, localOffsetMinutes(day))).toBe(t);
  });

  it("reads a start after midnight as the previous day's tournament", () => {
    // hand at 01:30 on the 8th, start 19:00: the tournament began on the 7th
    expect(startForHand("19:00", kst(2026, 11, 8, 1, 30), KST)).toBe(kst(2026, 11, 7, 19));
    // hand at 22:00: same day
    expect(startForHand("19:00", kst(2026, 11, 7, 22), KST)).toBe(kst(2026, 11, 7, 19));
    // up to two hours early still counts as the same day (the hand time is before the start)
    expect(startForHand("19:00", kst(2026, 11, 7, 17), KST)).toBe(kst(2026, 11, 7, 19));
    expect(startForHand("19:00", kst(2026, 11, 7, 17) - 1, KST)).toBe(kst(2026, 11, 6, 19));
    expect(startForHand("오후 7시", kst(2026, 11, 8, 2, 15), KST)).toBe(kst(2026, 11, 7, 19));
    expect(startForHand("??", kst(2026, 11, 8, 2), KST)).toBeNull();
    // runtime timezone path: the previous local day at 19:00
    const hand = new Date(2026, 10, 8, 1, 30).getTime();
    expect(startForHand("19:00", hand)).toBe(new Date(2026, 10, 7, 19, 0).getTime());
  });

  it("reads a start just after midnight as the next day's when the hand is at most two hours before it", () => {
    // hand at 23:00 on the 7th, start 00:30: the tournament starts on the 8th (not 22h30m ago)
    expect(startForHand("00:30", kst(2026, 11, 7, 23), KST)).toBe(kst(2026, 11, 8, 0, 30));
    expect(estimateLabel(estimateLevel("00:30", kst(2026, 11, 7, 23), KST)!)).toBe("시작 전 · 00:30 시작까지 1시간 30분");
    // exactly two hours before still counts; a minute more is the same day's start
    expect(startForHand("01:00", kst(2026, 11, 7, 23), KST)).toBe(kst(2026, 11, 8, 1));
    expect(startForHand("01:01", kst(2026, 11, 7, 23), KST)).toBe(kst(2026, 11, 7, 1, 1));
    // and once it has started, after midnight, it's the same day's start
    expect(startForHand("00:30", kst(2026, 11, 8, 1), KST)).toBe(kst(2026, 11, 8, 0, 30));
    // runtime timezone path
    expect(startForHand("00:30", new Date(2026, 10, 7, 23, 0).getTime())).toBe(new Date(2026, 10, 8, 0, 30).getTime());
  });

  it("rejects a non-finite offset instead of returning NaN", () => {
    expect(parseStartTime("19:00", kst(2026, 11, 7, 12), Number.NaN)).toBeNull();
    expect(startForHand("19:00", kst(2026, 11, 7, 22), Number.POSITIVE_INFINITY)).toBeNull();
    expect(estimateLevel("19:00", kst(2026, 11, 7, 22), Number.NaN)).toBeNull();
  });
});

describe("labels", () => {
  it("formats durations", () => {
    expect(durationText(185)).toBe("3시간 5분");
    expect(durationText(120)).toBe("2시간");
    expect(durationText(45)).toBe("45분");
    expect(durationText(0)).toBe("0분");
    expect(durationText(-3)).toBe("0분");
  });

  it("labels each phase in Korean", () => {
    expect(estimateLabel(at(185), "19:00")).toBe("Lv9 추정 · 19:00 시작 3시간 5분째");
    expect(estimateLabel(at(185))).toBe("Lv9 추정 · 시작 3시간 5분째");
    expect(estimateLabel(at(120), "1900")).toBe("Lv6 추정 · 19:00 시작 2시간째");
    expect(estimateLabel(at(225), "19:00")).toBe("휴식 중 (다음 Lv11) · 19:00 시작 3시간 45분째");
    expect(estimateLabel(at(-20), "19:00")).toBe("시작 전 · 19:00 시작까지 20분");
    expect(estimateLabel(at(-20))).toBe("시작 전");
    expect(estimateLabel(at(570), "19:00")).toBe("Lv30 이후 (구조표 끝) · 19:00 시작 9시간 30분째");
  });

  it("estimates from a start clock and the hand time in one step", () => {
    const late = estimateLevel("19:00", kst(2026, 11, 8, 1, 30), KST)!;
    expect(late).toMatchObject({ level: 19, phase: "break", nextLevel: 20, elapsedMinutes: 390, startClock: "19:00" });
    expect(estimateLabel(late)).toBe("휴식 중 (다음 Lv20) · 19:00 시작 6시간 30분째");
    const mid = estimateLevel("19시", kst(2026, 11, 7, 22, 5), KST)!;
    expect(estimateLabel(mid)).toBe("Lv9 추정 · 19:00 시작 3시간 5분째");
    const early = estimateLevel("1930", kst(2026, 11, 7, 19, 10), KST)!;
    expect(early).toMatchObject({ level: null, phase: "before", minutesLeft: 20 });
    expect(estimateLabel(early)).toBe("시작 전 · 19:30 시작까지 20분");
    expect(estimateLevel("later", kst(2026, 11, 7, 22), KST)).toBeNull();
  });
});
