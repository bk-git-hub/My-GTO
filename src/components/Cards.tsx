import { RANKS, SUITS, SUIT_SYMBOL, rankOf, suitOf, type Card } from "../poker/cards";

export function CardView({ card, size = "md" }: { card: Card; size?: "sm" | "md" | "lg" }) {
  const suit = SUITS[suitOf(card)];
  return (
    <span className={`card card-${size} suit-${suit}`}>
      <span className="card-rank">{RANKS[rankOf(card)]}</span>
      <span className="card-suit">{SUIT_SYMBOL[suit]}</span>
    </span>
  );
}

export function CardRow({ cards, size }: { cards: Card[]; size?: "sm" | "md" | "lg" }) {
  return (
    <span className="card-row">
      {cards.map((c) => (
        <CardView key={c} card={c} size={size} />
      ))}
    </span>
  );
}

/** Tap-to-select picker over the 52 cards. */
export function CardPicker({
  selected,
  max,
  disabled = [],
  onChange,
}: {
  selected: Card[];
  max: number;
  disabled?: Card[];
  onChange: (cards: Card[]) => void;
}) {
  const toggle = (c: Card) => {
    if (selected.includes(c)) onChange(selected.filter((x) => x !== c));
    else if (selected.length < max) onChange([...selected, c]);
    else if (max === 1) onChange([c]);
  };
  return (
    <div className="picker">
      {[0, 1, 2, 3].map((s) => (
        <div className="picker-row" key={s}>
          {Array.from({ length: 13 }, (_, i) => 12 - i).map((r) => {
            const c = r * 4 + s;
            const isSel = selected.includes(c);
            const isDis = !isSel && disabled.includes(c);
            return (
              <button
                key={c}
                type="button"
                className={`pick suit-${SUITS[s]} ${isSel ? "sel" : ""}`}
                disabled={isDis}
                onClick={() => toggle(c)}
                aria-label={`${RANKS[r]}${SUIT_SYMBOL[SUITS[s]]}`}
              >
                {RANKS[r]}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
