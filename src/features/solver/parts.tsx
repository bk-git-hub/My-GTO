import { RANKS, SUITS, SUIT_SYMBOL, rankOf, suitOf, type Card } from "../../poker/cards";
import { pct } from "./view";

/** A compact playing card for tables and combo lists. */
export function MiniCard({ card }: { card: Card }) {
  const suit = SUITS[suitOf(card)];
  return (
    <span className={`sv-mc s-${suit}`}>
      {RANKS[rankOf(card)]}
      <small>{SUIT_SYMBOL[suit]}</small>
    </span>
  );
}

export function MiniCards({ cards }: { cards: Card[] }) {
  return (
    <span className="sv-mcs">
      {cards.map((c) => (
        <MiniCard key={c} card={c} />
      ))}
    </span>
  );
}

/** A stacked bar of action frequencies (segments in action order). */
export function MixBar({ freq, colors, labels, thin = false }: { freq: number[] | null; colors: string[]; labels?: string[]; thin?: boolean }) {
  const total = freq ? freq.reduce((s, x) => s + (x > 0 ? x : 0), 0) : 0;
  return (
    <div className={`sv-bar ${thin ? "thin" : ""} ${total > 0 ? "" : "none"}`} role="img" aria-label={freq && labels ? labels.map((l, a) => `${l} ${pct(freq[a])}`).join(", ") : "데이터 없음"}>
      {freq &&
        total > 0 &&
        freq.map((f, a) =>
          f > 0 ? <i key={a} style={{ width: `${(f / total) * 100}%`, background: colors[a] }} title={labels ? `${labels[a]} ${pct(f, 1)}` : undefined} /> : null,
        )}
    </div>
  );
}

/** Action color swatches with labels and (optionally) frequencies. */
export function Legend({ labels, colors, freq }: { labels: string[]; colors: string[]; freq?: (number[] | null) }) {
  return (
    <div className="sv-legend">
      {labels.map((l, a) => (
        <span key={a}>
          <i style={{ background: colors[a] }} />
          {l}
          {freq && <b>{pct(freq[a])}</b>}
        </span>
      ))}
    </div>
  );
}
