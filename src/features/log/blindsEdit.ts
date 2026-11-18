import { BLINDS_MAX, cleanBlinds, type Blinds } from "./levelClock";

/**
 * The blinds editor of a 직접 입력 tournament (빠른 기록's calculator sheet, the tournament sheet): three fields,
 * SB / BB / 앤티, typed on the in-app keypad. Pure: every step takes the editor's state and gives the next one.
 *
 * - The keypad types into the focused field (BB first); a field's first key replaces its value, calculator style.
 * - Until SB or 앤티 is typed it follows BB: SB = ⌊BB/2⌋ ("자동"), 앤티 = BB ("= BB"). Tapping it and typing makes
 *   it its own; 0 in 앤티 is no ante.
 * - "다음 ▸" fills all three from the 야자수 새틀 ladder (levelClock nextPubBlinds); 적용 still needed.
 */

export type BlindField = "sb" | "bb" | "ante";

export interface BlindsDraft {
  /** Each field's digits as typed ("" empty); a following field's text is kept but not used while it follows BB. */
  sb: string;
  bb: string;
  ante: string;
  /** The field the keypad types into. */
  focus: BlindField;
  /** SB / 앤티 typed by hand (else they follow BB). */
  ownSb: boolean;
  ownAnte: boolean;
  /** The next key replaces the focused field's value. */
  fresh: boolean;
}

/** At most this many digits a field (BLINDS_MAX: 99,999,999). */
const MAX_DIGITS = String(BLINDS_MAX).length;

const text = (n: number | null | undefined): string => (n === null || n === undefined ? "" : String(n));
const num = (t: string): number | null => (/^\d+$/.test(t) ? Number(t) : null);

/** The SB that follows a big blind: half of it, rounded down. */
export const autoSb = (bb: number): number => Math.floor(bb / 2);

/** The editor for blinds as set (null: not set yet): BB focused, SB / 앤티 following BB where they match its rule. */
export function blindsDraft(b: Blinds | null): BlindsDraft {
  if (!b) return { sb: "", bb: "", ante: "", focus: "bb", ownSb: false, ownAnte: false, fresh: true };
  return { sb: text(b.sb), bb: text(b.bb), ante: text(b.ante), focus: "bb", ownSb: b.sb !== autoSb(b.bb), ownAnte: b.ante !== b.bb, fresh: true };
}

/** What the three fields read now (a following field: its value from BB), and which follow BB. Null: empty. */
export function blindsShown(d: BlindsDraft): { sb: number | null; bb: number | null; ante: number | null; autoSb: boolean; autoAnte: boolean } {
  const bb = num(d.bb);
  return {
    bb,
    sb: d.ownSb ? num(d.sb) : bb === null ? null : autoSb(bb),
    ante: d.ownAnte ? num(d.ante) : bb,
    autoSb: !d.ownSb,
    autoAnte: !d.ownAnte,
  };
}

/** A key typed into a field's text: digits ("0"–"9", "00", "000"); a leading 0 gives way; "00" / "000" on nothing or 0 do nothing; at most 8 digits. */
function typed(t: string, key: string): string {
  if (!/^\d{1,3}$/.test(key)) return t;
  if (key.length > 1 && (t === "" || t === "0")) return t;
  const next = t === "0" ? key : t + key;
  return next.length > MAX_DIGITS ? t : next;
}

/** A digit key into the focused field (the first key after focusing replaces it; SB / 앤티 typed become their own). */
export function blindsKey(d: BlindsDraft, key: string): BlindsDraft {
  const f = d.focus;
  const was = d.fresh ? "" : f === "sb" && !d.ownSb ? "" : f === "ante" && !d.ownAnte ? "" : d[f];
  const t = typed(was, key);
  if (t === was) return d;
  return { ...d, [f]: t, fresh: false, ...(f === "sb" ? { ownSb: true } : f === "ante" ? { ownAnte: true } : {}) };
}

/** ⌫ on the focused field: its last digit (a field following BB becomes its own, from the value it showed). */
export function blindsBack(d: BlindsDraft): BlindsDraft {
  const f = d.focus;
  const shown = blindsShown(d);
  const cur = f === "sb" ? text(shown.sb) : f === "ante" ? text(shown.ante) : d.bb;
  if (!cur && f === "bb") return d.fresh ? { ...d, fresh: false } : d;
  return { ...d, [f]: cur.slice(0, -1), fresh: false, ...(f === "sb" ? { ownSb: true } : f === "ante" ? { ownAnte: true } : {}) };
}

/** A field tapped: the keypad types into it, its first key replacing what it shows. */
export const blindsFocus = (d: BlindsDraft, f: BlindField): BlindsDraft => ({ ...d, focus: f, fresh: true });

/** "다음 ▸" (or any blinds offered): all three fields filled, BB focused, nothing typed yet. */
export const blindsFill = (b: Blinds): BlindsDraft => blindsDraft(b);

/** The blinds the editor gives, or why not: "bb" (no big blind), "sb" (no small blind), "sbBig" (SB over BB). */
export function blindsOut(d: BlindsDraft): { blinds: Blinds } | { why: "bb" | "sb" | "sbBig" } {
  const s = blindsShown(d);
  if (s.bb === null || s.bb < 1) return { why: "bb" };
  if (s.sb === null || s.sb < 1) return { why: "sb" };
  if (s.sb > s.bb) return { why: "sbBig" };
  const b = cleanBlinds({ sb: s.sb, bb: s.bb, ante: s.ante ?? 0 });
  return b ? { blinds: b } : { why: "bb" };
}

/** Why 적용 waits, as its button says it. */
export const BLINDS_WHY: Record<"bb" | "sb" | "sbBig", string> = { bb: "BB를 넣어 주세요", sb: "SB를 넣어 주세요", sbBig: "SB가 BB보다 커요" };
