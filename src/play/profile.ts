/**
 * The AI table's opponents (핸드 플레이): each seat plays our computed charts, moved by three small integer sliders.
 * loose −2..+2 (타이트 ↔ 루즈: how many hands continue), aggro −2..+2 (패시브 ↔ 공격: raise against call, bets),
 * sticky 0..2 (콜: how often a fold becomes a call when facing a bet or raise). All zero is the chart itself (GTO).
 * profileAdjust.ts turns a profile into the seat's actual moves; this file only holds the shapes, presets and the
 * sanitizer for stored values. Pure.
 */

export type Step2 = -2 | -1 | 0 | 1 | 2;
export type Sticky = 0 | 1 | 2;

export interface SeatProfile {
  loose: Step2;
  aggro: Step2;
  sticky: Sticky;
}

export type PresetId = "gto" | "pub" | "tight" | "aggro";

export const PRESETS: Record<PresetId, { label: string; badge: string; p: SeatProfile }> = {
  gto: { label: "GTO 차트", badge: "GTO", p: { loose: 0, aggro: 0, sticky: 0 } },
  pub: { label: "펍 아저씨", badge: "펍", p: { loose: 1, aggro: -1, sticky: 2 } },
  tight: { label: "타이트", badge: "타이트", p: { loose: -2, aggro: 0, sticky: 0 } },
  aggro: { label: "공격적", badge: "공격", p: { loose: 1, aggro: 2, sticky: 0 } },
};

export const PRESET_IDS: PresetId[] = ["gto", "pub", "tight", "aggro"];

/** The badge of a profile that matches no preset. */
export const CUSTOM_BADGE = "직접";

export const GTO_PROFILE: SeatProfile = PRESETS.gto.p;

/** A missing profile plays the chart. */
export const isGto = (p?: SeatProfile | null): boolean => !p || (p.loose === 0 && p.aggro === 0 && p.sticky === 0);

/** The preset a profile equals, or null ("직접"). */
export function presetOf(p: SeatProfile | null | undefined): PresetId | null {
  if (!p) return "gto";
  for (const id of PRESET_IDS) {
    const q = PRESETS[id].p;
    if (q.loose === p.loose && q.aggro === p.aggro && q.sticky === p.sticky) return id;
  }
  return null;
}

/** The short badge shown on a seat ("GTO", "펍", "직접"). */
export const badgeOf = (p: SeatProfile | null | undefined): string => {
  const id = presetOf(p);
  return id ? PRESETS[id].badge : CUSTOM_BADGE;
};

const step2 = (x: unknown): Step2 => {
  const n = typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0;
  return Math.max(-2, Math.min(2, n)) as Step2;
};
const sticky = (x: unknown): Sticky => {
  const n = typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0;
  return Math.max(0, Math.min(2, n)) as Sticky;
};

/** Any stored value as a valid profile: missing or broken fields are 0, numbers are rounded and clamped. */
export function profileOf(raw: unknown): SeatProfile {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { loose: step2(o.loose), aggro: step2(o.aggro), sticky: sticky(o.sticky) };
}

export const sameProfile = (a: SeatProfile, b: SeatProfile) => a.loose === b.loose && a.aggro === b.aggro && a.sticky === b.sticky;
