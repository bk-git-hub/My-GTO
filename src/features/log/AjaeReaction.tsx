import { memo, useId, useMemo, type ReactNode } from "react";
import { ajaeOn, useSettings } from "../../state/settings";
import { ajaeTier, BODY_MOVES, type AjaeCue, type AjaeMove, type AjaeTier } from "./ajae";
import type { PreStage } from "./quickPre";
import "./ajae.css";

/**
 * The 아재 by 빠른 기록's hand class: wraps the class (`children`, the real .fast-class) and, while a
 * reaction (`cue`) is on, draws him next to it. No words anywhere: faces, a jointed doll of him, props
 * and symbols (a mirror ball, chips, a mallet, cards, bursts, ?, z, notes, steam). Everything he draws is
 * absolutely positioned with pointer-events off, so the label row, the pad and everything below keep their
 * place, and every button stays live while he moves. The moves are CSS animations (ajae.css) that start
 * when their element mounts (keyed by the cue), so nothing here runs a timer.
 *
 * Two kinds of move (ajae.ts, AJAE_MOVES):
 * - a face move (meh, fold, 72o, and the cramped stand-ins): the chest-up face in its slot pops up big,
 *   makes the tier's face and settles small with it;
 * - a body move (monster's shove, good's shuffle or robot, trash's kick, mallet or slam): the whole 아재
 *   performs beside the class (`.aj-act`), then shrinks away in a puff as the face pops into the slot and
 *   stays there at rest. The trash face stays furious: he never walks off.
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
        <span key={cue.n} className={`aj-slot${playing ? (body ? " aj-after" : cue.low ? " aj-pop aj-low" : " aj-pop") : ""}`} aria-hidden="true">
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
const HAIR = "#3b2a1e";
const SHIRT = "#ff4d5a";
const GOLD = "#fbbf24";
const SHADE = "#0b0f14";
/** Denim and white sneakers: the legs have to read against the dark screen (the splash draws none). */
const PANTS = "#4f6a9e";
const SHOE = "#f8fafc";
const MUSTACHE =
  "M0 14 C -8 6, -24 5, -34 14 C -39 19, -46 19, -50 14 C -46 28, -28 31, -14 23 C -7 19, -3 18, 0 21 C 3 18, 7 19, 14 23 C 28 31, 46 28, 50 14 C 46 19, 39 19, 34 14 C 24 5, 8 6, 0 14 Z";
const HAIR_L = "M-44 -10 C -50 -30, -44 -44, -32 -50 C -36 -38, -38 -24, -36 -6 Z";
const HAIR_R = "M44 -10 C 50 -30, 44 -44, 32 -50 C 36 -38, 38 -24, 36 -6 Z";
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
 * The splash's 아재 (index.html, the J♥'s court picture) from the chest up, with every part the moves and
 * the resting faces need (hidden unless the tier or the move shows it). `move`: the face move playing now.
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
          <ellipse cx="0" cy="-12" rx="44" ry="48" fill={SKIN} stroke={INK} strokeWidth="4" />
          <ellipse className="aj-flush" cx="0" cy="-13" rx="41" ry="45" fill="#ff3020" />
          <ellipse cx="-12" cy="-48" rx="12" ry="6" fill="#fff" opacity="0.7" />
          <path d={HAIR_L} fill={HAIR} />
          <path d={HAIR_R} fill={HAIR} />
          <path d="M-14 -56 q 14 -8 30 2" fill="none" stroke={HAIR} strokeWidth="4" strokeLinecap="round" />
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
          <path className="aj-brow-l" d="M-29 -14 Q -21 -19.5 -13 -15.5" fill="none" stroke={HAIR} strokeWidth="3.6" strokeLinecap="round" />
          <path className="aj-brow-r" d="M13 -15.5 Q 21 -19.5 29 -14" fill="none" stroke={HAIR} strokeWidth="3.6" strokeLinecap="round" />
          <path className="aj-smile" d="M-12 25 Q 0 35 12 25" fill="none" stroke="#6b2d1e" strokeWidth="3.4" strokeLinecap="round" />
          <path className="aj-flat" d="M-7 28 L 7 27" fill="none" stroke="#6b2d1e" strokeWidth="3" strokeLinecap="round" />
          <ellipse className="aj-yawn" cx="0" cy="27" rx="7" ry="7" fill="#5a1d14" stroke={INK} strokeWidth="1.5" />
          <g className="aj-teeth">
            <rect x="-15" y="20" width="30" height="13" rx="3.5" fill="#fff" stroke={INK} strokeWidth="3" />
            <path d="M-15 26.5 H15 M-7.5 20 V33 M0 20 V33 M7.5 20 V33" stroke={INK} strokeWidth="2.2" />
          </g>
          <path d={MUSTACHE} fill={HAIR} />
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
          <g className="aj-mug">
            <rect x="30" y="2" width="18" height="24" rx="3" fill={GOLD} stroke={INK} strokeWidth="2.6" />
            <path d="M48 8 q 8 0 8 7 q 0 7 -8 7" fill="none" stroke={INK} strokeWidth="2.6" />
            <path d="M28 4 q 3 -7 9 -4 q 4 -5 9 0 q 5 -2 5 4 Z" fill="#fff" stroke={INK} strokeWidth="2" />
            <path d="M35 10 v 12 M41 10 v 12" stroke="#fff" strokeWidth="2" opacity="0.6" />
          </g>
          <g fill="#fff" stroke={INK} strokeWidth="1.4">
            <circle className="aj-foam aj-f1" cx="60" cy="-42" r="4.5" />
            <circle className="aj-foam aj-f2" cx="68" cy="-38" r="3.6" />
            <circle className="aj-foam aj-f3" cx="74" cy="-32" r="4" />
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
        <g fill="#cbd5e1" stroke={INK} strokeWidth="1">
          <text className="aj-zfly aj-a" x="30" y="-40" fontSize="16">
            z
          </text>
          <text className="aj-zfly aj-b" x="38" y="-48" fontSize="20">
            z
          </text>
          <text className="aj-zfly aj-c" x="40" y="-58" fontSize="24">
            Z
          </text>
          <text className="aj-zrest" x="36" y="-44" fontSize="20">
            z
          </text>
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

/** The head of the doll, in the splash face's coordinates (-58 -84 116 136): glad (an open grin) or mad (red, V brows, gritted teeth). */
function DollHead({ mad }: { mad: boolean }) {
  return (
    <>
      <ellipse cx="0" cy="-12" rx="44" ry="48" fill={SKIN} stroke={INK} strokeWidth="4" />
      {mad && <ellipse className="aj-r-flush" cx="0" cy="-12" rx="41.5" ry="45.5" fill="#ff2d2d" opacity="0.62" />}
      <ellipse cx="-12" cy="-48" rx="12" ry="6" fill="#fff" opacity="0.7" />
      <path d={HAIR_L} fill={HAIR} />
      <path d={HAIR_R} fill={HAIR} />
      <path d="M-14 -56 q 14 -8 30 2" fill="none" stroke={HAIR} strokeWidth="4" strokeLinecap="round" />
      <g transform="translate(-21 -12)">
        <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
        <circle cx="1" cy="1" r="4.2" fill={INK} />
      </g>
      <g transform="translate(21 -12)">
        <ellipse rx="8" ry="7.2" fill="#fff" stroke={INK} strokeWidth="2.4" />
        <circle cx="-1" cy="1" r="4.2" fill={INK} />
      </g>
      <path d="M-29 -14 Q -21 -19.5 -13 -15.5 M13 -15.5 Q 21 -19.5 29 -14" fill="none" stroke={HAIR} strokeWidth="3.6" strokeLinecap="round" />
      {mad ? (
        <g>
          <rect x="-14" y="21" width="28" height="12" rx="3.5" fill="#fff" stroke={INK} strokeWidth="3" />
          <path d="M-14 27 H14 M-7 21 V33 M0 21 V33 M7 21 V33" stroke={INK} strokeWidth="2" />
        </g>
      ) : (
        <g>
          <path d="M-16 21 Q 0 47 16 21 Z" fill="#5a1d14" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M-8 33.5 Q 0 28 8 33.5 Q 0 39 -8 33.5 Z" fill="#e0565b" />
        </g>
      )}
      <path d={MUSTACHE} fill={HAIR} />
      <Shades className="aj-r-shades" />
      {mad && <path className="aj-r-vbrows" d="M-40 -40 L -9 -24 M40 -40 L 9 -24" stroke={INK} strokeWidth="9" strokeLinecap="round" />}
    </>
  );
}

/** A two-part leg (thigh, then shin and sneaker), turning at the hip and the knee. */
function Leg({ side, x, foot }: { side: "l" | "r"; x: number; foot: number }) {
  return (
    <g className={`aj-r-leg-${side}`}>
      <path d={`M${x} 67 L ${x} 77.5`} stroke={INK} strokeWidth="10" strokeLinecap="round" />
      <path d={`M${x} 67 L ${x} 77.5`} stroke={PANTS} strokeWidth="7" strokeLinecap="round" />
      <g className={`aj-r-shin-${side}`}>
        <path d={`M${x} 78 L ${x} 87.5`} stroke={INK} strokeWidth="9.4" strokeLinecap="round" />
        <path d={`M${x} 78 L ${x} 87.5`} stroke={PANTS} strokeWidth="6.4" strokeLinecap="round" />
        <ellipse cx={foot} cy="90.2" rx="6.6" ry="3.6" fill={SHOE} stroke={INK} strokeWidth="1.8" />
      </g>
    </g>
  );
}

/** A two-part arm (red sleeve, then forearm and fist), turning at the shoulder and the elbow; the right one can hold something and point. */
function Arm({ side, sx, ex, hx, hold }: { side: "l" | "r"; sx: number; ex: number; hx: number; hold?: ReactNode }) {
  return (
    <g className={`aj-r-arm-${side}`}>
      <path d={`M${sx} 49 L ${ex} 58`} stroke={INK} strokeWidth="7.6" strokeLinecap="round" />
      <path d={`M${sx} 49 L ${ex} 58`} stroke={SHIRT} strokeWidth="4.8" strokeLinecap="round" />
      <g className={`aj-r-fore-${side}`}>
        <path d={`M${ex} 58 L ${hx} 67`} stroke={INK} strokeWidth="6.4" strokeLinecap="round" />
        <path d={`M${ex} 58 L ${hx} 67`} stroke={SKIN} strokeWidth="3.8" strokeLinecap="round" />
        {hold}
        {side === "r" && (
          <g className="aj-r-finger">
            <path d={`M${hx} 68.4 L ${hx + 1.6} 74.6`} stroke={INK} strokeWidth="3.6" strokeLinecap="round" />
            <path d={`M${hx} 68.4 L ${hx + 1.6} 74.6`} stroke={SKIN} strokeWidth="1.8" strokeLinecap="round" />
          </g>
        )}
        <circle cx={hx} cy="68.4" r="3.7" fill={SKIN} stroke={INK} strokeWidth="1.6" />
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
 * the SVG's own box (a limb or the mallet swinging outside it is a paint risk on Safari): `wide` for the mallet.
 */
function Doll({ mad, wide, hold }: { mad: boolean; wide?: boolean; hold?: ReactNode }) {
  return (
    <svg className="aj-rig" viewBox={wide ? "-32 -32 168 136" : "-24 -16 112 120"} xmlns="http://www.w3.org/2000/svg">
      <g className="aj-r-all">
        <Leg side="l" x={26.5} foot={24.5} />
        <Leg side="r" x={37.5} foot={39.5} />
        <rect x="20" y="61" width="24" height="9" rx="2.5" fill={PANTS} stroke={INK} strokeWidth="2" />
        <path d="M18 47 Q 32 40 46 47 L 44.5 64 L 19.5 64 Z" fill={SHIRT} stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
        <g fill="#fff" opacity="0.9">
          <circle cx="24" cy="56" r="1.8" />
          <circle cx="39" cy="58" r="1.8" />
          <circle cx="31" cy="61" r="1.5" />
        </g>
        <path d="M26 45 Q 32 53 38 45" fill="none" stroke={GOLD} strokeWidth="2.4" />
        <g className="aj-r-head">
          <g transform="translate(32 25) scale(0.4)">
            <DollHead mad={mad} />
          </g>
        </g>
        <Arm side="l" sx={21} ex={16} hx={13} />
        <Arm side="r" sx={43} ex={48} hx={51} hold={hold} />
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
    default:
      return null;
  }
});
