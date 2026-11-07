/**
 * Where the pieces of the race table go (RaceTable in TableFlow.tsx).
 *
 * Seats sit on a racetrack drawn in a 358-unit-wide box and scale with the table, but cards, labels and
 * bubbles keep their px size. So on a narrow phone, with nine or ten seats or with a five-card board,
 * a hand on a side seat would sit on the board and bubbles on the pot. Here everything that floats (the
 * board's card size, the hands, the bet bubbles, the D button and my two cards) is placed in px of the
 * table's real width: each near its seat, clear of the pot and board, of the seats and of what was
 * placed before it, and inside the table. A hand slides toward the rail first, then along it; when no
 * spot is clear a hand takes smaller cards (never mine) and a bubble a tighter form, then the board
 * takes smaller cards. A roomy table looks exactly as before. The "역전" badge over the card that flipped
 * the lead counts as part of the board, and a hand level with the board row keeps a wider gap from it.
 */

/** The table's unit box: positions are laid out in units of a 358-wide table. */
export const TABLE_W = 358;

/** Room kept between two things on the table (px). */
const GAP = 2;
/** Room kept around the pot and board: a hand or seat right against the board reads as part of it. */
const BOARD_GAP = 6;
/**
 * Room kept beside the board row for a hand level with it: any closer, its cards read as more board
 * cards. Only while it costs nothing else: a table that needs it dropped gets BOARD_GAP before any card shrinks.
 */
const ROW_GAP = 12;
/** Room kept inside the table's edge (px). */
const EDGE = 1;
/** Seat circle radius (.rt-seat is 54px wide). */
const SEAT_R = 27;
const DEALER_R = 10;
/** My two small cards next to my seat (.rt-card.small 23x32, gap 2). */
const HERO_CARDS: Size = [48, 32];
/** Gap between the pot pill and the board row (.rt-center gap). */
const CENTER_GAP = 7;
/** The "역전" badge sits this far above the top of the card that flipped the lead (.rt-hottag top). */
export const HOT_LIFT = 17;
/** The D button stays at least this much nearer its own seat than any other, so it reads as that seat's. */
const DEALER_OWN = 4;
/** Most placement passes tried for one table. */
const MAX_RUNS = 48;

export type Size = readonly [w: number, h: number];
export interface Pt {
  x: number;
  y: number;
}
export interface CardSize {
  cw: number;
  ch: number;
}

/** Hand cards: full size, then smaller for a side seat when nothing else fits. */
export const HAND_CARDS: readonly CardSize[] = [
  { cw: 33, ch: 46 },
  { cw: 28, ch: 39 },
  { cw: 24, ch: 34 },
];
const BOARD_MAX = 30;
const BOARD_MIN = 21;
export const boardCard = (cw: number): CardSize & { gap: number } => ({ cw, ch: Math.round(cw * 1.4), gap: cw >= 27 ? 4 : 3 });

export interface TableGeometry {
  W: number;
  H: number;
  RW: number;
  RH: number;
  cx: number;
  cy: number;
  left: number;
  top: number;
  r: number;
  P: number;
  /** Point on the seat track at track position `s`, and the point inward it faces. */
  at: (s: number) => [x: number, y: number, ox: number, oy: number];
}

/** The racetrack in table units: rail, felt, and the track the seats sit on. */
export function tableGeometry(compact: boolean): TableGeometry {
  const W = TABLE_W, RW = compact ? 224 : 240, RH = compact ? 326 : 350, H = RH + 56;
  const cx = W / 2, cy = H / 2, left = cx - RW / 2, top = cy - RH / 2, r = RW / 2;
  const a = RW / 2 - 7, hh = (RH - RW) / 2, arc = Math.PI * a, P = 2 * arc + 4 * hh;
  const at = (s: number): [number, number, number, number] => {
    s = ((s % P) + P) % P;
    const seg = [arc / 2, 2 * hh, arc, 2 * hh, arc / 2];
    const polar = (oy: number, deg: number): [number, number, number, number] => [cx + a * Math.cos((deg * Math.PI) / 180), oy + a * Math.sin((deg * Math.PI) / 180), cx, oy];
    let t = s;
    if (t < seg[0]) return polar(cy + hh, 90 + (t / seg[0]) * 90);
    t -= seg[0];
    if (t < seg[1]) return [cx - a, cy + hh - t, cx, cy + hh - t];
    t -= seg[1];
    if (t < seg[2]) return polar(cy - hh, 180 + (t / seg[2]) * 180);
    t -= seg[2];
    if (t < seg[3]) return [cx + a, cy - hh + t, cx, cy - hh + t];
    t -= seg[3];
    return polar(cy + hh, (t / seg[4]) * 90);
  };
  return { W, H, RW, RH, cx, cy, left, top, r, P, at };
}

/** A seat on the track (units): where it sits, which way is inward, and whether it is on a straight side. */
export interface Spot {
  x: number;
  y: number;
  ux: number;
  uy: number;
  side: boolean;
  /** Track position. */
  t: number;
}

/** Seats spaced evenly along the track: slot 0 (me) at the bottom, then clockwise. */
export function seatSpots(n: number, compact: boolean): Spot[] {
  const g = tableGeometry(compact);
  return Array.from({ length: n }, (_, k) => {
    const t = (k * g.P) / n;
    const [x, y, ox, oy] = g.at(t);
    const L = Math.hypot(ox - x, oy - y) || 1;
    const ux = (ox - x) / L, uy = (oy - y) / L;
    return { x, y, ux, uy, side: Math.abs(ux) > 0.75, t };
  });
}

// ───────────── shapes ─────────────

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Disc {
  cx: number;
  cy: number;
  rad: number;
}
type Shape = Rect | Disc;
const isDisc = (s: Shape): s is Disc => (s as Disc).rad !== undefined;
const rect = (x0: number, y0: number, w: number, h: number): Rect => ({ x0, y0, x1: x0 + w, y1: y0 + h });
const centered = (x: number, y: number, [w, h]: Size): Rect => rect(x - w / 2, y - h / 2, w, h);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** How far two shapes overlap (px); negative is the gap between them. */
function depth(a: Shape, b: Shape): number {
  if (isDisc(a) && isDisc(b)) return a.rad + b.rad - Math.hypot(a.cx - b.cx, a.cy - b.cy);
  if (isDisc(a) || isDisc(b)) {
    const c = (isDisc(a) ? a : b) as Disc, q = (isDisc(a) ? b : a) as Rect;
    const nx = clamp(c.cx, q.x0, q.x1), ny = clamp(c.cy, q.y0, q.y1);
    if (nx === c.cx && ny === c.cy) return c.rad + Math.min(c.cx - q.x0, q.x1 - c.cx, c.cy - q.y0, q.y1 - c.cy);
    return c.rad - Math.hypot(c.cx - nx, c.cy - ny);
  }
  const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (dx > 0 && dy > 0) return Math.min(dx, dy);
  if (dx <= 0 && dy <= 0) return -Math.hypot(dx, dy);
  return Math.min(dx, dy);
}

/** Shapes and the room kept around them. */
interface Group {
  shapes: Shape[];
  gap: number;
  /** Only this one of the item's shapes keeps the room (a hand's cards, not its label). */
  only?: number;
}

/** How far `item` comes inside the room kept around `others` (0 = clear); stops counting at `stop`. */
function clash(item: Shape[], others: Group[], stop = Infinity): number {
  let worst = 0;
  for (const o of others) {
    const i0 = o.only ?? 0, i1 = o.only === undefined ? item.length : Math.min(item.length, o.only + 1);
    for (let i = i0; i < i1; i++)
      for (const b of o.shapes) {
        const d = depth(item[i], b) + o.gap;
        if (d > worst && (worst = d) >= stop) return worst;
      }
  }
  return worst;
}

function inside(item: Shape[], w: number, h: number): boolean {
  return item.every((s) =>
    isDisc(s) ? s.cx - s.rad >= EDGE && s.cy - s.rad >= EDGE && s.cx + s.rad <= w - EDGE && s.cy + s.rad <= h - EDGE : s.x0 >= EDGE && s.y0 >= EDGE && s.x1 <= w - EDGE && s.y1 <= h - EDGE,
  );
}

// ───────────── searching for a spot ─────────────

interface Want {
  /** The item's shapes with its center at (x, y). */
  at: (x: number, y: number) => Shape[];
  pref: Pt;
  /** Inward direction at the seat: moving inward costs `wIn` per px, outward `wOut`, sideways 1. */
  u: Pt;
  wIn: number;
  wOut: number;
  reach: number;
  step: number;
  /** Extra soft cost of a spot (a bubble drifting nearer another seat than its own). */
  stray?: (x: number, y: number) => number;
}

const offsetCache = new Map<string, [number, number, number][]>();
/** Moves within `reach` px, cheapest first. */
function offsets(w: Want): [number, number, number][] {
  const key = `${w.reach}|${w.step}|${w.u.x.toFixed(2)}|${w.u.y.toFixed(2)}|${w.wIn}|${w.wOut}`;
  const hit = offsetCache.get(key);
  if (hit) return hit;
  const out: [number, number, number][] = [];
  for (let dx = -w.reach; dx <= w.reach; dx += w.step) {
    for (let dy = -w.reach; dy <= w.reach; dy += w.step) {
      if (dx * dx + dy * dy > w.reach * w.reach) continue;
      const along = dx * w.u.x + dy * w.u.y;
      const across = Math.abs(dy * w.u.x - dx * w.u.y);
      out.push([dx, dy, across + (along > 0 ? along * w.wIn : -along * w.wOut)]);
    }
  }
  out.sort((p, q) => p[2] - q[2]);
  if (offsetCache.size > 400) offsetCache.clear();
  offsetCache.set(key, out);
  return out;
}

/** Per candidate spot: its clash with what never moves (NaN until checked, Infinity outside the table), and its soft cost. */
interface Memo {
  fixed: Float64Array;
  soft: Float64Array;
}
const memoFor = (w: Want): Memo => {
  const k = offsets(w).length;
  return { fixed: new Float64Array(k).fill(NaN), soft: new Float64Array(k).fill(NaN) };
};

/**
 * The cheapest spot that clears every hard shape (`fixed` ones that never move, and `moving` ones
 * placed before) and every `soft` one (folded seats), and stays inside the table. Failing that, the
 * cheapest that clears the hard ones and comes least into the soft ones; failing that, the one that
 * clashes least. `memo` keeps the checks against fixed and soft shapes from one plan to the next.
 */
function search(w: Want, fixed: Group[], moving: Group[], soft: Group[], width: number, height: number, memo: Memo = memoFor(w)): Pt & { clash: number; soft: number } {
  let near: Pt | null = null, nearSoft = Infinity;
  let least: Pt | null = null, leastClash = Infinity;
  const offs = offsets(w);
  for (let i = 0; i < offs.length; i++) {
    const x = w.pref.x + offs[i][0], y = w.pref.y + offs[i][1];
    let shapes: Shape[] | null = null;
    let c = memo.fixed[i];
    if (Number.isNaN(c)) {
      shapes = w.at(x, y);
      c = memo.fixed[i] = inside(shapes, width, height) ? clash(shapes, fixed) : Infinity;
    }
    if (c === Infinity || c >= leastClash) continue;
    shapes ??= w.at(x, y);
    c = Math.max(c, clash(shapes, moving, leastClash));
    if (c > 0) {
      if (c < leastClash - 1e-6) (leastClash = c), (least = { x, y });
      continue;
    }
    let sc = memo.soft[i];
    if (Number.isNaN(sc)) sc = memo.soft[i] = (soft.length ? clash(shapes, soft) : 0) + (w.stray ? w.stray(x, y) : 0);
    if (sc === 0) return { x, y, clash: 0, soft: 0 };
    if (sc < nearSoft - 1e-6) (nearSoft = sc), (near = { x, y });
  }
  if (near) return { ...near, clash: 0, soft: nearSoft };
  if (least) return { ...least, clash: leastClash, soft: 0 };
  return { ...w.pref, clash: clash(w.at(w.pref.x, w.pref.y), [...fixed, ...moving]) + 1, soft: 0 };
}

// ───────────── the table ─────────────

export interface SeatIn {
  /** A hand shown in place of the seat: its label's px size, and whether it is mine. */
  hand?: { label: Size; hero: boolean };
  /** The seat's bet bubble, px size in each form (BUBBLE_FORMS), roomiest first. */
  bubble?: readonly Size[];
  /** The "차례" tag above the seat, px size. */
  tag?: Size;
  /** The "나" tag below the seat, px size. */
  me?: Size;
}

/**
 * A bet bubble's forms: the action over the amount, the two on one line, and the amount alone (its
 * colour still tells the action, and the numbered list under the table spells it out).
 */
export const BUBBLE_FORMS = ["", "row", "mini"] as const;
export type BubbleForm = (typeof BUBBLE_FORMS)[number];

export interface TableIn {
  compact: boolean;
  /** The table's real width (px); 0 before it is measured. */
  width: number;
  /** Slot order: 0 is me at the bottom, then clockwise. */
  seats: SeatIn[];
  /** Slot whose seat shows the D button, null when none is drawn. */
  dealer: number | null;
  /** My two small cards next to my seat. */
  heroCards: boolean;
  /** The pot pill's px size, null when there is none. */
  pot: Size | null;
  /** Card slots on the board row (cards and empty slots); null when there is no board row. */
  board: number | null;
  /** The card that flipped the lead (its slot on the board row) and the px size of its "역전" badge; null when none. */
  hot: { slot: number; tag: Size } | null;
}

export interface TableOut {
  width: number;
  height: number;
  board: CardSize & { gap: number };
  /** y of the pot + board block's center (px), and the gap between the pot and the board row. */
  center: number;
  centerGap: number;
  /** Hand centers and their card size, by slot. */
  hands: ((Pt & CardSize) | undefined)[];
  /** Bubble centers and forms, by slot. */
  bubbles: ((Pt & { form: BubbleForm }) | undefined)[];
  dealer: Pt | null;
  heroCards: Pt | null;
  /** How far the "차례" tag sits above its seat and the "나" tag below it (px), by slot. */
  tagLift: number[];
  meDrop: number[];
  /** Overlap left after the best effort (0: nothing touches); `soft`: hands on folded seats, bubbles nearer another seat. */
  clash: number;
  soft: number;
}

interface Plan {
  boardCw: number;
  /** Per slot: HAND_CARDS index for a hand, BUBBLE_FORMS index for a bubble. */
  tiers: number[];
  /** Place the hands nearest the board first (most hemmed in), or in seat order. */
  order: "near" | "seat";
  /** Slots placed before all others (ones that found no spot when placed later). */
  first?: number[];
  /** My cards placed after the bubbles (they go wherever is left by my seat). */
  heroLast?: boolean;
  /** The pot and board raised this far (px), to leave more room below them for my cards. */
  lift?: number;
  /** Let bubbles go further from their seats (last resort on a crowded table). */
  far?: boolean;
  /** Keep a hand level with the board row ROW_GAP from it, not just BOARD_GAP. */
  row?: boolean;
}

/** `dealerStray`: how much nearer another seat than its own the D button ended (it only breaks ties between plans). */
type Run = TableOut & { clashes: number[]; dealerStray: number };

export function layoutTable(t: TableIn): TableOut {
  const g = tableGeometry(t.compact);
  const n = t.seats.length;
  const width = t.width > 0 ? t.width : g.W;
  const s = width / g.W, height = g.H * s;
  const spots = seatSpots(n, t.compact);
  const px = spots.map((p) => ({ x: p.x * s, y: p.y * s }));
  const tagLift = px.map((p) => clamp(p.y - SEAT_R - EDGE, 0, 11));
  const meDrop = px.map((p) => clamp(height - EDGE - (p.y + SEAT_R), 0, 9));

  const seatShape = (k: number): Shape[] => {
    const { x, y } = px[k];
    const out: Shape[] = [{ cx: x, cy: y, rad: SEAT_R }];
    const { tag, me } = t.seats[k];
    if (tag) out.push(rect(x - tag[0] / 2, y - SEAT_R - tagLift[k], tag[0], tag[1]));
    if (me) out.push(rect(x - me[0] / 2, y + SEAT_R + meDrop[k] - me[1], me[0], me[1]));
    return out;
  };
  /** Seats drawn as seats (a seat showing a hand is drawn as the hand). */
  const seats = Array.from({ length: n }, (_, k) => (t.seats[k].hand ? [] : seatShape(k))).flat();
  const seatRoom: Group = { shapes: seats, gap: GAP };

  /**
   * The pot pill over the board row, and the "역전" badge above the hot card. When the badge would sit
   * on the pot, the pot rises clear of it and the board stays where it was.
   */
  const block = (cw: number, lift = 0): { shapes: Rect[]; tag: Rect | null; center: number; gap: number; row: Rect | null } => {
    const c = boardCard(cw);
    const nb = t.board ?? 0;
    const bw = nb ? nb * c.cw + (nb - 1) * c.gap : 0, bh = nb ? c.ch : 0;
    const [pw, ph] = t.pot ?? [0, 0];
    const mid = width / 2, bx = mid - bw / 2;
    const hot = t.hot && t.hot.slot < nb ? t.hot : null;
    const tagX = hot ? bx + hot.slot * (c.cw + c.gap) + c.cw / 2 : 0;
    const both = !!t.pot && t.board !== null;
    // (corner to corner they may touch: the pill's rounded end leaves room)
    const under = !!hot && both && Math.abs(tagX - mid) < (pw + hot.tag[0]) / 2;
    const gap = both ? (under ? Math.max(CENTER_GAP, HOT_LIFT + GAP) : CENTER_GAP) : 0;
    const extra = both ? gap - CENTER_GAP : 0;
    const total = ph + gap + bh;
    const center = (g.cy - 4) * s - lift - extra / 2, top = center - total / 2, boardTop = top + ph + gap;
    const shapes: Rect[] = [];
    if (t.pot) shapes.push(rect(mid - pw / 2, top, pw, ph));
    if (nb) shapes.push(rect(bx, boardTop, bw, bh));
    const tag = hot ? rect(tagX - hot.tag[0] / 2, boardTop - HOT_LIFT, hot.tag[0], hot.tag[1]) : null;
    const wide = ROW_GAP - BOARD_GAP;
    return { shapes, tag, center, gap, row: nb ? rect(bx - wide, boardTop, bw + 2 * wide, bh) : null };
  };
  // The largest board that clears the seats around it (a seat may touch the badge, not cover it). When
  // what is in the way doesn't go with a smaller board (a wide pot by a seat), the board stays large.
  let fit = BOARD_MIN, least = Infinity;
  for (let cw = BOARD_MAX; cw >= BOARD_MIN; cw--) {
    const b = block(cw);
    const c = Math.max(clash(b.shapes, [{ shapes: seats, gap: BOARD_GAP - 2 }]), b.tag ? clash([b.tag], [{ shapes: seats, gap: 0 }]) : 0);
    if (c === 0) {
      fit = cw;
      break;
    }
    if (c < least - 0.5) (least = c), (fit = cw);
  }

  const handShapes = (k: number, tier: number) => {
    const [lw, lh] = t.seats[k].hand!.label;
    const { cw, ch } = HAND_CARDS[tier];
    const cardsW = 2 * cw + 2, h = ch + 3 + lh;
    return (x: number, y: number): Shape[] => {
      const top = y - h / 2;
      return [rect(x - cardsW / 2, top, cardsW, ch), rect(x - lw / 2, top + ch + 3, lw, lh)];
    };
  };
  const bubbleShapes = (b: Size) => (x: number, y: number): Shape[] => {
    const r = centered(x, y, b);
    // the order number sits on the bubble's top-left corner
    return [r, { cx: r.x0 + 1.5, cy: r.y0 + 1.5, rad: 7 }];
  };
  const bubbleSize = (k: number, tier: number): Size => {
    const forms = t.seats[k].bubble!;
    return forms[Math.min(tier, forms.length - 1)];
  };

  const memos = new Map<string, Memo>();
  const memo = (key: string, w: Want): Memo => {
    let m = memos.get(key);
    if (!m) memos.set(key, (m = memoFor(w)));
    return m;
  };

  function run(plan: Plan): Run {
    const { shapes: centerShapes, tag, center: centerY, gap: centerGap, row } = block(plan.boardCw, plan.lift);
    const ctx = `${plan.boardCw}|${plan.lift ?? 0}|${plan.row ? 1 : 0}`;
    const center: Group = { shapes: centerShapes, gap: BOARD_GAP };
    // the badge only needs to stay in sight, not to keep the board's room
    const badge: Group = { shapes: tag ? [tag] : [], gap: GAP };
    // a hand's cards level with the board row keep further from it than the board's own gap
    const rowRoom: Group = { shapes: plan.row && row ? [row] : [], gap: BOARD_GAP, only: 0 };
    const placed: Shape[] = [];
    const placedRoom: Group = { shapes: placed, gap: GAP };
    const clashes = Array<number>(n).fill(0);
    let hard = 0, soft = 0;
    const hands: TableOut["hands"] = Array(n).fill(undefined);
    const bubbles: TableOut["bubbles"] = Array(n).fill(undefined);

    // My cards beside my seat (recording): to the right, else to the left, else above it.
    let heroCards: Pt | null = null;
    const placeHeroCards = () => {
      if (!t.heroCards) return;
      const p = px[0], dx = Math.max(50 * s, SEAT_R + GAP + HERO_CARDS[0] / 2 + 1);
      const at = (x: number, y: number): Shape[] => [centered(x, y, HERO_CARDS)];
      const spots3 = [
        { pref: { x: p.x + dx, y: p.y + 2 * s }, u: { x: -1, y: 0 } },
        { pref: { x: p.x - dx, y: p.y + 2 * s }, u: { x: 1, y: 0 } },
        { pref: { x: p.x, y: p.y - SEAT_R - GAP - HERO_CARDS[1] / 2 - 1 }, u: { x: 0, y: -1 } },
      ];
      let pick: Pt & { clash: number } = { x: 0, y: 0, clash: Infinity };
      for (const o of spots3) {
        const w: Want = { at, ...o, wIn: 1.5, wOut: 1, reach: 40, step: 2 };
        const got = search(w, [center, badge, seatRoom], [placedRoom], [], width, height, memo(`m${o.u.x}${o.u.y}|${ctx}`, w));
        if (got.clash < pick.clash) pick = got;
        if (!got.clash) break;
      }
      heroCards = { x: pick.x, y: pick.y };
      hard += pick.clash;
      placed.push(...at(pick.x, pick.y));
    };
    if (!plan.heroLast) placeHeroCards();

    // Hands: mine first, then the ones most hemmed in by the board.
    const handSlots = Array.from({ length: n }, (_, k) => k).filter((k) => t.seats[k].hand);
    const prefOf = (k: number): Pt => {
      const p = spots[k];
      return { x: (p.x + p.ux * 16) * s, y: (p.y + p.uy * 16) * s };
    };
    const away = (k: number) => Math.abs(prefOf(k).y - centerY) + Math.abs(prefOf(k).x - width / 2) * 0.5;
    const rank = (k: number) => {
      const i = plan.first?.indexOf(k) ?? -1;
      return i < 0 ? 99 : i;
    };
    handSlots.sort((a, b) => (t.seats[b].hand!.hero ? 1 : 0) - (t.seats[a].hand!.hero ? 1 : 0) || rank(a) - rank(b) || (plan.order === "near" ? away(a) - away(b) : a - b));
    for (const k of handSlots) {
      const tier = t.seats[k].hand!.hero ? 0 : plan.tiers[k];
      const at = handShapes(k, tier);
      const p = spots[k];
      const w: Want = { at, pref: prefOf(k), u: { x: p.ux, y: p.uy }, wIn: 2, wOut: 0.5, reach: 57, step: 3 };
      const got = search(w, [center, badge, rowRoom], [placedRoom], [seatRoom], width, height, memo(`c${k}|${tier}|${ctx}`, w));
      hands[k] = { x: got.x, y: got.y, ...HAND_CARDS[tier] };
      clashes[k] = got.clash + got.soft;
      hard += got.clash;
      soft += got.soft;
      placed.push(...at(got.x, got.y));
    }

    // Bet bubbles, inward of their seats; the ones beside the board first.
    const bubbleSlots = Array.from({ length: n }, (_, k) => k).filter((k) => t.seats[k].bubble);
    const bubblePref = (k: number, b: Size): Pt => {
      const p = spots[k];
      const d = p.side ? 36 : 58;
      const x = (p.x + p.ux * d) * s, y = (p.y + p.uy * d) * s;
      return { x: p.side ? x + Math.sign(p.ux) * (b[0] / 2) : x, y };
    };
    const awayB = (k: number) => Math.abs(bubblePref(k, bubbleSize(k, 0)).y - centerY);
    bubbleSlots.sort((a, b) => rank(a) - rank(b) || (plan.order === "near" ? awayB(a) - awayB(b) : a - b));
    for (const k of bubbleSlots) {
      const tier = Math.min(plan.tiers[k], t.seats[k].bubble!.length - 1);
      const size = bubbleSize(k, tier);
      const at = bubbleShapes(size);
      // it stays nearer its own seat than any other, so it reads as that seat's
      const stray = (x: number, y: number) => {
        const own = Math.hypot(x - px[k].x, y - px[k].y);
        let other = Infinity;
        for (let j = 0; j < n; j++) if (j !== k) other = Math.min(other, Math.hypot(x - px[j].x, y - px[j].y));
        return Math.max(0, own - other);
      };
      const w: Want = { at, pref: bubblePref(k, size), u: { x: spots[k].ux, y: spots[k].uy }, wIn: 1.5, wOut: 1, reach: plan.far ? 80 : 56, step: 2, stray };
      const got = search(w, [center, badge, seatRoom], [placedRoom], [], width, height, memo(`b${k}|${tier}|${ctx}|${w.reach}`, w));
      bubbles[k] = { x: got.x, y: got.y, form: BUBBLE_FORMS[tier] };
      clashes[k] += got.clash + got.soft;
      hard += got.clash;
      soft += got.soft;
      placed.push(...at(got.x, got.y));
    }

    if (plan.heroLast) placeHeroCards();

    // The D button, beside its seat a little ahead on the track (or wherever is left near it, as long
    // as that is nearer its own seat than the next one: it has no label to say whose it is).
    let dealer: Pt | null = null, dealerStray = 0;
    if (t.dealer !== null) {
      const k = t.dealer;
      const [dx, dy, dox, doy] = g.at(spots[k].t + Math.min(34, g.P / n / 2));
      const dl = Math.hypot(dox - dx, doy - dy) || 1;
      const at = (x: number, y: number): Shape[] => [{ cx: x, cy: y, rad: DEALER_R }];
      const stray = (x: number, y: number) => {
        const own = Math.hypot(x - px[k].x, y - px[k].y);
        let other = Infinity;
        for (let j = 0; j < n; j++) if (j !== k) other = Math.min(other, Math.hypot(x - px[j].x, y - px[j].y));
        return Math.max(0, own - other + DEALER_OWN);
      };
      const w: Want = { at, pref: { x: (dx + ((dox - dx) / dl) * 30) * s, y: (dy + ((doy - dy) / dl) * 30) * s }, u: { x: spots[k].ux, y: spots[k].uy }, wIn: 1, wOut: 1, reach: 60, step: 2, stray };
      const got = search(w, [center, badge, seatRoom], [placedRoom], [], width, height, memo(`d|${ctx}`, w));
      dealer = { x: got.x, y: got.y };
      hard += got.clash;
      dealerStray = got.soft;
      placed.push(...at(got.x, got.y));
    }

    return { width, height, board: boardCard(plan.boardCw), center: centerY, centerGap, hands, bubbles, dealer, heroCards, tagLift, meDrop, clash: hard, soft, clashes, dealerStray };
  }

  const tie = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
  const worse = (a: Run, b: Run) => a.clash > b.clash + 1e-6 || (tie(a.clash, b.clash) && (a.soft > b.soft + 1e-6 || (tie(a.soft, b.soft) && a.dealerStray > b.dealerStray + 1e-6)));
  let best: Run | null = null, last: Run | null = null;
  // A table nothing fits on (narrower than any phone) still gets its best try, in bounded time.
  let budget = MAX_RUNS;
  const runPlan = (plan: Plan): boolean => {
    if (budget-- <= 0) return false;
    const out = (last = run(plan));
    if (!best || worse(best, out)) best = out;
    return out.clash === 0 && out.soft === 0;
  };
  /** A plan, then (`repair`) the same with whatever found no spot placed first, a few times. */
  const tryPlan = (plan: Plan, repair = 0): boolean => {
    if (runPlan(plan)) return true;
    const first = (plan.first ?? []).slice();
    for (let i = 0; i < repair; i++) {
      const stuck = last!.clashes.map((c, k) => (c > 0 ? k : -1)).filter((k) => k >= 0 && !first.includes(k));
      if (!stuck.length) break;
      first.unshift(...stuck);
      if (runPlan({ ...plan, first: first.slice() })) return true;
    }
    return false;
  };
  const finish = (): TableOut => {
    const { clashes, dealerStray, ...rest } = best!;
    void clashes;
    void dealerStray;
    return rest;
  };

  // Full-size everything (with the wider room beside the board row, then without), then smaller cards
  // (or a tighter bubble) for whatever found no clear spot, a step at a time, then for every seat, then
  // a smaller board.
  const tiers = Array<number>(n).fill(0);
  if (t.board && t.seats.some((x) => x.hand) && tryPlan({ boardCw: fit, tiers, order: "near", row: true })) return finish();
  if (tryPlan({ boardCw: fit, tiers, order: "near" })) return finish();
  const movable = (k: number) => (t.seats[k].hand && !t.seats[k].hand!.hero) || !!t.seats[k].bubble;
  for (let round = 0; round < 4; round++) {
    let grew = false;
    last!.clashes.forEach((c, k) => {
      if (c > 0 && movable(k) && tiers[k] < 2) (tiers[k]++, (grew = true));
    });
    if (!grew) break;
    if (tryPlan({ boardCw: fit, tiers: tiers.slice(), order: "near" })) return finish();
  }
  const smaller = [fit, Math.max(BOARD_MIN, fit - 3), BOARD_MIN].filter((x, i, all) => all.indexOf(x) === i);
  for (const tier of [1, 2]) {
    const all = tiers.map((x, k) => (movable(k) ? Math.max(x, tier) : x));
    for (const boardCw of smaller) if (tryPlan({ boardCw, tiers: all, order: "near" }, tier === 2 ? 3 : 1)) return finish();
  }
  // Last resort on a crowded table: bubbles may go further, my cards may go after them, the pot and
  // board may sit a little higher; then the other placing order.
  const all = tiers.map((x, k) => (movable(k) ? 2 : x));
  for (const order of ["near", "seat"] as const)
    for (const boardCw of smaller)
      for (const heroLast of t.heroCards ? [false, true] : [false])
        for (const lift of t.heroCards ? [0, 6, 12] : [0]) if (tryPlan({ boardCw, tiers: all, order, heroLast, lift, far: true }, 2)) return finish();
  return finish();
}

/** CSS variables that size a row of cards (font sizes follow the card width). */
export function cardVars(c: CardSize, kind: "hand" | "board"): Record<string, string> {
  const f = kind === "hand" ? [0.455, 0.373] : [0.45, 0.39];
  return { "--cw": `${c.cw}px`, "--ch": `${c.ch}px`, "--cf": `${Math.round(c.cw * f[0] * 10) / 10}px`, "--cs": `${Math.round(c.cw * f[1] * 10) / 10}px` };
}
