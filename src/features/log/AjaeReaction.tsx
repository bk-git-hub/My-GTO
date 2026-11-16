import { useMemo, type ReactNode } from "react";
import { ajaeOn, useSettings } from "../../state/settings";
import { ajaeTier, type AjaeCue, type AjaeTier } from "./ajae";
import type { PreStage } from "./quickPre";
import "./ajae.css";

/**
 * The 아재 by 빠른 기록's hand class: wraps the class (`children`, the real .fast-class) and, while a
 * reaction (`cue`) is on, draws him next to it. Everything he draws is absolutely positioned with
 * pointer-events off, so the label row, the pad and everything below keep their place, and every
 * button stays live while he moves. The moves are CSS animations that start when their element
 * mounts (keyed by the cue), so nothing here runs a timer.
 *
 * A face pops up big for a moment, makes the tier's face and settles small with it (ajae.css). A trash
 * hand gets no face: the whole 아재 hops out beside the hand, kicks it (the class jolts) and walks off.
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
  const kicking = playing && tier === "trash";
  return (
    <span className="ajae-host">
      {cue && tier && tier !== "trash" && (
        <span key={cue.n} className={`aj-slot${playing ? " aj-pop" : ""}`} aria-hidden="true">
          <AjaeFace tier={tier} play={playing} />
          {playing && <span className="aj-bubble">{cue.line}</span>}
        </span>
      )}
      {cue && kicking && (
        <span key={`k${cue.n}`} className="aj-kick" aria-hidden="true">
          <span className="aj-kicker">
            <AjaeKicker />
          </span>
          <span className="aj-boom">뻥!</span>
          <span className="aj-kbubble">{cue.line}</span>
        </span>
      )}
      {/* The kick jolts this wrapper (its keyframes alternate by cue so a second kick in a row restarts them). */}
      <span className={`aj-jolt${cue && kicking ? ` aj-kicked aj-k${cue.n % 2}` : ""}`}>{children}</span>
    </span>
  );
}

/** The splash's 아재 (index.html, the J♥'s court picture) from the chest up, with the parts the moves need. */
function AjaeFace({ tier, play }: { tier: AjaeTier; play: boolean }) {
  return (
    <span className={`aj-face aj-${tier}${play ? " aj-play" : ""}`}>
      <svg className="aj-fig" viewBox="-58 -84 116 136" xmlns="http://www.w3.org/2000/svg">
        <g className="aj-head">
          <path d="M-78 74 Q -66 40 -26 34 L 26 34 Q 66 40 78 74 Z" fill="#ff4d5a" stroke="#1b1400" strokeWidth="4" />
          <g fill="#fff" opacity="0.9">
            <circle cx="-50" cy="58" r="5" />
            <circle cx="-30" cy="48" r="4" />
            <circle cx="44" cy="56" r="5" />
            <circle cx="28" cy="46" r="4" />
          </g>
          <path d="M-22 36 Q 0 62 22 36" fill="none" stroke="#fbbf24" strokeWidth="6" />
          <circle cx="0" cy="58" r="6" fill="#fbbf24" stroke="#1b1400" strokeWidth="2" />
          <ellipse cx="0" cy="-12" rx="44" ry="48" fill="#f2c48d" stroke="#1b1400" strokeWidth="4" />
          <ellipse cx="-12" cy="-48" rx="12" ry="6" fill="#fff" opacity="0.7" />
          <path d="M-44 -10 C -50 -30, -44 -44, -32 -50 C -36 -38, -38 -24, -36 -6 Z" fill="#3b2a1e" />
          <path d="M44 -10 C 50 -30, 44 -44, 32 -50 C 36 -38, 38 -24, 36 -6 Z" fill="#3b2a1e" />
          <path d="M-14 -56 q 14 -8 30 2" fill="none" stroke="#3b2a1e" strokeWidth="4" strokeLinecap="round" />
          <g className="aj-eyes">
            <g transform="translate(-21 -12)">
              <ellipse rx="8" ry="7.2" fill="#fff" stroke="#1b1400" strokeWidth="2.4" />
              <g className="aj-pupils">
                <circle cx="1" cy="1" r="4.2" fill="#1b1400" />
                <circle cx="2.5" cy="-0.8" r="1.4" fill="#fff" />
              </g>
            </g>
            <g transform="translate(21 -12)">
              <ellipse rx="8" ry="7.2" fill="#fff" stroke="#1b1400" strokeWidth="2.4" />
              <g className="aj-pupils">
                <circle cx="-1" cy="1" r="4.2" fill="#1b1400" />
                <circle cx="0.5" cy="-0.8" r="1.4" fill="#fff" />
              </g>
            </g>
          </g>
          <path className="aj-brow-l" d="M-29 -14 Q -21 -19.5 -13 -15.5" fill="none" stroke="#3b2a1e" strokeWidth="3.6" strokeLinecap="round" />
          <path className="aj-brow-r" d="M13 -15.5 Q 21 -19.5 29 -14" fill="none" stroke="#3b2a1e" strokeWidth="3.6" strokeLinecap="round" />
          <path className="aj-smile" d="M-12 25 Q 0 35 12 25" fill="none" stroke="#6b2d1e" strokeWidth="3.4" strokeLinecap="round" />
          <path className="aj-flat" d="M-7 28 L 7 27" fill="none" stroke="#6b2d1e" strokeWidth="3" strokeLinecap="round" />
          <ellipse className="aj-yawn" cx="0" cy="27" rx="7" ry="7" fill="#5a1d14" stroke="#1b1400" strokeWidth="1.5" />
          <path
            d="M0 14 C -8 6, -24 5, -34 14 C -39 19, -46 19, -50 14 C -46 28, -28 31, -14 23 C -7 19, -3 18, 0 21 C 3 18, 7 19, 14 23 C 28 31, 46 28, 50 14 C 46 19, 39 19, 34 14 C 24 5, 8 6, 0 14 Z"
            fill="#3b2a1e"
          />
          <g className="aj-shades">
            <rect x="-36" y="-22" width="30" height="20" rx="7" fill="#0b0f14" />
            <rect x="6" y="-22" width="30" height="20" rx="7" fill="#0b0f14" />
            <rect x="-8" y="-16" width="16" height="5" fill="#0b0f14" />
            <rect x="-31" y="-19" width="10" height="4" rx="2" fill="#fff" opacity="0.55" />
            <path className="aj-glint" d="M-35 -32 Q -33.6 -22.4 -24 -21 Q -33.6 -19.6 -35 -10 Q -36.4 -19.6 -46 -21 Q -36.4 -22.4 -35 -32 Z" fill="#fff" />
          </g>
          <g className="aj-mug">
            <rect x="30" y="2" width="18" height="24" rx="3" fill="#fbbf24" stroke="#1b1400" strokeWidth="2.6" />
            <path d="M48 8 q 8 0 8 7 q 0 7 -8 7" fill="none" stroke="#1b1400" strokeWidth="2.6" />
            <path d="M28 4 q 3 -7 9 -4 q 4 -5 9 0 q 5 -2 5 4 Z" fill="#fff" stroke="#1b1400" strokeWidth="2" />
            <path d="M35 10 v 12 M41 10 v 12" stroke="#fff" strokeWidth="2" opacity="0.6" />
          </g>
        </g>
        <g fill="#fbbf24" stroke="#1b1400" strokeWidth="1.6">
          <path className="aj-sp aj-one" d="M44 -54 l 3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" />
          <path className="aj-sp aj-two" d="M-50 -46 l 2.4 5.6 5.6 2.4 -5.6 2.4 -2.4 5.6 -2.4 -5.6 -5.6 -2.4 5.6 -2.4 Z" />
          <path className="aj-sp aj-three" d="M50 -14 l 2 4.6 4.6 2 -4.6 2 -2 4.6 -2 -4.6 -4.6 -2 4.6 -2 Z" />
        </g>
        <text className="aj-qmark" x="34" y="-50" fontSize="30" fill="#fbbf24" stroke="#1b1400" strokeWidth="1.5">
          ?
        </text>
        <g fill="#cbd5e1" stroke="#1b1400" strokeWidth="1">
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
      </svg>
    </span>
  );
}

/** The whole 아재, small, for the kick: the same head with angry brows and a grimace, arms and legs that swing. */
function AjaeKicker() {
  return (
    <svg viewBox="0 0 64 96" xmlns="http://www.w3.org/2000/svg">
      <g className="aj-bob">
        <g className="aj-leg aj-leg-l">
          <rect x="22" y="68" width="9" height="17" rx="2" fill="#2b3445" stroke="#1b1400" strokeWidth="2" />
          <ellipse cx="25" cy="87" rx="6.5" ry="3.6" fill="#1b1400" />
        </g>
        <g className="aj-leg aj-leg-r">
          <rect x="33" y="68" width="9" height="17" rx="2" fill="#2b3445" stroke="#1b1400" strokeWidth="2" />
          <ellipse cx="40" cy="87" rx="6.5" ry="3.6" fill="#1b1400" />
        </g>
        <rect x="20" y="62" width="24" height="9" rx="2" fill="#2b3445" stroke="#1b1400" strokeWidth="2" />
        <g className="aj-arm aj-arm-l">
          <path d="M21 48 L 12 62" stroke="#1b1400" strokeWidth="7" strokeLinecap="round" />
          <path d="M21 48 L 12 62" stroke="#ff4d5a" strokeWidth="4.4" strokeLinecap="round" />
          <circle cx="11.5" cy="63.5" r="3.4" fill="#f2c48d" stroke="#1b1400" strokeWidth="1.6" />
        </g>
        <g className="aj-arm aj-arm-r">
          <path d="M43 48 L 52 62" stroke="#1b1400" strokeWidth="7" strokeLinecap="round" />
          <path d="M43 48 L 52 62" stroke="#ff4d5a" strokeWidth="4.4" strokeLinecap="round" />
          <circle cx="52.5" cy="63.5" r="3.4" fill="#f2c48d" stroke="#1b1400" strokeWidth="1.6" />
        </g>
        <path d="M18 47 Q 32 40 46 47 L 44 65 L 20 65 Z" fill="#ff4d5a" stroke="#1b1400" strokeWidth="2.2" strokeLinejoin="round" />
        <g fill="#fff" opacity="0.9">
          <circle cx="24" cy="56" r="1.8" />
          <circle cx="39" cy="58" r="1.8" />
          <circle cx="31" cy="61" r="1.5" />
        </g>
        <path d="M26 45 Q 32 53 38 45" fill="none" stroke="#fbbf24" strokeWidth="2.4" />
        <g transform="translate(32 25) scale(0.4)">
          <ellipse cx="0" cy="-12" rx="44" ry="48" fill="#f2c48d" stroke="#1b1400" strokeWidth="5" />
          <ellipse cx="-12" cy="-48" rx="12" ry="6" fill="#fff" opacity="0.7" />
          <path d="M-44 -10 C -50 -30, -44 -44, -32 -50 C -36 -38, -38 -24, -36 -6 Z" fill="#3b2a1e" />
          <path d="M44 -10 C 50 -30, 44 -44, 32 -50 C 36 -38, 38 -24, 36 -6 Z" fill="#3b2a1e" />
          <path d="M-30 -36 L -10 -26 M30 -36 L 10 -26" stroke="#3b2a1e" strokeWidth="7" strokeLinecap="round" />
          <rect x="-9" y="22" width="18" height="7" rx="2" fill="#fff" stroke="#1b1400" strokeWidth="2.4" />
          <path
            d="M0 14 C -8 6, -24 5, -34 14 C -39 19, -46 19, -50 14 C -46 28, -28 31, -14 23 C -7 19, -3 18, 0 21 C 3 18, 7 19, 14 23 C 28 31, 46 28, 50 14 C 46 19, 39 19, 34 14 C 24 5, 8 6, 0 14 Z"
            fill="#3b2a1e"
          />
          <rect x="-36" y="-22" width="30" height="20" rx="7" fill="#0b0f14" />
          <rect x="6" y="-22" width="30" height="20" rx="7" fill="#0b0f14" />
          <rect x="-8" y="-16" width="16" height="5" fill="#0b0f14" />
          <rect x="-31" y="-19" width="10" height="4" rx="2" fill="#fff" opacity="0.55" />
        </g>
      </g>
    </svg>
  );
}
