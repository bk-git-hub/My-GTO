import { levelRow, levelStartMinutes, type Blinds, type BreakRow, type LevelRow } from "./levelClock";

/**
 * Ready-made blind structures for 빠른 기록's tournaments, next to 야자수 새틀 (PUB_SCHEDULE) and 직접 입력: the
 * WPL 메인 이벤트's three days, copied row by row from the official guide (9th Holdem Masters, pages 3–4:
 * static.winjoygame.com/wpl/v1/files/9th_HoldemMasters.pdf). Every ante is a BB ante as big as the big blind.
 * The level follows the clock from the day's fixed start, through the breaks, exactly as 야자수 새틀's does
 * (levelAt with the day's own table). Pure data and lookups.
 */

/** A ready-made structure's id, as a tournament stores it (tourney.ts `preset`). */
export type PresetId = "wpl1" | "wpl2" | "wpl3";
export const PRESET_IDS: readonly PresetId[] = ["wpl1", "wpl2", "wpl3"];
export const isPresetId = (x: unknown): x is PresetId => typeof x === "string" && (PRESET_IDS as readonly string[]).includes(x);

/** A level whose BB ante is the big blind (every WPL level). */
const row = (level: number, sb: number, bb: number, minutes: number): LevelRow => ({ level, sb, bb, ante: bb, minutes });

/**
 * DAY1 (every flight: 10:00, 35,000 chips, 30-minute levels, 9-max, re-entry; late registration closes after
 * Lv12). Lv9/10 and Lv11/12 have the same blinds, as the sheet prints them.
 */
export const WPL_DAY1: LevelRow[] = [
  row(1, 100, 100, 30),
  row(2, 100, 200, 30),
  row(3, 200, 300, 30),
  row(4, 200, 400, 30),
  row(5, 300, 500, 30),
  row(6, 300, 600, 30),
  row(7, 400, 800, 30),
  row(8, 500, 1000, 30),
  row(9, 600, 1200, 30),
  row(10, 600, 1200, 30),
  row(11, 800, 1600, 30),
  row(12, 800, 1600, 30),
  row(13, 1000, 2000, 30),
  row(14, 1500, 2500, 30),
  row(15, 1500, 3000, 30),
  row(16, 2000, 4000, 30),
  row(17, 2500, 5000, 30),
  row(18, 3000, 6000, 30),
  row(19, 4000, 8000, 30),
  row(20, 5000, 10000, 30),
  row(21, 6000, 12000, 30),
  row(22, 8000, 16000, 30),
  row(23, 10000, 20000, 30),
  row(24, 12000, 24000, 30),
];

export const WPL_DAY1_BREAKS: BreakRow[] = [
  { afterLevel: 4, minutes: 15 },
  { afterLevel: 8, minutes: 15 },
  { afterLevel: 12, minutes: 20, note: "추가등록 마감 · 100칩 레이스" },
  { afterLevel: 16, minutes: 15 },
  { afterLevel: 20, minutes: 20, note: "500칩 레이스" },
];

/** DAY2 (DAY2-A 11/15, DAY2-B 12/12, 13:00): 40-minute levels from Lv19 (the sheet: "DAY1 현황에 따라 변동"), DAY1's stacks. */
export const WPL_DAY2: LevelRow[] = [
  row(19, 4000, 8000, 40),
  row(20, 5000, 10000, 40),
  row(21, 6000, 12000, 40),
  row(22, 8000, 16000, 40),
  row(23, 10000, 20000, 40),
  row(24, 15000, 30000, 40),
  row(25, 20000, 40000, 40),
  row(26, 25000, 50000, 40),
  row(27, 30000, 60000, 40),
  row(28, 40000, 80000, 40),
  row(29, 50000, 100000, 40),
  row(30, 60000, 120000, 40),
];

/** The last one (after Lv30) ends the day: the clock leaves it out, the table keeps it. */
export const WPL_DAY2_BREAKS: BreakRow[] = [
  { afterLevel: 22, minutes: 15 },
  { afterLevel: 26, minutes: 20, note: "1,000칩 레이스" },
  { afterLevel: 30, minutes: 20, note: "5,000칩 레이스" },
];

/**
 * DAY3 & FINAL (12/13, 13:00), from the lower blind of the two DAY2s. The sheet's note says "DAY3 블라인드 시간 :
 * 60 mins" while its table's column prints "40 mins" for Lv31–46: the note is the explicit one, so 60 here
 * (a level picked on the day moves on from the pick, so a wrong pace shows within a level and is put right there).
 */
export const WPL_DAY3: LevelRow[] = [
  row(31, 75000, 150000, 60),
  row(32, 100000, 200000, 60),
  row(33, 150000, 300000, 60),
  row(34, 200000, 400000, 60),
  row(35, 250000, 500000, 60),
  row(36, 300000, 600000, 60),
  row(37, 400000, 800000, 60),
  row(38, 500000, 1000000, 60),
  row(39, 600000, 1200000, 60),
  row(40, 800000, 1600000, 60),
  row(41, 1000000, 2000000, 60),
  row(42, 1500000, 3000000, 60),
  row(43, 2000000, 4000000, 60),
  row(44, 2500000, 5000000, 60),
  row(45, 3000000, 6000000, 60),
  row(46, 4000000, 8000000, 60),
];

export const WPL_DAY3_BREAKS: BreakRow[] = [
  { afterLevel: 34, minutes: 15 },
  { afterLevel: 38, minutes: 15 },
  { afterLevel: 42, minutes: 15 },
];

export interface StructurePreset {
  id: PresetId;
  /** "WPL 메인 DAY1": the tournament's name offered, and the structure's name in labels. */
  name: string;
  /** "DAY1": the sheet's button. */
  short: string;
  /** The fixed start ("10:00"), offered in the sheet. */
  clock: string;
  /** The starting stack offered (DAY1's 35,000); null: carried from the day before (typed by the player). */
  startStack: number | null;
  /**
   * Every level the day can be at, in order. A day that starts "where the day before ended" (DAY2, DAY3) also has
   * the day before's last levels, at its own pace, so a start below its sheet's first level can still be picked.
   */
  schedule: LevelRow[];
  breaks: BreakRow[];
  /** The level the day starts at unless one is picked (DAY2: 19, DAY3: 31). */
  startLevel: number;
  /** Its start level varies (the sheet and the level picker set it). */
  pickStart: boolean;
  /** The event, for the copied summary ("WPL 메인 이벤트"). */
  event: string;
  /**
   * How long after its start a day can still be joined, in minutes: a new tournament of it made later than that is
   * the next day's (set up the night before). DAY1: until late registration closes (the break after Lv12 ends,
   * 16:50); DAY2/DAY3 have none (everyone starts at 13:00): 6 hours, for one arriving late or set up late.
   */
  joinMinutes: number;
}

const WPL_EVENT = "WPL 메인 이벤트";

/** The day before's levels, at the day's own pace. */
const carried = (rows: LevelRow[], from: number, minutes: number): LevelRow[] => rows.filter((r) => r.level >= from).map((r) => ({ ...r, minutes }));

export const PRESETS: Record<PresetId, StructurePreset> = {
  wpl1: {
    id: "wpl1",
    name: "WPL 메인 DAY1",
    short: "DAY1",
    clock: "10:00",
    startStack: 35_000,
    schedule: WPL_DAY1,
    breaks: WPL_DAY1_BREAKS,
    startLevel: 1,
    pickStart: false,
    event: WPL_EVENT,
    joinMinutes: levelStartMinutes(13, WPL_DAY1, WPL_DAY1_BREAKS) ?? 410,
  },
  wpl2: {
    id: "wpl2",
    name: "WPL 메인 DAY2",
    short: "DAY2",
    clock: "13:00",
    startStack: null,
    // DAY1's levels after 추가등록 마감 (Lv13–18), in case DAY2 starts below Lv19; DAY1's break after Lv16 with them.
    schedule: [...carried(WPL_DAY1, 13, 40).filter((r) => r.level < 19), ...WPL_DAY2],
    breaks: [{ afterLevel: 16, minutes: 15 }, ...WPL_DAY2_BREAKS],
    startLevel: 19,
    pickStart: true,
    event: WPL_EVENT,
    joinMinutes: 6 * 60,
  },
  wpl3: {
    id: "wpl3",
    name: "WPL 메인 DAY3",
    short: "DAY3",
    clock: "13:00",
    startStack: null,
    // DAY3 starts at the lower blind of the two DAY2s: DAY2's levels (Lv19–30) come first, at DAY3's pace.
    schedule: [...carried(WPL_DAY2, 19, 60), ...WPL_DAY3],
    breaks: [...WPL_DAY2_BREAKS, ...WPL_DAY3_BREAKS],
    startLevel: 31,
    pickStart: true,
    event: WPL_EVENT,
    joinMinutes: 6 * 60,
  },
};

/** The preset by its id, or null. */
export const presetById = (id: unknown): StructurePreset | null => (isPresetId(id) ? PRESETS[id] : null);

/** The level a day of `p` starts at: `level` when the day has it (a start level that varies), else its own. */
export function presetStart(p: StructurePreset, level: unknown): number {
  return p.pickStart && typeof level === "number" && levelRow(level, p.schedule) ? level : p.startLevel;
}

/** The day's table from its start level on: what its clock runs through. */
export function presetFrom(p: StructurePreset, startLevel: unknown): LevelRow[] {
  const from = presetStart(p, startLevel);
  return p.schedule.filter((r) => r.level >= from);
}

/** How long a day of `p` from `startLevel` runs by its table, in minutes (its breaks included). */
export function presetSpanMinutes(p: StructurePreset, startLevel: unknown): number {
  const rows = presetFrom(p, startLevel);
  const last = rows[rows.length - 1];
  return last ? (levelStartMinutes(last.level, rows, p.breaks) ?? 0) + last.minutes : 0;
}

/** A level of `p` as 빠른 기록's chip maths take it: its sb, bb, BB ante and its number (`lv`); null off the table. */
export function presetBlinds(p: StructurePreset, level: number | null): Blinds | null {
  const r = levelRow(level, p.schedule);
  return r ? { sb: r.sb, bb: r.bb, ante: r.ante, lv: r.level } : null;
}

/** Any ready-made structure has this level number (a level picked in one is kept by 빠른 기록's editor). */
export const anyPresetLevel = (level: number): boolean => PRESET_IDS.some((id) => !!levelRow(level, PRESETS[id].schedule));
