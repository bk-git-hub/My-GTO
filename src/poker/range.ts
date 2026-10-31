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
