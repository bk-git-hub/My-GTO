import { Fragment, memo, useId, useMemo, type ReactNode } from "react";
import { ajaeOn, useSettings } from "../../state/settings";
import { ajaeTier, BODY_MOVES, SPECIAL_MOVES, type AjaeCue, type AjaeMove, type AjaeTier } from "./ajae";
import type { PreStage } from "./quickPre";
import "./ajae.css";

/**
 * The 아재 by 빠른 기록's hand class: wraps the class (`children`, the real .fast-class) and, while a
 * reaction (`cue`) is on, draws him next to it: the launch splash's 아재, bald with a mustache, shades, a red
 * polka-dot shirt and a gold chain. No words anywhere: faces, a jointed doll of him, props and symbols (a
 * mirror ball, chips, a mallet, cards, a thinking hand, bursts, ?, a thought cloud, notes, steam). Everything
 * he draws is absolutely positioned with pointer-events off, so the label row, the pad and everything below
 * keep their place, and every button stays live while he moves. The moves are CSS animations (ajae.css) that
 * start when their element mounts (keyed by the cue), so nothing here runs a timer.
 *
 * Two kinds of move (ajae.ts, AJAE_MOVES):
 * - a face move (meh's and fold's ponder, meh's 흠, fold's glare, and the cramped stand-ins): the chest-up
 *   face in its slot pops up big, makes the tier's face and settles small with it (fold: pondering, the hand
 *   on his chin and a thought cloud);
 * - a body move (monster's shove, good's shuffle or robot, trash's kick, mallet or slam, 72o's rage): the
 *   whole 아재 performs beside the class (`.aj-act`), then shrinks away in a puff as the face pops into the
 *   slot and stays there at rest. The trash and 72o faces stay furious: he never walks off;
 * - the pairs' shows (AA's plane, KK's gorilla or crown, QQ's waltz, JJ's jacks) are body moves too, bigger:
 *   they use the whole stage around the hand (fireworks, confetti, searchlights, rays, flashes) for up to 3 s,
 *   and the face waits for their end on their own clock (`.aj-for-<move>` on the slot).
 * With the page scrolled so far that the full pop would reach under the sticky stage bar, a face move pops
 * smaller, from the face's middle (cue.low).
 * When the tier on screen is no longer the one he reacted to (my seat or the stage changed), the face
 * shows the new one at rest, without moving, and never moves again for that reaction (cue.settled,
 * which ajaeSeen sets).
 */
export function AjaeReaction({ cue, seat, stage, players, off = false, children }: { cue: AjaeCue | null; seat: string; stage: PreStage; players: number; off?: boolean; children: ReactNode }) {
  const on = ajaeOn(useSettings().ajae) && !off;
  const cls = on ? cue?.cls : undefined;
  const tier = useMemo(() => (cls ? ajaeTier(cls, seat, stage, players) : null), [cls, seat, stage, players]);
  if (!on) return <>{children}</>;
  // He moves only while the tier on screen is still the one he reacted to, and never once it has changed.
  const playing = !!cue && !cue.settled && tier === cue.tier;
  const body = playing && BODY_MOVES.has(cue.move);
  return (
    <span className="ajae-host">
      {cue && tier && (
        <span key={cue.n} className={`aj-slot${playing ? (body ? ` aj-after${SPECIAL_MOVES.has(cue.move) ? ` aj-for-${cue.move}` : ""}` : cue.low ? " aj-pop aj-low" : " aj-pop") : ""}`} aria-hidden="true">
          <AjaeFace tier={tier} move={playing && !body ? cue.move : undefined} />
        </span>
      )}
      {cue && body && (
        <span key={`a${cue.n}`} className={`aj-act aj-mv-${cue.move}${cue.noBall ? " aj-noball" : ""}`} aria-hidden="true">
          <AjaeAct move={cue.move} />
        </span>
      )}
      {/* A body move moves the class too (its keyframes alternate by cue, so a move right after another restarts). */}
      <span className={`aj-jolt${cue && body ? ` aj-x-${cue.move} aj-j${cue.n % 2}` : ""}`}>{children}</span>
    </span>
  );
}

// ───────────── the art: original, inline SVG; no fixed ids (any number of him can be on the page), only useId's ─────────────

const INK = "#1b1400";
const SKIN = "#f2c48d";
/** The mustache and the brows: the only hair he has (his head is bald). */
const STACHE = "#3b2a1e";
const SHIRT = "#ff4d5a";
const GOLD = "#fbbf24";
const SHADE = "#0b0f14";
/** Denim and white sneakers: the legs have to read against the dark screen (the splash draws none). */
const PANTS = "#4f6a9e";
const SHOE = "#f8fafc";
const MUSTACHE =
  "M0 14 C -8 6, -24 5, -34 14 C -39 19, -46 19, -50 14 C -46 28, -28 31, -14 23 C -7 19, -3 18, 0 21 C 3 18, 7 19, 14 23 C 28 31, 46 28, 50 14 C 46 19, 39 19, 34 14 C 24 5, 8 6, 0 14 Z";
/** The shine on his bald head: a tilted oval (a path: an SVG rotate attribute would turn about ajae.css's transform-box) and a dot. */
const SHINE = "M-26.4 -42 A13 6.5 -18 1 1 -1.6 -50 A13 6.5 -18 1 1 -26.4 -42 Z";
const GLINT = "M-35 -32 Q -33.6 -22.4 -24 -21 Q -33.6 -19.6 -35 -10 Q -36.4 -19.6 -46 -21 Q -36.4 -22.4 -35 -32 Z";

/** A four-pointed sparkle centred on (x, y), r from the centre to a point. */
const spark = (x: number, y: number, r: number) => `M${x} ${y - r} l ${r * 0.3} ${r * 0.7} ${r * 0.7} ${r * 0.3} ${-r * 0.7} ${r * 0.3} ${-r * 0.3} ${r * 0.7} ${-r * 0.3} ${-r * 0.7} ${-r * 0.7} ${-r * 0.3} ${r * 0.7} ${-r * 0.3} Z`;

/** A cloud of steam centred on (x, y), about 2r wide (the colours come from the parent group). */
function Puff({ x, y, r, className }: { x: number; y: number; r: number; className: string }) {
  return (
    <g className={className}>
      <circle cx={x - r * 0.55} cy={y + r * 0.15} r={r * 0.55} />
      <circle cx={x + r * 0.5} cy={y + r * 0.2} r={r * 0.5} />
      <circle cx={x} cy={y - r * 0.25} r={r * 0.62} />
    </g>
  );
}

/** The anger mark: four bulging corners centred on (x, y), arms of length r. */
function Vein({ x, y, r }: { x: number; y: number; r: number }) {
  const a = r * 0.25;
  const b = r;
  const d = `M${x - b} ${y - a} Q${x - a} ${y - a} ${x - a} ${y - b} M${x + a} ${y - b} Q${x + a} ${y - a} ${x + b} ${y - a} M${x + b} ${y + a} Q${x + a} ${y + a} ${x + a} ${y + b} M${x - a} ${y + b} Q${x - a} ${y + a} ${x - b} ${y + a}`;
  return (
    <>
      <path d={d} fill="none" stroke={INK} strokeWidth={r * 0.62} strokeLinecap="round" />
      <path d={d} fill="none" stroke="#ff2d55" strokeWidth={r * 0.34} strokeLinecap="round" />
    </>
  );
}

/** His ears, drawn before the head (it covers their inner half): with no hair, they keep the bald head reading as a head. */
const Ears = () => (
  <>
    {[-1, 1].map((k) => (
      <g key={k}>
        <ellipse cx={43 * k} cy="-8" rx="7.5" ry="10.5" fill={SKIN} stroke={INK} strokeWidth="4" />
        <path d={`M${47 * k} -14 Q ${50.5 * k} -8 ${47 * k} -2`} fill="none" stroke="#c98a5a" strokeWidth="2.2" strokeLinecap="round" />
      </g>
    ))}
  </>
);
/** The shine on his bald head. */
const Shine = () => (
  <>
    <path d={SHINE} fill="#fff" opacity="0.75" />
    <circle cx="3" cy="-54.5" r="2.6" fill="#fff" opacity="0.6" />
  </>
);

/** The thought cloud's puffs (cx, cy, r), up and right of his head, inside the face's box (the fold's resting face shows it). */
const CLOUD: readonly (readonly [number, number, number])[] = [
  [24, -66, 7],
  [33, -73, 8.5],
  [44, -71.5, 7.5],
  [50, -64, 6],
  [39, -61.5, 7],
  [28, -60.5, 6],
];

function Shades({ className }: { className: string }) {
  return (
    <g className={className}>
      <rect x="-36" y="-22" width="30" height="20" rx="7" fill={SHADE} />
      <rect x="6" y="-22" width="30" height="20" rx="7" fill={SHADE} />
      <rect x="-8" y="-16" width="16" height="5" fill={SHADE} />
      <rect x="-31" y="-19" width="10" height="4" rx="2" fill="#fff" opacity="0.55" />
    </g>
  );
}

/**
 * The splash's 아재 (index.html, the J♥'s court picture, and the app icon) from the chest up, bald, with every
 * part the moves and the resting faces need (hidden unless the tier or the move shows it). `move`: the face move
 * playing now.
 */
const AjaeFace = memo(function AjaeFace({ tier, move }: { tier: AjaeTier; move?: AjaeMove }) {
  return (
    <span className={`aj-face aj-${tier}${move ? ` aj-play aj-mv-${move}` : ""}`}>
      <svg className="aj-fig" viewBox="-58 -84 116 136" xmlns="http://www.w3.org/2000/svg">
        <g className="aj-head">
          <path d="M-78 74 Q -66 40 -26 34 L 26 34 Q 66 40 78 74 Z" fill={SHIRT} stroke={INK} strokeWidth="4" />
          <g fill="#fff" opacity="0.9">
            <circle cx="-50" cy="58" r="5" />
            <circle cx="-30" cy="48" r="4" />
            <circle cx="44" cy="56" r="5" />
            <circle cx="28" cy="46" r="4" />
          </g>
          <path d="M-22 36 Q 0 62 22 36" fill="none" stroke={GOLD} strokeWidth="6" />
          <circle cx="0" cy="58" r="6" fill={GOLD} stroke={INK} strokeWidth="2" />
          <Ears />
          <ellipse cx="0" cy="-12" rx="44" ry="48" fill={SKIN} stroke={INK} strokeWidth="4" />
          <ellipse className="aj-flush" cx="0" cy="-13" rx="41" ry="45" fill="#ff3020" />
          <Shine />
          <g className="aj-eyes">
            <g transform="translate(-21 -12)">
              <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
              <g className="aj-pupils">
                <circle cx="1" cy="1" r="4.2" fill={INK} />
                <circle cx="2.5" cy="-0.8" r="1.4" fill="#fff" />
              </g>
            </g>
            <g transform="translate(21 -12)">
              <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
              <g className="aj-pupils">
                <circle cx="-1" cy="1" r="4.2" fill={INK} />
                <circle cx="0.5" cy="-0.8" r="1.4" fill="#fff" />
              </g>
            </g>
          </g>
          <path className="aj-brow-l" d="M-29 -14 Q -21 -19.5 -13 -15.5" fill="none" stroke={STACHE} strokeWidth="3.6" strokeLinecap="round" />
          <path className="aj-brow-r" d="M13 -15.5 Q 21 -19.5 29 -14" fill="none" stroke={STACHE} strokeWidth="3.6" strokeLinecap="round" />
          <path className="aj-smile" d="M-12 25 Q 0 35 12 25" fill="none" stroke="#6b2d1e" strokeWidth="3.4" strokeLinecap="round" />
          <path className="aj-flat" d="M-7 28 L 7 27" fill="none" stroke="#6b2d1e" strokeWidth="3" strokeLinecap="round" />
          <path className="aj-purse" d="M2 28.5 q 3.5 -3.2 7 0 q 3.5 3.2 7 0" fill="none" stroke="#6b2d1e" strokeWidth="3" strokeLinecap="round" />
          <g className="aj-teeth">
            <rect x="-15" y="20" width="30" height="13" rx="3.5" fill="#fff" stroke={INK} strokeWidth="3" />
            <path d="M-15 26.5 H15 M-7.5 20 V33 M0 20 V33 M7.5 20 V33" stroke={INK} strokeWidth="2.2" />
          </g>
          <path d={MUSTACHE} fill={STACHE} />
          {/* the thinking hand (the ponder): up from his sleeve, his chin on his fist, its knuckles to us */}
          <g className="aj-hand">
            <path d="M-42 74 L -33 61" stroke={INK} strokeWidth="24.5" strokeLinecap="round" />
            <path d="M-42 74 L -33 61" stroke={SHIRT} strokeWidth="20" strokeLinecap="round" />
            <path d="M-33 61 L -16 47" stroke={INK} strokeWidth="15" strokeLinecap="round" />
            <path d="M-33 61 L -16 47" stroke={SKIN} strokeWidth="11" strokeLinecap="round" />
            <path
              d="M-21 44 C -22 35.5, -15.5 32.5, -10.5 33.5 C -6.5 30.5, -0.5 30.5, 2.5 33.5 C 7 32.5, 10 36, 9 41.5 C 9 50, 2.5 53, -6 53 C -14.5 53, -20 50, -21 44 Z"
              fill={SKIN}
              stroke={INK}
              strokeWidth="2.6"
              strokeLinejoin="round"
            />
            <path d="M-11 34 C -11 36.8, -10.4 39, -11 41.5 M-3.8 32.5 C -3.8 35.2, -3.2 37.4, -3.8 40 M3.4 34 C 3.4 36.4, 3.9 38, 3.4 40.5" fill="none" stroke={INK} strokeWidth="1.7" strokeLinecap="round" />
            <path d="M-20 45.5 C -14.5 41.5, -8 41.5, -1.5 45.5" fill="none" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
          </g>
          <g className="aj-shades">
            <rect x="-36" y="-22" width="30" height="20" rx="7" fill={SHADE} />
            <rect x="6" y="-22" width="30" height="20" rx="7" fill={SHADE} />
            <rect x="-8" y="-16" width="16" height="5" fill={SHADE} />
            <rect x="-31" y="-19" width="10" height="4" rx="2" fill="#fff" opacity="0.55" />
            <path className="aj-glint" d={GLINT} fill="#fff" />
          </g>
          <path className="aj-vbrows" d="M-42 -42 L -8 -24 M42 -42 L 8 -24" stroke={INK} strokeWidth="10" strokeLinecap="round" />
          <g className="aj-sweat">
            <path d="M42 -44 C 45 -39, 48 -35, 48 -32 A 6 6 0 0 1 36 -32 C 36 -35, 39 -39, 42 -44 Z" fill="#7dd3fc" stroke={INK} strokeWidth="2" />
            <path d="M39.5 -33 Q 39.5 -36 41 -38" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          </g>
        </g>
        <g fill={GOLD} stroke={INK} strokeWidth="1.6">
          <path className="aj-sp aj-one" d="M44 -54 l 3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" />
          <path className="aj-sp aj-two" d="M-50 -46 l 2.4 5.6 5.6 2.4 -5.6 2.4 -2.4 5.6 -2.4 -5.6 -5.6 -2.4 5.6 -2.4 Z" />
          <path className="aj-sp aj-three" d="M50 -14 l 2 4.6 4.6 2 -4.6 2 -2 4.6 -2 -4.6 -4.6 -2 4.6 -2 Z" />
        </g>
        <text className="aj-qmark" x="34" y="-50" fontSize="30" fill={GOLD} stroke={INK} strokeWidth="1.5">
          ?
        </text>
        <text className="aj-qmark2" x="-52" y="-56" fontSize="20" fill={GOLD} stroke={INK} strokeWidth="1.2">
          ?
        </text>
        {/* the thought cloud (ponder): two bubbles up from his head, then the cloud with its three dots */}
        <g className="aj-think">
          <circle className="aj-tb1" cx="44.5" cy="-45.5" r="2.7" fill="#fff" stroke={INK} strokeWidth="1.8" />
          <circle className="aj-tb2" cx="50.5" cy="-53" r="3.4" fill="#fff" stroke={INK} strokeWidth="1.8" />
          <g className="aj-cloud">
            <g fill={INK}>
              {CLOUD.map(([x, y, r]) => (
                <circle key={`o${x}`} cx={x} cy={y} r={r + 1.8} />
              ))}
            </g>
            <g fill="#fff">
              {CLOUD.map(([x, y, r]) => (
                <circle key={`i${x}`} cx={x} cy={y} r={r} />
              ))}
            </g>
            <circle className="aj-dot aj-d1" cx="27.5" cy="-66" r="2.9" fill={INK} />
            <circle className="aj-dot aj-d2" cx="36.5" cy="-66" r="2.9" fill={INK} />
            <circle className="aj-dot aj-d3" cx="45.5" cy="-66" r="2.9" fill={INK} />
          </g>
        </g>
        <g className="aj-vein">
          <Vein x={31} y={-50} r={15} />
        </g>
        <g fill="#eef2f7" stroke={INK} strokeWidth="2.4">
          <Puff x={-38} y={-66} r={16} className="aj-steam aj-st-rest" />
          <Puff x={-52} y={-40} r={16} className="aj-steam aj-st-l" />
          <Puff x={52} y={-40} r={16} className="aj-steam aj-st-r" />
        </g>
      </svg>
    </span>
  );
});

/**
 * The head of the doll, in the splash face's coordinates (-58 -84 116 136): glad (an open grin) or mad (red, V
 * brows, gritted teeth). `rage` (72o): mad, with a shocked O for the mouth too (the rage shows it before the teeth).
 */
function DollHead({ mad, rage }: { mad: boolean; rage?: boolean }) {
  return (
    <>
      <Ears />
      <ellipse cx="0" cy="-12" rx="44" ry="48" fill={SKIN} stroke={INK} strokeWidth="4" />
      {mad && <ellipse className="aj-r-flush" cx="0" cy="-12" rx="41.5" ry="45.5" fill="#ff2d2d" opacity="0.62" />}
      <Shine />
      <g transform="translate(-21 -12)">
        <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
        <circle cx="1" cy="1" r="4.2" fill={INK} />
      </g>
      <g transform="translate(21 -12)">
        <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
        <circle cx="-1" cy="1" r="4.2" fill={INK} />
      </g>
      <path d="M-29 -14 Q -21 -19.5 -13 -15.5 M13 -15.5 Q 21 -19.5 29 -14" fill="none" stroke={STACHE} strokeWidth="3.6" strokeLinecap="round" />
      {mad ? (
        <g className="aj-r-teeth">
          <rect x="-14" y="21" width="28" height="12" rx="3.5" fill="#fff" stroke={INK} strokeWidth="3" />
          <path d="M-14 27 H14 M-7 21 V33 M0 21 V33 M7 21 V33" stroke={INK} strokeWidth="2" />
        </g>
      ) : (
        <g>
          <path d="M-16 21 Q 0 47 16 21 Z" fill="#5a1d14" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M-8 33.5 Q 0 28 8 33.5 Q 0 39 -8 33.5 Z" fill="#e0565b" />
        </g>
      )}
      {rage && <ellipse className="aj-r-oh" cx="0" cy="28" rx="7.5" ry="9" fill="#5a1d14" stroke={INK} strokeWidth="3" />}
      <path d={MUSTACHE} fill={STACHE} />
      <Shades className="aj-r-shades" />
      {mad && <path className="aj-r-vbrows" d="M-40 -40 L -9 -24 M40 -40 L 9 -24" stroke={INK} strokeWidth="9" strokeLinecap="round" />}
    </>
  );
}

/** A small cloud of steam centred on (x, y), in the doll's units (for his ears in the rage). */
const Jet = ({ x, y, className }: { x: number; y: number; className: string }) => (
  <g className={className}>
    <circle cx={x - 2.6} cy={y + 0.8} r="3.3" />
    <circle cx={x + 2.6} cy={y + 1} r="3" />
    <circle cx={x} cy={y - 1.6} r="3.8" />
  </g>
);

/** The doll's colours: his own clothes, or the gorilla costume's fur (KK). */
interface Garb {
  shirt: string;
  pants: string;
  arm: string;
  fist: string;
  shoe: string;
  /** How thick the limbs are (the costume is bulky). */
  w: number;
}
const CLOTHES: Garb = { shirt: SHIRT, pants: PANTS, arm: SKIN, fist: SKIN, shoe: SHOE, w: 1 };
/** The gorilla costume: a mid grey fur (it has to read on the dark screen), darker hands and feet, thick limbs. */
const FUR = "#535a68";
const FUR_LIGHT = "#8a93a3";
const FUR_DARK = "#30343c";
const COSTUME: Garb = { shirt: FUR, pants: FUR, arm: FUR, fist: FUR_DARK, shoe: FUR_DARK, w: 1.45 };

/** A two-part leg (thigh, then shin and sneaker), turning at the hip and the knee. */
function Leg({ side, x, foot, g }: { side: "l" | "r"; x: number; foot: number; g: Garb }) {
  return (
    <g className={`aj-r-leg-${side}`}>
      <path d={`M${x} 67 L ${x} 77.5`} stroke={INK} strokeWidth={10 * g.w} strokeLinecap="round" />
      <path d={`M${x} 67 L ${x} 77.5`} stroke={g.pants} strokeWidth={7 * g.w} strokeLinecap="round" />
      <g className={`aj-r-shin-${side}`}>
        <path d={`M${x} 78 L ${x} 87.5`} stroke={INK} strokeWidth={9.4 * g.w} strokeLinecap="round" />
        <path d={`M${x} 78 L ${x} 87.5`} stroke={g.pants} strokeWidth={6.4 * g.w} strokeLinecap="round" />
        <ellipse cx={foot} cy="90.2" rx={6.6 * Math.sqrt(g.w)} ry="3.6" fill={g.shoe} stroke={INK} strokeWidth="1.8" />
      </g>
    </g>
  );
}

/** A two-part arm (red sleeve, then forearm and fist), turning at the shoulder and the elbow; the right one can hold something and point. */
function Arm({ side, sx, ex, hx, hold, g }: { side: "l" | "r"; sx: number; ex: number; hx: number; hold?: ReactNode; g: Garb }) {
  return (
    <g className={`aj-r-arm-${side}`}>
      <path d={`M${sx} 49 L ${ex} 58`} stroke={INK} strokeWidth={7.6 * g.w} strokeLinecap="round" />
      <path d={`M${sx} 49 L ${ex} 58`} stroke={g.shirt} strokeWidth={4.8 * g.w} strokeLinecap="round" />
      <g className={`aj-r-fore-${side}`}>
        <path d={`M${ex} 58 L ${hx} 67`} stroke={INK} strokeWidth={6.4 * g.w} strokeLinecap="round" />
        <path d={`M${ex} 58 L ${hx} 67`} stroke={g.arm} strokeWidth={3.8 * g.w} strokeLinecap="round" />
        {hold}
        {side === "r" && (
          <g className="aj-r-finger">
            <path d={`M${hx} 68.4 L ${hx + 1.6} 74.6`} stroke={INK} strokeWidth="3.6" strokeLinecap="round" />
            <path d={`M${hx} 68.4 L ${hx + 1.6} 74.6`} stroke={g.fist} strokeWidth="1.8" strokeLinecap="round" />
          </g>
        )}
        <circle cx={hx} cy="68.4" r={3.7 * Math.sqrt(g.w)} fill={g.fist} stroke={INK} strokeWidth="1.6" />
      </g>
    </g>
  );
}

/** The mallet, in the right forearm: the handle runs down from his fist (51, 68), the head at its end. */
const MALLET = (
  <g className="aj-r-mallet">
    <path d="M51 64 L 51 108" stroke={INK} strokeWidth="6.4" strokeLinecap="round" />
    <path d="M51 64 L 51 108" stroke="#c98a4b" strokeWidth="3.8" strokeLinecap="round" />
    <rect x="34" y="104" width="34" height="21" rx="5" fill="#b0703a" stroke={INK} strokeWidth="2.6" />
    <rect x="34" y="104" width="7" height="21" rx="3" fill="#8a5428" stroke={INK} strokeWidth="2" />
    <rect x="61" y="104" width="7" height="21" rx="3" fill="#8a5428" stroke={INK} strokeWidth="2" />
    <rect x="43" y="107" width="15" height="4" rx="2" fill="#fff" opacity="0.45" />
  </g>
);

/**
 * The whole 아재, a jointed doll for the body moves (the doll's own units: 0 0 64 96, feet at y 93; ajae.css
 * gives each joint its pivot). The viewBox is padded past those units so every pose he strikes paints inside
 * the SVG's own box (a limb or the mallet swinging outside it is a paint risk on Safari): `wide` for the mallet,
 * `view` for a move with props of its own around him (the plane, a crown coming down, a mask lifted off).
 * `rage` (72o): the mad head with its shocked O, shock lines over his head and steam that shoots out of his ears.
 * The pairs' shows dress him up: `fur` puts him in the gorilla costume (KK; its head goes over his own),
 * `under` is drawn behind him (the plane's tail, a cape), `over` in front of his body but under his arms (the
 * plane's fuselage, a bow tie, the cape's collar), `top` on his head, turning with it (a crown).
 */
function Doll({ mad, rage, wide, view, hold, fur, under, over, top }: { mad: boolean; rage?: boolean; wide?: boolean; view?: string; hold?: ReactNode; fur?: boolean; under?: ReactNode; over?: ReactNode; top?: ReactNode }) {
  const g = fur ? COSTUME : CLOTHES;
  return (
    <svg className="aj-rig" viewBox={view ?? (wide ? "-32 -32 168 136" : "-24 -16 112 120")} xmlns="http://www.w3.org/2000/svg">
      <g className="aj-r-all">
        {under}
        <Leg side="l" x={26.5} foot={24.5} g={g} />
        <Leg side="r" x={37.5} foot={39.5} g={g} />
        <rect x="20" y="61" width="24" height="9" rx="2.5" fill={g.pants} stroke={INK} strokeWidth="2" />
        {fur ? (
          <>
            {/* the costume: a broad, furry chest with a paler chest patch, tufts at the shoulders and the waist */}
            <path d="M13 48 Q 32 37 51 48 Q 50 58 46.5 66 L 17.5 66 Q 14 58 13 48 Z" fill={FUR} stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
            <path d="M22.5 48.5 Q 32 44.5 41.5 48.5 Q 42.5 58 32 61.5 Q 21.5 58 22.5 48.5 Z" fill={FUR_LIGHT} stroke={INK} strokeWidth="1.4" />
            <path d="M25.5 52.5 Q 32 55.5 38.5 52.5" fill="none" stroke={FUR} strokeWidth="1.4" strokeLinecap="round" />
            <path d="M13.5 47 l -2.6 -2.6 M16 44.6 l -1.6 -3.2 M50.5 47 l 2.6 -2.6 M48 44.6 l 1.6 -3.2 M19 66 l -1.4 2.4 M45 66 l 1.4 2.4" stroke={INK} strokeWidth="1.4" strokeLinecap="round" />
          </>
        ) : (
          <>
            <path d="M18 47 Q 32 40 46 47 L 44.5 64 L 19.5 64 Z" fill={g.shirt} stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
            <g fill="#fff" opacity="0.9">
              <circle cx="24" cy="56" r="1.8" />
              <circle cx="39" cy="58" r="1.8" />
              <circle cx="31" cy="61" r="1.5" />
            </g>
            <path d="M26 45 Q 32 53 38 45" fill="none" stroke={GOLD} strokeWidth="2.4" />
          </>
        )}
        <g className="aj-r-head">
          <g transform="translate(32 25) scale(0.4)">
            <DollHead mad={mad || !!rage} rage={rage} />
          </g>
          {fur && <GorillaMask />}
          {top}
          {rage && (
            <>
              <g fill="#eef2f7" stroke={INK} strokeWidth="1.2">
                <Jet x={10} y={21.5} className="aj-r-jet aj-r-jl1" />
                <Jet x={10} y={21.5} className="aj-r-jet aj-r-jl2" />
                <Jet x={54} y={21.5} className="aj-r-jet aj-r-jr1" />
                <Jet x={54} y={21.5} className="aj-r-jet aj-r-jr2" />
              </g>
              <g className="aj-r-shock" strokeLinecap="round">
                <path d="M15 7 L 10 2 M32 2.5 L 32 -4 M49 7 L 54 2" stroke={INK} strokeWidth="4.2" />
                <path d="M15 7 L 10 2 M32 2.5 L 32 -4 M49 7 L 54 2" stroke="#fff" strokeWidth="2" />
              </g>
            </>
          )}
        </g>
        {over}
        <Arm side="l" sx={21} ex={16} hx={13} g={g} />
        <Arm side="r" sx={43} ex={48} hx={51} hold={hold} g={g} />
      </g>
    </svg>
  );
}

const STAR_POINTS = Array.from({ length: 20 }, (_, i) => {
  const r = i % 2 ? 8.5 : i % 4 === 0 ? 22 : 16.5;
  const a = (i * 18 - 90) * (Math.PI / 180);
  return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
}).join(" ");
/** The impact burst: a gold 20-point star with a white core. */
const Star = () => (
  <svg viewBox="-24 -24 48 48">
    <polygon points={STAR_POINTS} fill={GOLD} stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />
    <polygon points={STAR_POINTS} fill="#fff" transform="scale(0.5)" />
  </svg>
);
/** ♪ */
const Note1 = () => (
  <svg viewBox="0 0 16 20">
    <path d="M6.5 2 L 6.5 14" stroke={INK} strokeWidth="3.6" strokeLinecap="round" />
    <path d="M6.5 2 Q 12 3.5 13 8 Q 11 5.8 6.5 5.6 Z" fill={GOLD} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M6.5 2 L 6.5 14" stroke={GOLD} strokeWidth="1.6" strokeLinecap="round" />
    <ellipse cx="4.2" cy="15" rx="3.8" ry="3" transform="rotate(-20 4.2 15)" fill={GOLD} stroke={INK} strokeWidth="1.6" />
  </svg>
);
/** ♫ */
const Note2 = () => (
  <svg viewBox="0 0 22 20">
    <path d="M6 4 L 6 15 M16 2 L 16 13" stroke={INK} strokeWidth="3.6" strokeLinecap="round" />
    <path d="M6 4 L 16 2 L 16 5 L 6 7 Z" fill={GOLD} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M6 4 L 6 15 M16 2 L 16 13" stroke={GOLD} strokeWidth="1.6" strokeLinecap="round" />
    <ellipse cx="3.8" cy="16" rx="3.6" ry="2.8" transform="rotate(-20 3.8 16)" fill={GOLD} stroke={INK} strokeWidth="1.6" />
    <ellipse cx="13.8" cy="14" rx="3.6" ry="2.8" transform="rotate(-20 13.8 14)" fill={GOLD} stroke={INK} strokeWidth="1.6" />
  </svg>
);
/**
 * The mirror ball: a grey sphere whose facet meridians slide sideways (it spins), glints and a twinkle. The
 * facet lines and glints are clipped to the sphere (the sliding meridians would show beside it otherwise); the
 * clip's id comes from useId, so two balls on a page never share one.
 */
function Ball() {
  const clip = useId();
  return (
    <svg className="aj-ballsvg" viewBox="-15 -15 30 30">
      <clipPath id={clip}>
        <circle r="13" />
      </clipPath>
      <circle r="13.5" fill="#9aa7b8" stroke={INK} strokeWidth="2" />
      <g clipPath={`url(#${clip})`}>
        <g fill="none" stroke="#5b6b80" strokeWidth="0.9">
          <path d="M-14 -6.5 H14 M-14 0 H14 M-14 6.5 H14 M-14 -11 H14 M-14 11 H14" />
          <g className="aj-mer">
            <path d="M-18 -14 V14 M-12 -14 V14 M-6 -14 V14 M0 -14 V14 M6 -14 V14 M12 -14 V14" />
          </g>
        </g>
        <g fill="#eef6ff">
          <rect x="-8" y="-9" width="4" height="4" opacity="0.95" />
          <rect x="2" y="-3" width="4" height="4" opacity="0.7" />
          <rect x="-5" y="4" width="4" height="4" opacity="0.6" />
          <rect x="5" y="6" width="3" height="3" opacity="0.45" />
          <rect x="-11" y="-2" width="3" height="4" opacity="0.5" />
        </g>
      </g>
      <circle r="13.5" fill="none" stroke={INK} strokeWidth="2" />
      <path className="aj-twinkle" d={spark(-6, -8, 6)} fill="#fff" />
    </svg>
  );
}
const SparkSvg = ({ fill }: { fill: string }) => (
  <svg viewBox="-10 -10 20 20">
    <path d={spark(0, 0, 9)} fill={fill} stroke={INK} strokeWidth="1.4" />
  </svg>
);

const CHIP_COLORS = ["#e11d48", "#111827", "#2563eb", "#e11d48", "#111827", "#16a34a", "#e11d48"];
/** A stack of seven chips seen from the side (bottom first). */
const Stack = ({ colors }: { colors: readonly string[] }) => (
  <svg viewBox="0 0 24 48">
    {colors.map((c, i) => {
      const y = 40 - i * 5.2;
      const xs = i % 2 ? [8, 17] : [4, 13, 21];
      return (
        <g key={i}>
          <rect x="1" y={y} width="22" height="6" rx="2.2" fill={c} stroke={INK} strokeWidth="1.4" />
          <path d={xs.map((x) => `M${x} ${y + 1.5} v3`).join(" ")} stroke="#fff" strokeWidth="2" />
        </g>
      );
    })}
  </svg>
);
const ChipSide = ({ c }: { c: string }) => (
  <svg viewBox="0 0 24 8">
    <rect x="1" y="1" width="22" height="6" rx="2.2" fill={c} stroke={INK} strokeWidth="1.4" />
    <path d="M5 2.4 v3.2 M12 2.4 v3.2 M19 2.4 v3.2" stroke="#fff" strokeWidth="2.2" />
  </svg>
);
const ChipTop = ({ c }: { c: string }) => (
  <svg viewBox="-8 -8 16 16">
    <circle r="7" fill={c} stroke={INK} strokeWidth="1.4" />
    <circle r="5.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeDasharray="2.7 2.7" />
    <circle r="3" fill={c} stroke="#fff" strokeWidth="0.9" />
  </svg>
);

const HEART = "M8 16.5 C 2.5 12.5, 2.2 8.6, 4.8 7.3 C 6.5 6.5, 7.6 7.6, 8 8.6 C 8.4 7.6, 9.5 6.5, 11.2 7.3 C 13.8 8.6, 13.5 12.5, 8 16.5 Z";
const SPADE = "M8 5.2 C 2.5 9.4, 2.2 13, 4.8 14.3 C 6.5 15.1, 7.6 14.2, 8 13.2 C 8.4 14.2, 9.5 15.1, 11.2 14.3 C 13.8 13, 13.5 9.4, 8 5.2 Z M8 13.6 L 6.4 17.8 L 9.6 17.8 Z";
/** A card (16 x 22): its face (a big pip and a small one in the corner), and its red back for the flip. */
const Card = ({ pip, color }: { pip: string; color: string }) => (
  <>
    <svg className="aj-cface" viewBox="0 0 16 22">
      <rect x="0.7" y="0.7" width="14.6" height="20.6" rx="2.4" fill="#fff" stroke={INK} strokeWidth="1.4" />
      <path d={pip} fill={color} />
      <path d={pip} fill={color} transform="translate(1.4 1.2) scale(0.34)" />
    </svg>
    <svg className="aj-cback" viewBox="0 0 16 22">
      <rect x="0.7" y="0.7" width="14.6" height="20.6" rx="2.4" fill="#c81e3c" stroke={INK} strokeWidth="1.4" />
      <rect x="2.6" y="2.6" width="10.8" height="16.8" rx="1.2" fill="none" stroke="#fff" strokeWidth="1" />
      <path d="M3 7 L 8 3 L 13 7 L 8 11 Z M3 15 L 8 11 L 13 15 L 8 19 Z" fill="none" stroke="#fff" strokeWidth="0.8" opacity="0.8" />
    </svg>
  </>
);
/** A circle as a path (centre, radius), to join into one pip. */
const circ = (x: number, y: number, r: number) => `M${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
const CLUB = `${circ(8, 9.6, 2.7)} ${circ(5.2, 13.4, 2.7)} ${circ(10.8, 13.4, 2.7)} M8 12 L 6.3 17.8 L 9.7 17.8 Z`;
const DIAMOND = "M8 7.6 L 11.7 13 L 8 18.4 L 4.3 13 Z";
/** 72o's two cards, with their indices drawn (no text): the 7 of clubs and the 2 of diamonds. */
const CARDS_72 = [
  { rank: "M2.6 2.6 H 6.4 L 3.8 8.4", pip: CLUB, color: INK },
  { rank: "M2.8 4.2 Q 3 2.5 4.6 2.5 Q 6.3 2.5 6.2 4.1 Q 6.1 5.5 2.7 8.4 H 6.5", pip: DIAMOND, color: "#d6202f" },
] as const;
/** One of 72o's cards (18 x 25 box): ajae.css cuts it into its two halves along a jagged tear (.aj-half.aj-hl / .aj-hr). */
const Card72 = ({ rank, pip, color }: (typeof CARDS_72)[number]) => (
  <svg viewBox="0 0 16 22">
    <rect x="0.7" y="0.7" width="14.6" height="20.6" rx="2.4" fill="#fff" stroke={INK} strokeWidth="1.4" />
    <path d={rank} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d={pip} fill={color} transform="translate(2.3 7.4) scale(0.3)" />
    <path d={pip} fill={color} transform="translate(1.6 2.2) scale(0.8)" />
  </svg>
);
/** A scrap of a torn card. */
const BitSvg = () => (
  <svg viewBox="0 0 8 6">
    <path d="M0.6 0.8 L 7.2 0.6 L 6.4 2.4 L 7.4 5.2 L 0.8 5.4 L 1.6 3 Z" fill="#fff" stroke={INK} strokeWidth="0.9" strokeLinejoin="round" />
  </svg>
);

// ───────────── the pairs' shows (AJAE_SPECIALS): their costumes and props ─────────────

/** The gorilla costume's face: a pale leathery plate under a heavy brow of fur, a big muzzle, a broad flat nose. */
const GFACE = "#8f837a";
const MUZZLE = "#b0a49a";
const GNOSE = "#5e544d";
/**
 * The gorilla costume's head (KK), over his own bald head, in the splash face's units: a broad dome with a low crest,
 * small ears, a heavy brow, small eyes, a big muzzle with a flat nose. Its jaw drops for the roar (.aj-r-roar); in the
 * end he lifts the whole head off (.aj-r-mask) and it's him inside.
 */
function GorillaMask() {
  return (
    <g className="aj-r-mask">
      <g transform="translate(32 25) scale(0.4)">
        {[-1, 1].map((k) => (
          <g key={k}>
            <circle cx={58 * k} cy="0" r="11" fill={FUR} stroke={INK} strokeWidth="4" />
            <circle cx={58 * k} cy="0" r="5" fill={GFACE} />
          </g>
        ))}
        <path d="M-62 16 C -66 -28, -44 -66, -10 -76 Q 0 -86 10 -76 C 44 -66, 66 -28, 62 16 C 60 46, 34 60, 0 60 C -34 60, -60 46, -62 16 Z" fill={FUR} stroke={INK} strokeWidth="4" strokeLinejoin="round" />
        <path d="M-34 -58 Q -18 -70 -4 -72 M8 -70 Q 28 -66 40 -52 M-50 -26 Q -54 -8 -50 10 M50 -26 Q 54 -8 50 10" fill="none" stroke={FUR_LIGHT} strokeWidth="3.6" strokeLinecap="round" />
        <path d="M-44 -12 C -46 -38, -14 -44, 0 -36 C 14 -44, 46 -38, 44 -12 C 50 14, 40 48, 0 54 C -40 48, -50 14, -44 -12 Z" fill={GFACE} stroke={INK} strokeWidth="3" />
        <path d="M-48 -16 Q -25 -42 0 -29 Q 25 -42 48 -16 Q 25 -24 0 -13 Q -25 -24 -48 -16 Z" fill={FUR} stroke={INK} strokeWidth="2.8" strokeLinejoin="round" />
        {[-1, 1].map((k) => (
          <g key={k}>
            <circle cx={17 * k} cy="-4" r="6" fill="#fff" stroke={INK} strokeWidth="2.2" />
            <circle cx={16 * k} cy="-3" r="3.8" fill={INK} />
            <circle cx={15 * k + 1.2} cy="-4.6" r="1.2" fill="#fff" />
          </g>
        ))}
        <path d="M-32 18 C -33 2, 33 2, 32 18 C 34 40, 17 50, 0 50 C -17 50, -34 40, -32 18 Z" fill={MUZZLE} stroke={INK} strokeWidth="2.8" />
        <path d="M-19 11 C -19 -1, 19 -1, 19 11 C 19 18, 9 20, 0 17.5 C -9 20, -19 18, -19 11 Z" fill={GNOSE} stroke={INK} strokeWidth="2.2" />
        <ellipse cx="-8" cy="11.5" rx="5" ry="3.6" fill={INK} />
        <ellipse cx="8" cy="11.5" rx="5" ry="3.6" fill={INK} />
        <path className="aj-r-shut" d="M-16 34 Q 0 40 16 34" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" />
        <g className="aj-r-roar">
          <ellipse cx="0" cy="36" rx="17" ry="11" fill="#5a1d14" stroke={INK} strokeWidth="3" />
          <path d="M-11 26.5 L -8 35 L -4.5 27 Z M11 26.5 L 8 35 L 4.5 27 Z" fill="#fff" stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
        </g>
      </g>
    </g>
  );
}

/** A gold crown (KK), on his bald head (the splash face's units: it sits on the top of the dome), its jewels and pearls. */
const CROWN = (
  <g className="aj-r-crown">
    <g transform="translate(32 25) scale(0.4)">
      <path d="M-31 -46 L -36 -84 L -17 -63 L 0 -94 L 17 -63 L 36 -84 L 31 -46 Q 0 -54 -31 -46 Z" fill={GOLD} stroke={INK} strokeWidth="3.6" strokeLinejoin="round" />
      <path d="M-31 -46 Q 0 -54 31 -46 L 31 -35 Q 0 -43 -31 -35 Z" fill="#f59e0b" stroke={INK} strokeWidth="3.6" strokeLinejoin="round" />
      <path d="M-28 -52 L -31 -74 L -22 -62 Z M-6 -66 L 0 -84 L 3 -70 Z" fill="#fff" opacity="0.7" />
      {[[-36, -87], [0, -98], [36, -87]].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="5.5" fill="#fff" stroke={INK} strokeWidth="2.4" />
      ))}
      <circle cx="-17" cy="-41" r="4.6" fill="#e11d48" stroke={INK} strokeWidth="2" />
      <circle cx="0" cy="-43.5" r="5.6" fill="#2563eb" stroke={INK} strokeWidth="2" />
      <circle cx="17" cy="-41" r="4.6" fill="#16a34a" stroke={INK} strokeWidth="2" />
    </g>
  </g>
);
/** The royal cape behind him (KK, the crown): red velvet with a gold hem; it swirls on as the crown lands. */
const CAPE = (
  <g className="aj-r-cape">
    <path d="M17 46 Q 32 41 47 46 L 60 90 Q 32 97 4 90 Z" fill="#b4123a" stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
    <path d="M6 88.5 Q 32 95 58 88.5" fill="none" stroke={GOLD} strokeWidth="2.6" />
    <path d="M22 52 L 14 86 M42 52 L 50 86" fill="none" stroke="#7f0d29" strokeWidth="1.6" strokeLinecap="round" />
  </g>
);
/** The cape's white ermine collar over his shoulders, with its black tails. */
const COLLAR = (
  <g className="aj-r-collar">
    <path d="M14.5 47.5 Q 32 37.5 49.5 47.5 Q 51 52 46.5 52.5 Q 32 45 17.5 52.5 Q 13 52 14.5 47.5 Z" fill="#fff" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M19 48.4 v 2 M25 45.4 v 2 M39 45.4 v 2 M45 48.4 v 2" stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
  </g>
);
/** The scepter in his right fist (like the mallet: it hangs from the fist, so it points up when he raises his arm). */
const SCEPTER = (
  <g className="aj-r-scep">
    <path d="M51 64 L 51 95" stroke={INK} strokeWidth="5" strokeLinecap="round" />
    <path d="M51 64 L 51 95" stroke={GOLD} strokeWidth="2.8" strokeLinecap="round" />
    <path d="M46.5 91 L 55.5 91" stroke={INK} strokeWidth="4" strokeLinecap="round" />
    <path d="M46.5 91 L 55.5 91" stroke={GOLD} strokeWidth="2" strokeLinecap="round" />
    <circle cx="51" cy="99" r="5" fill="#e11d48" stroke={INK} strokeWidth="1.6" />
    <path d={spark(49.6, 97.6, 2.4)} fill="#fff" />
  </g>
);

/** A bow tie (QQ: the ladies' man), over his chain. */
const BOWTIE = (
  <g className="aj-r-tie">
    <path d="M32 46.5 L 24.5 42.6 Q 23.4 46.5 24.5 50.4 Z M32 46.5 L 39.5 42.6 Q 40.6 46.5 39.5 50.4 Z" fill={INK} stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
    <circle cx="32" cy="46.5" r="2.3" fill="#2b2f3a" stroke={INK} strokeWidth="1" />
    <path d="M26 44.6 L 26 48.4 M38 44.6 L 38 48.4" stroke="#6b7280" strokeWidth="1" strokeLinecap="round" />
  </g>
);

/** The plane's light blue, its darker wings and tail. */
const SKY = "#5ec8ff";
const WING = "#2f8fe0";
/**
 * AA's plane, in the doll's units around him (he sits in its open cockpit): the far tail fin behind him
 * (PLANE_BACK), then in front of his body the fuselage with its stripe, gold cowling, spinning propeller
 * (.aj-r-prop), windshield, near wing, wheels, and his white scarf flying back (.aj-r-scarf). The nose is to the right.
 */
const PLANE_BACK = (
  <g>
    <path d="M-34 58 L -43 35 Q -40 31.5 -36 34 L -19 56 Z" fill={WING} stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
    <path d={spark(-35.5, 45, 4.6)} fill={GOLD} stroke={INK} strokeWidth="1" />
  </g>
);
const PLANE_FRONT = (
  <g>
    <path d="M-40 57 Q -12 51 13 55 L 50 55 Q 84 54 94 59 Q 101.5 66 94 74 Q 70 81.5 30 80.5 Q -8 77 -40 64 Z" fill={SKY} stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />
    <path d="M-32 61 Q 28 71 92 66" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" />
    <path d="M13 56 Q 31.5 60 50 56" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
    <path d="M85 56 Q 101 59.5 101 66 Q 101 72.5 85 76.5 Z" fill={GOLD} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
    <g className="aj-r-prop">
      <ellipse cx="104.5" cy="66" rx="2.6" ry="17" fill="#e2e8f0" stroke={INK} strokeWidth="1.3" opacity="0.85" />
    </g>
    <circle cx="103" cy="66" r="3.6" fill="#e11d48" stroke={INK} strokeWidth="1.5" />
    <path d="M50 55 L 55 43.5 Q 59 44 60.5 55 Z" fill="#c9eeff" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" opacity="0.85" />
    <path d="M-40 64 L -18 63.5 L -26 70.5 L -46 70.5 Z" fill={WING} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
    <path d="M28 80 L 25 88.5 M47 79.5 L 49 88.5" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="25" cy="90.5" r="4.4" fill={INK} />
    <circle cx="49" cy="90.5" r="4.4" fill={INK} />
    <circle cx="25" cy="90.5" r="1.6" fill="#94a3b8" />
    <circle cx="49" cy="90.5" r="1.6" fill="#94a3b8" />
    <path d="M20 72 L 66 72 Q 72 74 66 77.5 L 13 86.5 Q 5 87.5 7.5 82 Z" fill={WING} stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
    <path d="M16 79 L 60 74.5" stroke="#8fd6ff" strokeWidth="1.6" strokeLinecap="round" />
    <g className="aj-r-scarf">
      <path d="M31 43.5 Q 17 39.5 6 44 Q -5 48.5 -15 43 L -13 49.5 Q -3 54 7 49.5 Q 17 46 31 48 Z" fill="#fff" stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
    </g>
  </g>
);

/** A firework's burst (its colour): twelve rays, twelve sparks further out, a white heart. */
const FW_RAYS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * 30 * Math.PI) / 180;
  const f = (r: number) => `${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
  return `M${f(7)} L ${f(18)}`;
}).join(" ");
const FW_SPARKS = Array.from({ length: 12 }, (_, i) => {
  const a = ((i * 30 + 15) * Math.PI) / 180;
  const x = 24 * Math.cos(a);
  return `M${(x - 1.9).toFixed(1)} ${(24 * Math.sin(a)).toFixed(1)} a 1.9 1.9 0 1 0 3.8 0 a 1.9 1.9 0 1 0 -3.8 0 Z`;
}).join(" ");
const Firework = ({ c }: { c: string }) => (
  <svg viewBox="-28 -28 56 56">
    <path d={FW_RAYS} stroke={c} strokeWidth="2.8" strokeLinecap="round" />
    <path d={FW_SPARKS} fill={c} />
    <circle r="4.6" fill="#fff" />
  </svg>
);
/** The pairs' fireworks: colour, and the rest is ajae.css (where, when, how big). */
const FIREWORKS: Record<string, readonly string[]> = {
  plane: ["#ff4d8d", GOLD, "#38bdf8", "#a3e635", "#fff1a8"],
  gorilla: [GOLD, "#38bdf8"],
  crown: [GOLD, "#ff4d8d"],
  waltz: ["#ff7ab6", "#fff1a8"],
  split: [GOLD, "#38bdf8"],
};
/** Confetti colours (a piece is a small rectangle; ajae.css throws it). */
const CONFETTI = ["#fbbf24", "#ff4d8d", "#38bdf8", "#a3e635", "#fff", "#f97316", "#b36bff", "#fbbf24", "#ff4d8d", "#38bdf8", "#fff", "#a3e635"];
const ROYAL = ["#fbbf24", "#fde68a", "#fff", "#e11d48", "#fbbf24", "#f59e0b", "#fff", "#fbbf24", "#e11d48", "#fde68a", "#fbbf24", "#fff"];
/** QQ's rose petals and JJ's gold. */
const PETALS = ["#ff4d8d", "#ffb3d1", "#e11d48", "#fff", "#ff7ab6", "#ffb3d1", "#e11d48", "#ff4d8d"];
const GILT = ["#fbbf24", "#fde68a", "#fff", "#fbbf24", "#f59e0b", "#fde68a", "#fff", "#fbbf24"];

/** A fanfare trumpet (KK, the crown): gold, with a red banner hanging from it (a gold crown on it, no words). */
const Trumpet = () => (
  <svg viewBox="-4 -18 66 52">
    <path d="M6 7 L 32 7 L 32 31 L 19 25 L 6 31 Z" fill="#c8102e" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 9.5 L 29 9.5 L 29 26.5 L 19 22 L 9 26.5 Z" fill="none" stroke={GOLD} strokeWidth="1.2" />
    <path d="M12 19 L 13.5 12.5 L 16.5 16 L 19 11 L 21.5 16 L 24.5 12.5 L 26 19 Z" fill={GOLD} stroke={INK} strokeWidth="0.9" strokeLinejoin="round" />
    <path d="M0 4 L 40 4" stroke={INK} strokeWidth="7" strokeLinecap="round" />
    <path d="M0 4 L 40 4" stroke={GOLD} strokeWidth="4.4" strokeLinecap="round" />
    <path d="M2 2.6 L 38 2.6" stroke="#fff6c7" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M36 1 L 58 -13 L 58 21 L 36 7 Z" fill={GOLD} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
    <ellipse cx="58" cy="4" rx="3.4" ry="17" fill="#f59e0b" stroke={INK} strokeWidth="2" />
    <path d="M40 0 L 54 -8" stroke="#fff6c7" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

/** The queen's index, drawn (no text): an oval with its tail. */
const Q_INDEX = "M-8.6 -12.4 a 2.5 2.9 0 1 0 0.01 0 Z M-8 -9.6 L -6 -7.8";
/**
 * A queen card that dances (QQ): a card with a little gold crown, her index drawn (no text), a face, her suit's pip,
 * white-gloved arms and legs in heels (each turns at its own pivot: .aj-qd-arm-l and the rest).
 */
function Queen({ pip, color }: { pip: string; color: string }) {
  return (
    <svg viewBox="-24 -32 48 66">
      <g className="aj-qd">
        {(["l", "r"] as const).map((k, i) => (
          <g key={k} className={`aj-qd-leg-${k}`}>
            <path d={`M${i ? 5 : -5} 17 L ${i ? 6 : -6} 27`} stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
            <path d={`M${i ? 6 : -6} 27.5 l ${i ? 4 : -4} 0.4`} stroke={color} strokeWidth="3" strokeLinecap="round" />
          </g>
        ))}
        {(["l", "r"] as const).map((k, i) => (
          <g key={k} className={`aj-qd-arm-${k}`}>
            <path d={`M${i ? 12 : -12} -3 L ${i ? 21 : -21} -9`} stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
            <circle cx={i ? 21.5 : -21.5} cy="-9.4" r="2.6" fill="#fff" stroke={INK} strokeWidth="1.2" />
          </g>
        ))}
        <rect x="-13" y="-18" width="26" height="36" rx="3.5" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <rect x="-10.6" y="-15.6" width="21.2" height="31.2" rx="2" fill="none" stroke={color} strokeWidth="0.9" />
        <path d={Q_INDEX} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M-7 -18 L -8.5 -25.5 L -4 -21.5 L 0 -27.5 L 4 -21.5 L 8.5 -25.5 L 7 -18 Z" fill={GOLD} stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
        <circle cx="-4" cy="-6.5" r="1.5" fill={INK} />
        <circle cx="4" cy="-6.5" r="1.5" fill={INK} />
        <path d="M-6 -8.8 l -1.4 -1.2 M6 -8.8 l 1.4 -1.2" stroke={INK} strokeWidth="0.9" strokeLinecap="round" />
        <circle cx="-6.6" cy="-3" r="1.9" fill="#ff8fb3" opacity="0.8" />
        <circle cx="6.6" cy="-3" r="1.9" fill="#ff8fb3" opacity="0.8" />
        <path d="M-2.6 -2.4 Q 0 0 2.6 -2.4" fill="none" stroke="#d6202f" strokeWidth="1.3" strokeLinecap="round" />
        <path d={pip} fill={color} transform="translate(-5.6 0.4) scale(0.7)" />
      </g>
    </svg>
  );
}
/** A heart rising (QQ). */
const HeartSvg = ({ c }: { c: string }) => (
  <svg viewBox="2 5 12 13">
    <path d={HEART} fill={c} stroke={INK} strokeWidth="0.9" />
  </svg>
);

/** The splash's J♥ index and heart (index.html), in the card's units (-150..150, -210..210). */
const J_INDEX =
  "M20.5 0.8L20.5 0.8Q11.9 0.8 7.3-2.9Q2.7-6.6 1.2-14.9L1.2-14.9L12.7-16.6Q13.4-12.3 15.3-10.3Q17.2-8.2 20.5-8.2L20.5-8.2Q24.0-8.2 25.8-10.5Q27.5-12.9 27.5-17.1L27.5-17.1L27.5-46.0L16.6-46.0L16.6-55.0L39.0-55.0L39.0-17.4Q39.0-8.8 34.1-4.0Q29.3 0.8 20.5 0.8Z";
const J_HEART = "M0 44 C -30 16, -40 0, -40 -18 C -40 -38, -20 -48, 0 -30 C 20 -48, 40 -38, 40 -18 C 40 0, 30 16, 0 44 Z";
/**
 * JJ's jack: the launch splash's J♥ with the 아재 as its court picture (bald, shades, mustache; his brows under the
 * shades), its gold frame, the J index and a heart. `pic`: the court picture is there (the second jack); without it
 * the frame starts empty and he appears in it once he has dived in (.aj-jc-pic). The frame's clip has a useId id.
 */
function JackCard({ pic }: { pic?: boolean }) {
  const clip = useId();
  return (
    <svg viewBox="-156 -216 312 432">
      <clipPath id={clip}>
        <rect x="-104" y="-150" width="208" height="300" rx="10" />
      </clipPath>
      <rect x="-150" y="-210" width="300" height="420" rx="26" fill="#fffdf7" stroke={INK} strokeWidth="8" />
      <rect x="-104" y="-150" width="208" height="300" rx="10" fill="#fff3d6" />
      <g clipPath={`url(#${clip})`}>
        <g className={pic ? undefined : "aj-jc-pic"}>
          <g transform="translate(0 32) scale(1.6)">
          <path d="M-78 74 Q -66 40 -26 34 L 26 34 Q 66 40 78 74 Z" fill={SHIRT} stroke={INK} strokeWidth="4" />
          <g fill="#fff" opacity="0.9">
            <circle cx="-50" cy="58" r="5" />
            <circle cx="-30" cy="48" r="4" />
            <circle cx="44" cy="56" r="5" />
            <circle cx="28" cy="46" r="4" />
          </g>
          <path d="M-22 36 Q 0 62 22 36" fill="none" stroke={GOLD} strokeWidth="6" />
          <circle cx="0" cy="58" r="6" fill={GOLD} stroke={INK} strokeWidth="2" />
          <Ears />
          <ellipse cx="0" cy="-12" rx="44" ry="48" fill={SKIN} stroke={INK} strokeWidth="4" />
          <Shine />
          {/* his eyes, under the shades until he lifts them (as on the splash) */}
          {[-1, 1].map((k) => (
            <g key={k} transform={`translate(${21 * k} -12)`}>
              <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
              <circle cx={-k} cy="1" r="4.2" fill={INK} />
            </g>
          ))}
          <path d="M-29 -14 Q -21 -19.5 -13 -15.5 M13 -15.5 Q 21 -19.5 29 -14" fill="none" stroke={STACHE} strokeWidth="3.6" strokeLinecap="round" />
          <path d="M-12 25 Q 0 35 12 25" fill="none" stroke="#6b2d1e" strokeWidth="3.4" strokeLinecap="round" />
          <path d={MUSTACHE} fill={STACHE} />
          <Shades className="aj-jc-shades" />
          </g>
        </g>
      </g>
      <rect x="-104" y="-150" width="208" height="300" rx="10" fill="none" stroke={GOLD} strokeWidth="6" />
      <path transform="translate(-124 -136)" fill="#d6202f" d={J_INDEX} />
      <path transform="translate(-105 -96) scale(0.5)" fill="#d6202f" d={J_HEART} />
      <path transform="translate(124 136) rotate(180)" fill="#d6202f" d={J_INDEX} />
      <path transform="translate(105 96) rotate(180) scale(0.5)" fill="#d6202f" d={J_HEART} />
    </svg>
  );
}
/** The leaves the gorilla's chest pounds shake down (KK). */
const LEAVES = ["#4ade80", "#22c55e", "#86efac", "#16a34a", "#4ade80", "#22c55e"];
const LeafSvg = ({ c }: { c: string }) => (
  <svg viewBox="-8 -5 16 10">
    <path d="M-7 0 Q -2 -5 6 -1 Q 7 0 6 1 Q -2 5 -7 0 Z" fill={c} stroke={INK} strokeWidth="0.9" strokeLinejoin="round" />
    <path d="M-6 0 L 5 0" stroke="#14532d" strokeWidth="0.7" />
  </svg>
);
/** The hearts rising round the waltz (QQ). */
const HEARTS = ["#ff4d8d", "#ff7ab6", "#e11d48", "#ffb3d1", "#ff4d8d", "#ff7ab6", "#e11d48", "#ffb3d1"];
/** A suit pip flying out of the jacks' split (JJ). */
const PipSvg = ({ pip, color }: { pip: string; color: string }) => (
  <svg viewBox="3 4 10 15">
    <path d={pip} fill={color} stroke={INK} strokeWidth="0.8" />
  </svg>
);

/** The suit pips flying out of the jacks' split (JJ): pip and colour. */
const PIPS: readonly (readonly [string, string])[] = [
  [HEART, "#d6202f"],
  [SPADE, "#e5e7eb"],
  [DIAMOND, "#d6202f"],
  [CLUB, "#e5e7eb"],
  [HEART, "#d6202f"],
  [SPADE, "#e5e7eb"],
  [DIAMOND, "#d6202f"],
  [CLUB, "#e5e7eb"],
];

const PuffSvg = () => (
  <svg viewBox="-12 -10 24 20">
    <g fill="#eef2f7" stroke={INK} strokeWidth="1.6">
      <circle cx="-5" cy="2" r="5" />
      <circle cx="5" cy="2.5" r="4.5" />
      <circle cx="0" cy="-2.5" r="5.8" />
    </g>
  </svg>
);
const DustSvg = () => (
  <svg viewBox="-12 -8 24 16">
    <g fill="#cbd5e1" opacity="0.9">
      <circle cx="-6" cy="2" r="4.2" />
      <circle cx="2" cy="0" r="5.2" />
      <circle cx="8" cy="3" r="3.2" />
    </g>
  </svg>
);
/** The puff he vanishes in when the face takes over (three clouds round his chest). */
const PoofSvg = () => (
  <svg viewBox="-22 -15 44 30">
    <g fill="#f8fafc" stroke={INK} strokeWidth="1.6">
      <circle cx="-11" cy="3" r="8" />
      <circle cx="11" cy="4" r="7.5" />
      <circle cx="0" cy="-4" r="9.5" />
    </g>
  </svg>
);

/** The steam off his head while he fumes: one as he boils over at the start, two at the end. */
const Fumes = () => (
  <>
    <span className="aj-puff aj-p0">
      <PuffSvg />
    </span>
    <span className="aj-puff aj-p1">
      <PuffSvg />
    </span>
    <span className="aj-puff aj-p2">
      <PuffSvg />
    </span>
  </>
);

/**
 * Everything a body move draws, by move: the props as direct children of the .aj-act (a fragment, never a
 * wrapper: ajae.css places and hides `.aj-act > *`). Its own element per reaction, so every animation in it
 * starts when it mounts.
 */
const AjaeAct = memo(function AjaeAct({ move }: { move: AjaeMove }) {
  const poof = (
    <span className="aj-poof">
      <PoofSvg />
    </span>
  );
  switch (move) {
    case "shuffle":
    case "robot":
      return (
        <>
          <span className="aj-disco">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} className="aj-spot" />
            ))}
          </span>
          <span className="aj-beams">
            {Array.from({ length: 7 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="aj-ball">
            <span className="aj-string" />
            <Ball />
          </span>
          <span className="aj-body">
            <Doll mad={false} />
          </span>
          <span className="aj-note aj-n1">
            <Note1 />
          </span>
          <span className="aj-note aj-n2">
            <Note2 />
          </span>
          <span className="aj-note aj-n3">
            <Note1 />
          </span>
          <span className="aj-note aj-n4">
            <Note2 />
          </span>
          <span className="aj-shine">
            <SparkSvg fill="#fff" />
          </span>
          {poof}
        </>
      );
    case "shove":
      return (
        <>
          <span className="aj-flash" />
          <span className="aj-body">
            <Doll mad={false} />
          </span>
          <span className="aj-stack aj-s1">
            <Stack colors={CHIP_COLORS} />
          </span>
          <span className="aj-stack aj-s2">
            <Stack colors={[...CHIP_COLORS].reverse()} />
          </span>
          {["#e11d48", "#111827", "#2563eb", "#16a34a", "#e11d48", "#111827"].map((c, i) => (
            <span key={`c${i}`} className={`aj-chip aj-c${i + 1}`}>
              <ChipSide c={c} />
            </span>
          ))}
          {["#e11d48", "#111827", "#16a34a", "#2563eb", "#e11d48", "#111827", "#e11d48"].map((c, i) => (
            <span key={`r${i}`} className={`aj-roll aj-r${i + 1}`}>
              <ChipTop c={c} />
            </span>
          ))}
          <span className="aj-spk aj-k1">
            <SparkSvg fill={GOLD} />
          </span>
          <span className="aj-spk aj-k2">
            <SparkSvg fill={GOLD} />
          </span>
          <span className="aj-spk aj-k3">
            <SparkSvg fill="#fff" />
          </span>
          {poof}
        </>
      );
    case "kick":
      return (
        <>
          <span className="aj-body">
            <Doll mad />
          </span>
          <span className="aj-whoosh">
            <svg viewBox="0 0 40 40">
              <path d="M6 6 Q 30 6 34 32" fill="none" stroke="#e2e8f0" strokeWidth="3" strokeLinecap="round" />
              <path d="M2 14 Q 22 14 26 34" fill="none" stroke="#e2e8f0" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
            </svg>
          </span>
          <span className="aj-burst">
            <Star />
          </span>
          <span className="aj-dust aj-d1">
            <DustSvg />
          </span>
          <span className="aj-dust aj-d2">
            <DustSvg />
          </span>
          <Fumes />
          {poof}
        </>
      );
    case "mallet":
      return (
        <>
          <span className="aj-body">
            <Doll mad wide hold={MALLET} />
          </span>
          <span className="aj-burst">
            <Star />
          </span>
          <span className="aj-crack">
            <svg viewBox="-40 -6 80 24">
              <path d="M-4 0 L -12 6 L -9 9 L -22 16 M3 0 L 10 7 L 7 10 L 20 17 M0 1 L 1 9 L -2 13" fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M-4 0 L -12 6 L -9 9 L -22 16 M3 0 L 10 7 L 7 10 L 20 17 M0 1 L 1 9 L -2 13" fill="none" stroke="#fde68a" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="aj-dizzy">
            <svg viewBox="-24 -10 48 20">
              {[-14, 0, 14].map((x, i) => (
                <path key={x} d={spark(x, i === 1 ? -3 : 2, 5)} fill={GOLD} stroke={INK} strokeWidth="1.1" />
              ))}
            </svg>
          </span>
          <span className="aj-speed">
            <svg viewBox="0 0 40 40">
              <path d="M4 34 Q 4 6 34 4" fill="none" stroke="#e2e8f0" strokeWidth="3" strokeLinecap="round" />
              <path d="M12 36 Q 12 14 36 12" fill="none" stroke="#e2e8f0" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
            </svg>
          </span>
          <Fumes />
          {poof}
        </>
      );
    case "slam":
      return (
        <>
          <span className="aj-body">
            <Doll mad />
          </span>
          <span className="aj-card aj-cd1">
            <Card pip={SPADE} color={INK} />
          </span>
          <span className="aj-card aj-cd2">
            <Card pip={HEART} color="#d6202f" />
          </span>
          <span className="aj-lines">
            <svg viewBox="0 0 30 30">
              <path d="M5 2 V 22 M15 0 V 28 M25 2 V 20" stroke="#e2e8f0" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="aj-bang">
            <svg viewBox="-20 -10 40 20">
              <path d="M-18 6 L -8 2 M-14 -4 L -6 0 M18 6 L 8 2 M14 -4 L 6 0 M0 -9 L 0 -2" stroke={GOLD} strokeWidth="3" strokeLinecap="round" />
            </svg>
          </span>
          <span className="aj-burst">
            <Star />
          </span>
          <span className="aj-dust aj-d1">
            <DustSvg />
          </span>
          <span className="aj-dust aj-d2">
            <DustSvg />
          </span>
          <Fumes />
          {poof}
        </>
      );
    case "rage":
      return (
        <>
          <span className="aj-aura" />
          <span className="aj-body">
            <Doll mad rage />
          </span>
          {CARDS_72.flatMap((c, i) =>
            (["hl", "hr"] as const).map((h) => (
              <span key={`${i}${h}`} className={`aj-half aj-q${i * 2 + (h === "hl" ? 1 : 2)} aj-${h}`}>
                <Card72 {...c} />
              </span>
            )),
          )}
          {[1, 2, 3, 4].map((i) => (
            <span key={`b${i}`} className={`aj-bit aj-b${i}`}>
              <BitSvg />
            </span>
          ))}
          <span className="aj-burst">
            <Star />
          </span>
          <span className="aj-bang">
            <svg viewBox="-20 -10 40 20">
              <path d="M-18 6 L -8 2 M-14 -4 L -6 0 M18 6 L 8 2 M14 -4 L 6 0 M0 -9 L 0 -2" stroke={GOLD} strokeWidth="3" strokeLinecap="round" />
            </svg>
          </span>
          <span className="aj-dust aj-d1">
            <DustSvg />
          </span>
          <span className="aj-dust aj-d2">
            <DustSvg />
          </span>
          <Fumes />
          {poof}
        </>
      );
    case "plane":
      return (
        <>
          <span className="aj-search">
            <i />
            <i />
          </span>
          <span className="aj-trail aj-t1" />
          <span className="aj-ring">
            {Array.from({ length: 16 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="aj-trail aj-t2" />
          {sky("plane")}
          <span className="aj-flash" />
          <span className="aj-body">
            <Doll mad={false} view="-50 -6 162 102" under={PLANE_BACK} over={PLANE_FRONT} />
          </span>
          <span className="aj-dust aj-d1">
            <DustSvg />
          </span>
          <span className="aj-dust aj-d2">
            <DustSvg />
          </span>
          {confetti(CONFETTI)}
          {poof}
        </>
      );
    case "gorilla":
      return (
        <>
          <span className="aj-pool" />
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={`w${i}`} className={`aj-wave aj-w${i}`} />
          ))}
          {LEAVES.map((c, i) => (
            <span key={`l${i}`} className={`aj-leaf aj-l${i + 1}`}>
              <LeafSvg c={c} />
            </span>
          ))}
          {sky("gorilla")}
          <span className="aj-burst">
            <Star />
          </span>
          <span className="aj-body">
            <Doll mad={false} fur view="-40 -44 144 148" />
          </span>
          <span className="aj-roarl">
            <svg viewBox="-30 -20 60 40">
              <path d="M-27 -12 L -19 -7 M-29 2 L -20 1 M-25 14 L -18 8 M27 -12 L 19 -7 M29 2 L 20 1 M25 14 L 18 8" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="aj-flash" />
          {[1, 2, 3].map((i) => (
            <span key={`k${i}`} className={`aj-spk aj-k${i}`}>
              <SparkSvg fill={i === 2 ? "#fff" : GOLD} />
            </span>
          ))}
          <span className="aj-dust aj-d1">
            <DustSvg />
          </span>
          <span className="aj-dust aj-d2">
            <DustSvg />
          </span>
          {confetti(CONFETTI)}
          {poof}
        </>
      );
    case "crown":
      return (
        <>
          <span className="aj-rays">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="aj-halo" />
          {[1, 2].map((i) => (
            <span key={`t${i}`} className={`aj-trump aj-tp${i}`}>
              <Trumpet />
            </span>
          ))}
          {[1, 2, 3, 4].map((i) => (
            <span key={`n${i}`} className={`aj-tn aj-tn${i}`}>
              {i % 2 ? <Note1 /> : <Note2 />}
            </span>
          ))}
          {sky("crown")}
          <span className="aj-body">
            <Doll mad={false} view="-30 -100 124 204" under={CAPE} over={COLLAR} top={CROWN} hold={SCEPTER} />
          </span>
          <span className="aj-flash" />
          <span className="aj-gleam">
            <SparkSvg fill="#fff" />
          </span>
          {[1, 2, 3, 4].map((i) => (
            <span key={`k${i}`} className={`aj-spk aj-k${i}`}>
              <SparkSvg fill={i % 2 ? GOLD : "#fff"} />
            </span>
          ))}
          {confetti(ROYAL)}
          {poof}
        </>
      );
    case "waltz":
      return (
        <>
          <span className="aj-pink" />
          <span className="aj-lights">
            {Array.from({ length: 8 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={`k${i}`} className={`aj-spk aj-k${i}`}>
              <SparkSvg fill={i % 2 ? "#fff" : "#ffc2dc"} />
            </span>
          ))}
          <span className="aj-queen aj-qn1">
            <Queen pip={HEART} color="#d6202f" />
          </span>
          <span className="aj-body">
            <Doll mad={false} view="-30 -16 124 120" over={BOWTIE} />
          </span>
          <span className="aj-queen aj-qn2">
            <Queen pip={SPADE} color={INK} />
          </span>
          {HEARTS.map((c, i) => (
            <span key={`h${i}`} className={`aj-heart aj-h${i + 1}`}>
              <HeartSvg c={c} />
            </span>
          ))}
          {sky("waltz")}
          <span className="aj-flash" />
          {confetti(PETALS)}
          {poof}
        </>
      );
    case "split":
      return (
        <>
          <span className="aj-felt" />
          <span className="aj-sweep" />
          <span className="aj-jack aj-jk2">
            <JackCard pic />
            <i className="aj-sheen" />
          </span>
          <span className="aj-jack aj-jk1">
            <JackCard />
            <i className="aj-sheen" />
          </span>
          <span className="aj-body">
            <Doll mad={false} view="-40 -40 144 144" />
          </span>
          {[1, 2].map((i) => (
            <span key={`s${i}`} className={`aj-snap aj-sn${i}`}>
              <svg viewBox="0 0 20 30">
                <path d="M2 6 L 16 1 M3 15 L 18 15 M2 24 L 16 29" stroke={GOLD} strokeWidth="3.4" strokeLinecap="round" />
              </svg>
            </span>
          ))}
          {[1, 2].map((i) => (
            <span key={`r${i}`} className={`aj-strk aj-strk${i}`}>
              <svg viewBox="0 0 60 24">
                <path d="M2 4 L 58 4 M10 12 L 58 12 M2 20 L 58 20" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity="0.9" />
              </svg>
            </span>
          ))}
          {PIPS.map(([pip, c], i) => (
            <span key={`p${i}`} className={`aj-pip aj-pp${i + 1}`}>
              <PipSvg pip={pip} color={c} />
            </span>
          ))}
          {sky("split")}
          <span className="aj-flash" />
          {[1, 2, 3].map((i) => (
            <span key={`k${i}`} className={`aj-spk aj-k${i}`}>
              <SparkSvg fill={i === 2 ? "#fff" : GOLD} />
            </span>
          ))}
          {confetti(GILT)}
          {poof}
        </>
      );
    default:
      return null;
  }
});

/** A pair's fireworks (FIREWORKS): for each, the rocket going up (.aj-rk) and its burst (.aj-fw). */
const sky = (move: string) =>
  FIREWORKS[move].map((c, i) => (
    <Fragment key={`f${i}`}>
      <span className={`aj-rk aj-rk${i + 1}`} style={{ color: c }} />
      <span className={`aj-fw aj-fw${i + 1}`}>
        <Firework c={c} />
      </span>
    </Fragment>
  ));
/** Confetti: a small rectangle per colour, thrown by ajae.css. */
const confetti = (colors: readonly string[]) =>
  colors.map((c, i) => <span key={`c${i}`} className={`aj-conf aj-f${i + 1}`} style={{ background: c }} />);
