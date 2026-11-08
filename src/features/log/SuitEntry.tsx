import { useRef, useState } from "react";
import { handClassOf, rankOf, RANKS, suitOf, type Card } from "../../poker/cards";
import { holeClass, holeGuessed, type LoggedHand } from "./handLog";
import { CardText, RankKeys } from "./inputs";
import { flopFromRanks, holeFromRanks, nextBoardCard, type FlopTexture, type HoleKind, type NextSuitMode } from "./suitGuess";

/**
 * Entering cards whose suits aren't remembered ("무늬 모름"): the ranks on a keypad, then what is
 * remembered about the suits (수딧 / 오프수트, or the flop's 레인보우 / 투톤 / 모노톤, the turn's 새 무늬 /
 * 플러시 무늬). suitGuess.ts picks concrete cards that clash with nothing known; the hand marks them as guessed.
 */

const rankIndex = (k: string) => RANKS.indexOf(k);
const byRank = (a: number, b: number) => b - a;

/** What the hole entry reports: the cards, and whether their suits were guessed (with what was remembered). */
export interface HoleValue {
  hole: Card[];
  guessed: boolean;
  holeKind?: HoleKind;
}

const KIND_LABEL: Record<HoleKind, string> = { suited: "수딧", offsuit: "오프수트", unknown: "모름" };

type EntryMode = "exact" | "ranks";
const MODE_KEY = "pubaj.holeMode";

/**
 * The hole entry's last mode per kind of hand (mine / another player's), so someone collecting hands
 * without suits doesn't tap 무늬 모름 on every new hand. Kept for the session (sessionStorage, which a
 * private window may refuse: then for as long as the page is open).
 */
const lastMode: Record<"mine" | "other", EntryMode> = (() => {
  try {
    const x = JSON.parse(sessionStorage.getItem(MODE_KEY) ?? "{}") as Record<string, unknown>;
    return { mine: x.mine === "ranks" ? "ranks" : "exact", other: x.other === "ranks" ? "ranks" : "exact" };
  } catch {
    return { mine: "exact", other: "exact" };
  }
})();
function rememberMode(kind: "mine" | "other", mode: EntryMode) {
  lastMode[kind] = mode;
  try {
    sessionStorage.setItem(MODE_KEY, JSON.stringify(lastMode));
  } catch {
    /* no session storage */
  }
}

/**
 * The hole cards: exact text on the card keypad, or with "무늬 모름" two ranks and then 수딧 / 오프수트
 * (모름 if not even that); a pair needs nothing more. `onChange` gets `clean` false while the entry is
 * mid-way (one rank, or two waiting for 수딧/오프수트): the cards on file stay as they are then.
 * `taken`: known cards, which the exact field refuses; `avoid`: guessed cards elsewhere on the hand,
 * which a guess steers clear of too. An empty entry opens in the mode last used for that kind of hand.
 */
export function HoleEntry(props: { h: Pick<LoggedHand, "hole" | "guess" | "holeKind" | "kind">; taken: Card[]; avoid?: Card[]; onChange: (v: HoleValue, clean: boolean) => void; onValid?: (ok: boolean) => void }) {
  const { h, taken, avoid = [], onChange, onValid } = props;
  const guessed = holeGuessed(h);
  const kind = h.kind === "other" ? "other" : "mine";
  const [mode, setModeRaw] = useState<EntryMode>(() => (guessed ? "ranks" : h.hole.length ? "exact" : lastMode[kind]));
  const setMode = (m: EntryMode) => {
    rememberMode(kind, m);
    setModeRaw(m);
  };
  const ranksOf = (hole: Card[] = h.hole) => (hole.length === 2 ? [rankOf(hole[0]), rankOf(hole[1])].sort(byRank) : []);
  const [ranks, setRanks] = useState<number[]>(() => ranksOf());
  const [err, setErr] = useState("");
  /**
   * The last whole hand this entry showed (on file, or just filled in): put back when the other entry
   * opens while this one is mid-way, so switching never reads as the cards being cleared.
   */
  const lastWhole = useRef<HoleValue | null>(h.hole.length === 2 ? { hole: h.hole, guessed, holeKind: h.holeKind } : null);
  /** The exact field's last clean report. */
  const exactClean = useRef(true);
  const pair = ranks.length === 2 && ranks[0] === ranks[1];
  const askKind = ranks.length === 2 && !pair;
  // The guessed cards on file are the ranks on screen.
  const filled = guessed && ranks.length === 2 && [...h.hole].map(rankOf).sort(byRank).join() === [...ranks].sort(byRank).join();

  function fill(rs: number[], kind: HoleKind) {
    const [hi, lo] = [...rs].sort(byRank);
    const cards = holeFromRanks(hi, lo, kind, [...taken, ...avoid]) ?? holeFromRanks(hi, lo, kind, taken);
    if (!cards) {
      setErr("그 카드는 이미 나왔어요");
      onChange({ hole: [], guessed: false }, false);
      return;
    }
    setErr("");
    lastWhole.current = { hole: cards, guessed: true, holeKind: hi === lo ? undefined : kind };
    onChange(lastWhole.current, true);
  }
  function setRanksTo(next: number[]) {
    setErr("");
    setRanks(next);
    // A pair needs no 수딧/오프수트.
    if (next.length === 2 && next[0] === next[1]) return fill(next, "unknown");
    // Mid-way the cards on file stay; with every rank cleared there are none.
    if (next.length === 0) lastWhole.current = null;
    onChange({ hole: [], guessed: false }, next.length === 0);
  }
  const toggle = () => {
    setErr("");
    const midway = mode === "exact" ? !exactClean.current || h.hole.length === 1 : !filled && h.hole.length !== 2;
    const back = midway ? lastWhole.current : null;
    if (back) onChange(back, true);
    exactClean.current = true;
    if (mode === "exact") {
      setRanks(ranksOf(back ? back.hole : h.hole));
      setMode("ranks");
    } else setMode("exact");
  };

  return (
    <div className={`hole-entry ${mode}`}>
      {mode === "exact" ? (
        <CardText
          cards={guessed ? [] : h.hole}
          max={2}
          taken={taken}
          onChange={(cards, clean) => {
            if (clean && cards.length === 2) lastWhole.current = { hole: cards, guessed: false };
            if (clean && cards.length === 0) lastWhole.current = null;
            onChange({ hole: cards, guessed: false }, clean);
          }}
          onValid={(ok) => {
            exactClean.current = ok;
            onValid?.(ok);
          }}
          hint={guessed ? `지금은 ${holeClass(h)} (무늬 추정) · 정확히 넣으면 바뀌어요` : h.hole.length === 2 ? handClassOf(h.hole[0], h.hole[1]) : undefined}
        />
      ) : (
        <div className="suitless">
          <button type="button" className={`suitless-field${filled ? " ok" : ""}`} onClick={toggle} aria-label="무늬 직접 입력으로 바꾸기">
            <span className="sl-ranks">{ranks.length ? ranks.map((r) => RANKS[r]).join(" ") : <i>숫자 두 개</i>}</span>
            {filled ? (
              <>
                <b>{holeClass(h)}</b>
                <small>무늬 추정 · 눌러서 고치기</small>
              </>
            ) : (
              <small>{askKind ? "수딧? 오프수트?" : "무늬 모름"}</small>
            )}
          </button>
          {err && <div className="cardtext-msg bad">{err}</div>}
          <div className="cardkeys">
            <RankKeys ranksOff={ranks.length >= 2} backOff={!ranks.length} onRank={(k) => setRanksTo([...ranks, rankIndex(k)])} onBack={() => setRanksTo(ranks.slice(0, -1))} />
            <div className="kinds">
              {(["suited", "offsuit", "unknown"] as const).map((k) => (
                <button key={k} type="button" className={`${k === "unknown" ? "small" : ""}${filled && h.holeKind === k ? " on" : ""}`} disabled={!askKind} onClick={() => fill(ranks, k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <button type="button" className="suit-toggle" onClick={toggle}>
        {mode === "exact" ? (
          <>
            무늬 모름 <small>수딧·오프수트만 기억나요</small>
          </>
        ) : (
          "무늬 알면 직접 입력"
        )}
      </button>
    </div>
  );
}

const FLOP_TEXTURES: [Exclude<FlopTexture, "unknown">, string][] = [
  ["rainbow", "레인보우"],
  ["twotone", "투톤"],
  ["monotone", "모노톤"],
];
const NEXT_MODES: [Exclude<NextSuitMode, "unknown">, string][] = [
  ["newSuit", "새 무늬"],
  ["flushSuit", "플러시 무늬"],
];

/**
 * A street's board cards from their ranks alone: the flop's three ranks then 레인보우 / 투톤 / 모노톤,
 * the turn's or river's rank then 새 무늬 / 플러시 무늬. `board` holds the cards before this street;
 * `onFill` gets this street's cards (to be marked as guessed).
 */
export function BoardRanks(props: { street: "flop" | "turn" | "river"; board: Card[]; taken: Card[]; onFill: (cards: Card[]) => void }) {
  const { street, board, taken, onFill } = props;
  const flop = street === "flop";
  const need = flop ? 3 : 1;
  const [ranks, setRanks] = useState<number[]>([]);
  const [err, setErr] = useState("");
  const full = ranks.length === need;
  const paired = flop && new Set(ranks).size < ranks.length;

  const fillFlop = (tex: FlopTexture) => {
    const cards = flopFromRanks(ranks as [number, number, number], tex, [...taken, ...board]);
    if (cards) onFill(cards);
    else setErr("이미 나온 카드와 겹쳐요");
  };
  const fillNext = (mode: NextSuitMode) => {
    const c = nextBoardCard(ranks[0], board, mode, taken);
    if (c !== null) onFill([c]);
    else setErr("이미 나온 카드와 겹쳐요");
  };
  const label = flop ? "플랍 숫자 세 개" : `${street === "turn" ? "턴" : "리버"} 숫자 하나`;

  return (
    <div className="suitless board">
      <div className="suitless-field">
        <span className="sl-ranks">{ranks.length ? ranks.map((r) => RANKS[r]).join(" ") : <i>{label}</i>}</span>
        <small>{full ? (flop ? "무늬는 어땠어요?" : "무늬는?") : "무늬 모름"}</small>
      </div>
      {err && <div className="cardtext-msg bad">{err}</div>}
      <div className="cardkeys">
        <RankKeys ranksOff={full} backOff={!ranks.length} onRank={(k) => (setErr(""), setRanks([...ranks, rankIndex(k)]))} onBack={() => (setErr(""), setRanks(ranks.slice(0, -1)))} />
        <div className={`kinds n${flop ? 3 : 2}`}>
          {flop
            ? FLOP_TEXTURES.map(([t, l]) => (
                <button key={t} type="button" disabled={!full || (t === "monotone" && paired)} onClick={() => fillFlop(t)}>
                  {l}
                </button>
              ))
            : NEXT_MODES.map(([m, l]) => (
                <button key={m} type="button" disabled={!full} onClick={() => fillNext(m)}>
                  {l}
                </button>
              ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A guessed two-tone flop: which two cards share the suit, as chips ("K9 · K2 · 92"), the one now
 * picked lit. Null unless all three flop cards were guessed and exactly two share a suit.
 */
export function FlopPairFix(props: { board: Card[]; guessed: number[]; taken: Card[]; onFix: (flop: Card[]) => void }) {
  const { board, guessed, taken, onFix } = props;
  if (board.length !== 3 || ![0, 1, 2].every((i) => guessed.includes(i))) return null;
  const suits = board.map(suitOf);
  if (new Set(suits).size !== 2) return null;
  const ranks = board.map(rankOf) as [number, number, number];
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const options = pairs.filter(([i, j]) => ranks[i] !== ranks[j]);
  return (
    <div className="flop-pair">
      <span>투톤 · 같은 무늬</span>
      {options.map(([i, j]) => {
        const on = suits[i] === suits[j];
        return (
          <button
            key={`${i}${j}`}
            type="button"
            className={on ? "on" : ""}
            onClick={() => {
              if (on) return;
              const cards = flopFromRanks(ranks, "twotone", taken, [i, j]);
              if (cards) onFix(cards);
            }}
          >
            {RANKS[ranks[i]]}
            {RANKS[ranks[j]]}
          </button>
        );
      })}
    </div>
  );
}
