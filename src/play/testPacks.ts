/**
 * Tests only (never imported by the app): the real solver packs of public/packs, read synchronously with node:fs, as
 * the AI table's oracle source. No @types/node here: node:fs is reached through an untyped handle.
 */
import { decodeFlopFile, type DecodedFlop, type FlopFile, type Manifest } from "../presolve/format";
import { createOracle } from "./packOracle";
import { packIndex, type PackInfo } from "./packMatch";
import { ALL_HANDS, fullDeck, parseCards, type Card } from "../poker/cards";
import { fullWeights } from "./analysis";
import { act, CASH_TABLE, newGame, PUB_TABLE } from "./engine";
import { STAGE_STACK } from "./policy";
import { lineStepOf } from "./seatLine";
import { botPreflop, type PlayState, type PostflopOracle } from "./table";

const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const ROOT = new URL("../../public/packs/", import.meta.url);

export const readManifest = (): Manifest => JSON.parse(fs.readFileSync(new URL("manifest.json", ROOT), "utf8")) as Manifest;

let packs: PackInfo[] | null = null;
export const testPacks = (): PackInfo[] => (packs ??= packIndex(readManifest()));

const flops = new Map<string, DecodedFlop>();
export function readFlop(path: string): DecodedFlop {
  let f = flops.get(path);
  if (!f) {
    f = decodeFlopFile(JSON.parse(fs.readFileSync(new URL(path, ROOT), "utf8")) as FlopFile);
    flops.set(path, f);
  }
  return f;
}

/** An oracle that has every pack at hand: nothing ever needs loading. */
export const testOracle = (): PostflopOracle => createOracle({ packs: testPacks, flop: readFlop });

/**
 * A heads-up single raised pot at the flop, built action by action with each decision's GTO line step recorded:
 * everyone folds to `opener`, who opens at the chart's size, the others fold to the BB, who calls (`calls` adds cold
 * callers, `threeBet` a 3-bet by the BB that the opener calls). `holes` (seat → "AcQc") and `board` ("Kd7c2h") fix
 * cards. The hero sits at `hero` (default: the BB).
 */
export function srpAtFlop(
  mode: "pub" | "cash",
  stage: string,
  opener: string,
  o: { holes?: Record<string, string>; board?: string; hero?: string; calls?: string[]; threeBet?: boolean; limp?: boolean } = {},
): PlayState {
  const table = mode === "cash" ? CASH_TABLE : PUB_TABLE;
  const n = table.seats.length;
  const st = mode === "cash" ? "100bb" : stage;
  const fixed = new Map<number, [Card, Card]>();
  for (const [seat, cs] of Object.entries(o.holes ?? {})) fixed.set(table.seats.indexOf(seat), parseCards(cs) as [Card, Card]);
  const board = o.board ? parseCards(o.board) : [];
  const used = new Set([...board, ...[...fixed.values()].flat()]);
  const rest = fullDeck().filter((c) => !used.has(c));
  // newGame pops two cards per seat in seat order, then the flop.
  const pops: Card[] = [];
  for (let i = 0; i < n; i++) pops.push(...(fixed.get(i) ?? [rest.pop()!, rest.pop()!]));
  pops.push(...board);
  const deck = [...rest, ...pops.reverse()];
  const heroIdx = table.seats.indexOf(o.hero ?? "BB");
  const g = newGame(STAGE_STACK[st], heroIdx, deck, table);
  let s: PlayState = { mode, stageId: st, heroIdx, game: g, ranges: g.players.map(() => fullWeights()), decisions: [], botNotes: {}, profiles: g.players.map(() => null), lines: g.players.map(() => []), srcs: {} };
  let raises = 0;
  while (s.game.toAct !== null && s.game.street === "preflop") {
    const idx = s.game.toAct;
    const seat = s.game.players[idx].seat;
    const { base, ans, spot } = botPreflop(s, idx);
    const allInTo = spot.myBet + spot.myStack;
    const raiseTo = () => {
      const ms = ALL_HANDS.flatMap((h) => base.moves(h)).filter((m) => m.kind === "raise" && (m.to ?? 0) < allInTo - 1e-9);
      return ms.length ? ms[0].to : allInTo;
    };
    let move: { kind: "fold" | "call" | "raise"; to?: number };
    if (o.limp && seat === opener && raises === 0) move = { kind: "call" };
    else if (seat === opener && raises === 0) move = { kind: "raise", to: raiseTo() };
    else if (seat === "BB" && o.threeBet && raises === 1) move = { kind: "raise", to: raiseTo() };
    else if (seat === opener && raises === 2) move = { kind: "call" };
    else if (seat === "BB" || o.calls?.includes(seat)) move = { kind: "call" };
    else move = { kind: "fold" };
    if (move.kind === "raise") raises++;
    const sc = ans?.ok ? ans.scenario : mode === "cash" ? base.scenario : undefined;
    const step = lineStepOf(base, sc, move, allInTo);
    s = { ...s, game: act(s.game, move.kind, move.to), lines: s.lines!.map((l, i) => (i === idx ? [...l, step] : l)) };
  }
  return s;
}

const realRandom = Math.random;
/**
 * Seeds Math.random for a reproducible test (not vi.spyOn: a spy records every call, and the equity Monte Carlo makes
 * millions of them). `restoreRandom` puts the real one back.
 */
export function seedRandom(seed: number) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const restoreRandom = () => void (Math.random = realRandom);
