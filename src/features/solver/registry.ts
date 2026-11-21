/**
 * Finding solver packs by the chart spot they solve (format.ts SpotTag): the picker's rows, and the lookups AI 테이블,
 * hand review and 빠른 기록 need ("is there a computed flop for a BTN open the BB called at 55bb?").
 */
import type { Catalog, CatalogPack, PlannedPack, SpotTag } from "../../presolve/format";

export type PotKind = SpotTag["pot"];

/** The stacks the app's solver-chart packs are solved at (everyone's stack at the start of the hand), in picker order. */
export const APP_STACKS: readonly number[] = [35, 55, 100];
/** The picker's first stack: the middle stage, where a pub tournament spends most of its hands. */
export const DEFAULT_STACK = 55;

/** The picker's rows per pot: who raised last preflop and who called. */
export const SPOT_ROWS: Record<PotKind, readonly { raiser: string; caller: string }[]> = {
  srp: [
    { raiser: "UTG", caller: "BB" },
    { raiser: "HJ", caller: "BB" },
    { raiser: "CO", caller: "BB" },
    { raiser: "BTN", caller: "BB" },
    { raiser: "SB", caller: "BB" },
  ],
  "3bp": [
    { raiser: "BB", caller: "BTN" },
    { raiser: "BTN", caller: "CO" },
    { raiser: "SB", caller: "BTN" },
  ],
};

export interface SpotQuery {
  stack: number;
  pot: PotKind;
  raiser: string;
  caller: string;
  /** Default "solver": the computed chart's packs. */
  chart?: SpotTag["chart"];
}

const matches = (s: SpotTag | undefined, q: SpotQuery) =>
  !!s && s.chart === (q.chart ?? "solver") && s.stack === q.stack && s.pot === q.pot && s.raiser === q.raiser && s.caller === q.caller;

export type SpotHit = { kind: "pack"; pack: CatalogPack } | { kind: "planned"; planned: PlannedPack };

/** The pack of a spot (with files), else the planned one, else null. */
export function findPack(catalog: Pick<Catalog, "packs" | "planned">, q: SpotQuery): SpotHit | null {
  const pack = catalog.packs.find((p) => matches(p.spot, q));
  if (pack) return { kind: "pack", pack };
  const planned = catalog.planned?.find((p) => matches(p.spot, q));
  return planned ? { kind: "planned", planned } : null;
}

/** "HJ 오픈 · BB 콜", "BB 3벳 · BTN 콜". */
export function spotLabel(spot: Pick<SpotTag, "pot" | "raiser" | "caller">): string {
  return `${spot.raiser} ${spot.pot === "3bp" ? "3벳" : "오픈"} · ${spot.caller} 콜`;
}

/** The stack of `stacks` closest to an effective stack (by ratio, so 45bb picks 55 over 35); null for none. */
export function nearestStack(stacks: readonly number[], effBb: number): number | null {
  if (!stacks.length || !(effBb > 0)) return null;
  let best = stacks[0];
  for (const s of stacks) if (Math.abs(Math.log(s / effBb)) < Math.abs(Math.log(best / effBb))) best = s;
  return best;
}

/** Packs that are not the computed chart's (the earlier cash and pub-chart packs, or any without a spot tag). */
export function otherPacks(catalog: Pick<Catalog, "packs">): CatalogPack[] {
  return catalog.packs.filter((p) => p.spot?.chart !== "solver");
}

/** The solver-chart stacks that have a pack or a planned pack. */
export function catalogStacks(catalog: Pick<Catalog, "packs" | "planned">): number[] {
  const s = new Set<number>();
  for (const p of [...catalog.packs, ...(catalog.planned ?? [])]) if (p.spot?.chart === "solver") s.add(p.spot.stack);
  return APP_STACKS.filter((x) => s.has(x));
}
