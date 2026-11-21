import { GTO_PROFILE, PRESETS, profileOf, type PresetId, type SeatProfile } from "../../play/profile";
import { createStore } from "../../state/store";

/**
 * The AI table's settings (핸드 플레이), stored under their own key "mygto.table": each opponent seat's profile and
 * where the button sits next hand. No other key changes shape. Physical seats run clockwise from me (0): seats[0] is
 * the seat on my left; the 6-max cash table uses seats[0..4].
 */

export const OPPONENTS = 8;

export interface TableSettings {
  v: 1;
  /** 8 opponents, seats[0] = the seat on my left, round the table. */
  seats: SeatProfile[];
  /** The physical seat (0 = me) holding the button next hand. */
  button: number;
  /** 바로 채점: the last decision's mark under the action card. */
  instant?: boolean;
}

export const DEFAULT_TABLE: TableSettings = { v: 1, seats: Array.from({ length: OPPONENTS }, () => ({ ...GTO_PROFILE })), button: 0 };

/** Any stored value as valid settings: createStore only merges shallowly and catches broken JSON. */
export function tableSettingsOf(raw: unknown): TableSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(o.seats) ? o.seats : [];
  const seats = Array.from({ length: OPPONENTS }, (_, i) => profileOf(list[i]));
  const b = typeof o.button === "number" && Number.isFinite(o.button) ? Math.floor(o.button) : 0;
  return { v: 1, seats, button: ((b % 9) + 9) % 9, ...(o.instant === true ? { instant: true } : {}) };
}

export const tableStore = createStore<TableSettings>("mygto.table", DEFAULT_TABLE);
/** The settings, always read through the sanitizer. */
export const readTable = (): TableSettings => tableSettingsOf(tableStore.get());
export const updateTable = (f: (t: TableSettings) => TableSettings) => tableStore.set((t) => f(tableSettingsOf(t)));

/** The engine index (preflop order, UTG first) of physical seat `p` with the button on physical seat `b`. */
export const engineIndex = (p: number, b: number, n: number) => (((p - b - 3) % n) + n) % n;
/** The physical seat of engine index `e`. */
export const physicalSeat = (e: number, b: number, n: number) => (((e + b + 3) % n) + n) % n;

/** Each engine seat's profile for a table of `n` with the button on `b` (null for me). */
export function profilesFor(t: TableSettings, b: number, n: number): (SeatProfile | null)[] {
  const out: (SeatProfile | null)[] = new Array(n).fill(null);
  for (let p = 0; p < n; p++) out[engineIndex(p, b, n)] = p === 0 ? null : t.seats[p - 1];
  return out;
}

/** "1 · 내 왼쪽", "2", … "8 · 내 오른쪽". */
export const seatName = (k: number, n: number) => (k === 1 ? "1 · 내 왼쪽" : k === n ? `${k} · 내 오른쪽` : String(k));

/** A random mix of the presets for `n` opponents (8: 2 GTO, 3 펍, 2 타이트, 1 공격). */
export function mixedSeats(n: number, rnd: () => number = Math.random): SeatProfile[] {
  const pool: PresetId[] = ["gto", "pub", "tight", "aggro", "pub", "gto", "tight", "pub"].slice(0, n) as PresetId[];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.map((id) => ({ ...PRESETS[id].p }));
}
