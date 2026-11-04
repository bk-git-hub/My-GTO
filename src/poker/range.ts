import { ALL_HANDS, RANKS, comboCount, type HandClass } from "./cards";

/** Frequency (0..1) per hand class. Missing hands = 0. */
export type Range = Record<HandClass, number>;

const rankIdx = (ch: string) => {
  const i = RANKS.indexOf(ch.toUpperCase());
  if (i < 0) throw new Error(`잘못된 랭크: ${ch}`);
  return i;
};

function pairName(r: number): HandClass {
  return RANKS[r] + RANKS[r];
}

function nonPairName(hi: number, lo: number, kind: string): HandClass[] {
  const base = RANKS[hi] + RANKS[lo];
  if (kind === "s" || kind === "o") return [base + kind];
  return [base + "s", base + "o"];
}

/** Expand one token (without frequency) to hand classes. */
function expandToken(token: string): HandClass[] {
  const t = token.trim();
  if (!t) return [];

  // Dash range: "22-66", "A2s-A5s", "KJs-K6s"
  if (t.includes("-")) {
    const [a, b] = t.split("-").map((x) => x.trim());
    if (a.length === 2 && b.length === 2 && a[0] === a[1] && b[0] === b[1]) {
      const lo = Math.min(rankIdx(a[0]), rankIdx(b[0]));
      const hi = Math.max(rankIdx(a[0]), rankIdx(b[0]));
      const out: HandClass[] = [];
      for (let r = lo; r <= hi; r++) out.push(pairName(r));
      return out;
    }
    if (a[0] !== b[0]) throw new Error(`범위 표기는 첫 랭크가 같아야 해요: ${t}`);
    const hi = rankIdx(a[0]);
    const kind = a[2] ?? "";
    const k1 = rankIdx(a[1]);
    const k2 = rankIdx(b[1]);
    const out: HandClass[] = [];
    for (let k = Math.min(k1, k2); k <= Math.max(k1, k2); k++) out.push(...nonPairName(hi, k, kind));
    return out;
  }

  const plus = t.endsWith("+");
  const body = plus ? t.slice(0, -1) : t;

  // Pairs: "77", "77+"
  if (body.length === 2 && body[0] === body[1]) {
    const r = rankIdx(body[0]);
    if (!plus) return [pairName(r)];
    const out: HandClass[] = [];
    for (let x = r; x <= 12; x++) out.push(pairName(x));
    return out;
  }

  // Non-pairs: "AKs", "AKo", "AK", "A2s+", "K9o+"
  const h = rankIdx(body[0]);
  const l = rankIdx(body[1]);
  const hi = Math.max(h, l);
  const lo = Math.min(h, l);
  const kind = body[2] ?? "";
  if (!plus) return nonPairName(hi, lo, kind);
  const out: HandClass[] = [];
  for (let k = lo; k < hi; k++) out.push(...nonPairName(hi, k, kind));
  return out;
}

/**
 * Parse a range string such as "66+, 55:0.5, A2s+, KTo+, QJo:0.4".
 * Later tokens override earlier ones, so "A2s+, A6s:0.5" works as expected.
 */
export function parseRange(text: string): Range {
  const range: Range = {};
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const [hands, freqText] = token.split(":");
    const freq = freqText === undefined ? 1 : Number(freqText);
    if (!Number.isFinite(freq) || freq < 0 || freq > 1) throw new Error(`잘못된 빈도: ${token}`);
    for (const hand of expandToken(hands)) range[hand] = freq;
  }
  return range;
}

/** Weighted combos in a range (out of 1326). */
export function rangeCombos(range: Range): number {
  let total = 0;
  for (const h of ALL_HANDS) total += (range[h] ?? 0) * comboCount(h);
  return total;
}

export function rangePercent(range: Range): number {
  return (rangeCombos(range) / 1326) * 100;
}

export const FULL_RANGE: Range = Object.fromEntries(ALL_HANDS.map((h) => [h, 1]));

const fmtFreq = (f: number) => String(Math.round(f * 100) / 100);

/** Runs of consecutive indices (descending order kept) where `full(i)` holds. */
function runs(idx: number[], full: (i: number) => boolean): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (const i of idx) {
    if (full(i)) cur.push(i);
    else if (cur.length) (out.push(cur), (cur = []));
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Write a range back as text, e.g. "TT+, 55:0.5, A2s+, KTs+, ATo+".
 * Frequencies below `min` are dropped; the result parses back with parseRange.
 */
export function rangeToString(range: Range, min = 0.005): string {
  const f = (h: HandClass) => {
    const x = range[h] ?? 0;
    return x < min ? 0 : x > 1 - min ? 1 : x;
  };
  const parts: string[] = [];
  const mixed: string[] = [];
  const desc = Array.from({ length: 13 }, (_, i) => 12 - i);

  // Pairs
  const pair = (r: number) => RANKS[r] + RANKS[r];
  for (const run of runs(desc, (r) => f(pair(r)) === 1)) {
    const [hi, lo] = [run[0], run[run.length - 1]];
    if (hi === 12 && run.length > 1) parts.push(`${pair(lo)}+`);
    else if (run.length > 1) parts.push(`${pair(hi)}-${pair(lo)}`);
    else parts.push(pair(hi));
  }
  for (const r of desc) if (f(pair(r)) > 0 && f(pair(r)) < 1) mixed.push(`${pair(r)}:${fmtFreq(f(pair(r)))}`);

  // Suited, then offsuit, by high card
  for (const kind of ["s", "o"]) {
    for (let hi = 12; hi >= 1; hi--) {
      const kickers = Array.from({ length: hi }, (_, i) => hi - 1 - i);
      const name = (k: number) => RANKS[hi] + RANKS[k] + kind;
      for (const run of runs(kickers, (k) => f(name(k)) === 1)) {
        const [top, low] = [run[0], run[run.length - 1]];
        if (top === hi - 1 && run.length > 1) parts.push(`${name(low)}+`);
        else if (run.length > 1) parts.push(`${name(top)}-${name(low)}`);
        else parts.push(name(top));
      }
      for (const k of kickers) if (f(name(k)) > 0 && f(name(k)) < 1) mixed.push(`${name(k)}:${fmtFreq(f(name(k)))}`);
    }
  }
  return [...parts, ...mixed].join(", ");
}
