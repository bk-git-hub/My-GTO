import { describe, expect, it } from "vitest";
import { BUBBLE_FORMS, HAND_CARDS, HOT_LIFT, layoutTable, seatSpots, TABLE_W, UNDO_GAP, UNDO_MIN, type SeatIn, type Size, type TableIn, type TableOut } from "./tableLayout";

/** Table widths from a 320px phone (12px page gutters) up to the 400px cap. */
const WIDTHS = [296, 336, 366, 390, 400];
const LABEL: Size = [58, 33];
const HERO_LABEL: Size = [70, 33];
const BUB: Size[] = [[55, 27], [67, 17], [47, 14]];

type Box = { x0: number; y0: number; x1: number; y1: number };
const apart = (a: Box, b: Box) => a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
const hgap = (a: Box, b: Box) => Math.max(b.x0 - a.x1, a.x0 - b.x1);
const level = (a: Box, b: Box) => a.y0 < b.y1 && b.y0 < a.y1;
const inTable = (a: Box, o: TableOut) => a.x0 >= 0 && a.y0 >= 0 && a.x1 <= o.width && a.y1 <= o.height;

function handBoxes(t: TableIn, o: TableOut, k: number): Box[] {
  const h = o.hands[k]!;
  const [lw, lh] = t.seats[k].hand!.label;
  const cardsW = 2 * h.cw + 2, H = h.ch + 3 + lh, top = h.y - H / 2;
  return [
    { x0: h.x - cardsW / 2, y0: top, x1: h.x + cardsW / 2, y1: top + h.ch },
    { x0: h.x - lw / 2, y0: top + h.ch + 3, x1: h.x + lw / 2, y1: top + H },
  ];
}
/** The pot, the board row, and the "역전" badge over the hot card, as RaceTable draws them. */
function centerBoxes(t: TableIn, o: TableOut): Box[] {
  const nb = t.board ?? 0;
  const bw = nb ? nb * o.board.cw + (nb - 1) * o.board.gap : 0, bh = nb ? o.board.ch : 0;
  const [pw, ph] = t.pot ?? [0, 0];
  const gap = t.pot && t.board !== null ? o.centerGap : 0;
  const total = ph + gap + bh, top = o.center - total / 2, mid = o.width / 2, boardTop = top + ph + gap;
  const out: Box[] = [];
  if (t.pot) out.push({ x0: mid - pw / 2, y0: top, x1: mid + pw / 2, y1: top + ph });
  if (nb) out.push({ x0: mid - bw / 2, y0: boardTop, x1: mid + bw / 2, y1: boardTop + bh });
  if (t.hot) {
    const x = mid - bw / 2 + t.hot.slot * (o.board.cw + o.board.gap) + o.board.cw / 2, [tw, th] = t.hot.tag;
    out.push({ x0: x - tw / 2, y0: boardTop - HOT_LIFT, x1: x + tw / 2, y1: boardTop - HOT_LIFT + th });
  }
  return out;
}

/** The 되돌리기 pill at the widest the layout lets it be drawn. */
function undoBox(o: TableOut): Box {
  const u = o.undo!;
  return { x0: u.x - u.w / 2, y0: u.y - u.h / 2, x1: u.x + u.w / 2, y1: u.y + u.h / 2 };
}
/** A bubble in the form it was laid out in, with its order number on the top-left corner. */
function bubbleBoxes(t: TableIn, o: TableOut, k: number): Box[] {
  const b = o.bubbles[k]!;
  const [w, h] = t.seats[k].bubble![BUBBLE_FORMS.indexOf(b.form)];
  const x0 = b.x - w / 2, y0 = b.y - h / 2;
  return [{ x0, y0, x1: x0 + w, y1: y0 + h }, { x0: x0 - 5.5, y0: y0 - 5.5, x1: x0 + 8.5, y1: y0 + 8.5 }];
}
/** How far a disc and a box are apart (negative: overlap). */
function discGap(cx: number, cy: number, r: number, b: Box): number {
  return Math.hypot(cx - Math.max(b.x0, Math.min(cx, b.x1)), cy - Math.max(b.y0, Math.min(cy, b.y1))) - r;
}
/** The 되돌리기 pill with a long echo: as wide as it asks, it is a full board's width or more. */
const PILL: Size = [170, 40];
/** Recording: every seat betting, the turn and "나" tags, the D button, my cards and the 되돌리기 pill. */
const recording = (width: number, n: number, board: number, betting: (k: number) => boolean = () => true, turn = 1, pill: Size = PILL): TableIn => ({
  compact: false,
  width,
  seats: Array.from({ length: n }, (_, k): SeatIn => ({ ...(betting(k) ? { bubble: BUB } : {}), ...(k === 0 ? { me: [22, 13] as Size } : {}), ...(k === turn % n ? { tag: [30, 15] as Size } : {}) })),
  dealer: n - 1,
  heroCards: true,
  pot: [96, 23],
  board,
  hot: null,
  undo: pill,
});
/** A full five-card board's width at the card size laid out. */
const fullBoard = (o: TableOut) => 5 * o.board.cw + 4 * o.board.gap;

const result = (width: number, n: number, withHand: number[], board: number): TableIn => ({
  compact: false,
  width,
  seats: Array.from({ length: n }, (_, k): SeatIn => (withHand.includes(k) ? { hand: { label: k === 0 ? HERO_LABEL : LABEL, hero: k === 0 } } : {})),
  dealer: null,
  heroCards: false,
  pot: [64, 23],
  board,
  hot: null,
});

describe("race table layout", () => {
  it("keeps the BB's hand off the board (9-handed, me UTG+1, heads-up vs the BB at the turn and river)", () => {
    // me UTG+1 at slot 0, the BB 7 seats clockwise: the right side at board height
    for (const width of WIDTHS)
      for (const board of [3, 4, 5]) {
        const t = result(width, 9, [0, 7], board);
        const o = layoutTable(t);
        expect(o.clash).toBe(0);
        for (const h of handBoxes(t, o, 7)) {
          for (const c of centerBoxes(t, o)) expect(apart(h, c)).toBe(true);
          expect(inTable(h, o)).toBe(true);
        }
        // my hand keeps its full-size cards
        expect(o.hands[0]).toMatchObject(HAND_CARDS[0]);
      }
  });

  it("leaves a roomy table as it was: hands 16 units inward of their seats, full-size cards, a 30px board", () => {
    const t = result(400, 6, [0, 3], 3);
    const o = layoutTable(t);
    const s = 400 / TABLE_W, spot = seatSpots(6, false)[3];
    expect(o.board.cw).toBe(30);
    expect(o.hands[3]).toMatchObject({ ...HAND_CARDS[0] });
    expect(o.hands[3]!.x).toBeCloseTo((spot.x + spot.ux * 16) * s, 5);
    expect(o.hands[3]!.y).toBeCloseTo((spot.y + spot.uy * 16) * s, 5);
  });

  it("fits every live hand at a full ten-handed table, even on a 320px phone", () => {
    for (const width of WIDTHS)
      for (const n of [8, 9, 10]) {
        const all = Array.from({ length: n }, (_, k) => k);
        const t = result(width, n, all, 5);
        const o = layoutTable(t);
        expect(o.clash).toBe(0);
        const boxes = all.map((k) => handBoxes(t, o, k));
        for (let i = 0; i < n; i++) {
          for (const b of boxes[i]) {
            expect(inTable(b, o)).toBe(true);
            for (const c of centerBoxes(t, o)) expect(apart(b, c)).toBe(true);
            for (let j = i + 1; j < n; j++) for (const b2 of boxes[j]) expect(apart(b, b2)).toBe(true);
          }
        }
        expect(o.hands[0]).toMatchObject(HAND_CARDS[0]);
      }
  });

  it("finds a clear spot for a bet bubble on every seat while recording", () => {
    for (const width of WIDTHS)
      for (const n of [2, 6, 9, 10]) {
        const t: TableIn = {
          compact: false,
          width,
          seats: Array.from({ length: n }, (_, k): SeatIn => ({ bubble: BUB, ...(k === 0 ? { me: [22, 13] as Size } : {}), ...(k === 1 ? { tag: [30, 15] as Size } : {}) })),
          dealer: n - 3 >= 0 ? n - 3 : 0,
          heroCards: true,
          pot: [96, 23],
          board: 5,
          hot: null,
        };
        const o = layoutTable(t);
        expect(o.clash).toBe(0);
        expect(o.bubbles.filter(Boolean)).toHaveLength(n);
      }
  });

  it("still places everything, in bounded passes, on a table narrower than any phone", () => {
    const t: TableIn = { compact: false, width: 200, seats: Array.from({ length: 10 }, (): SeatIn => ({ bubble: BUB })), dealer: 7, heroCards: true, pot: [96, 23], board: 5, hot: null };
    const o = layoutTable(t);
    expect(o.bubbles.filter(Boolean)).toHaveLength(10);
    expect(o.dealer).not.toBeNull();
    expect(o.heroCards).not.toBeNull();
  });

  it("keeps the BB's cards well apart from the board row when they sit level with it, so they don't read as more board cards", () => {
    for (const width of [366, 400])
      for (const board of [4, 5]) {
        const t = result(width, 9, [0, 7], board);
        const o = layoutTable(t);
        const [cards] = handBoxes(t, o, 7), row = centerBoxes(t, o)[1];
        expect(level(cards, row)).toBe(true);
        expect(hgap(cards, row)).toBeGreaterThanOrEqual(12 - 1e-6);
        expect(o.hands[7]).toMatchObject(HAND_CARDS[0]);
        expect(o.board.cw).toBe(30);
      }
  });

  it("keeps hands off the 역전 badge over the card that flipped the lead", () => {
    // 4-handed on a 330px phone, me CO 3-way vs the BTN and the BB, the BB's set on the river flipped the lead
    const flip = (width: number, n: number, live: number[], board: number): TableIn => ({ ...result(width, n, live, board), hot: { slot: board - 1, tag: [28, 9.6] } });
    const cases = [flip(306, 4, [0, 1, 3], 5), ...WIDTHS.flatMap((w) => [3, 4, 5].flatMap((b) => [flip(w, 4, [0, 1, 3], b), flip(w, 7, [0, 2, 5], b), flip(w, 10, [0, 3, 7], b), flip(w, 9, [0, 7], b)]))];
    for (const t of cases) {
      const o = layoutTable(t);
      expect(o.clash).toBe(0);
      const badge = centerBoxes(t, o).at(-1)!;
      for (const k of t.seats.flatMap((x, k) => (x.hand ? [k] : []))) for (const b of handBoxes(t, o, k)) expect(apart(b, badge)).toBe(true);
    }
  });

  it("lifts the pot clear of the 역전 badge on the flop and leaves the board where it was", () => {
    const plain = result(366, 6, [0, 3], 3);
    const hot: TableIn = { ...plain, pot: [92, 23], hot: { slot: 2, tag: [28, 9.6] } };
    const a = layoutTable({ ...plain, pot: [92, 23] }), b = layoutTable(hot);
    const [potA, rowA] = centerBoxes({ ...plain, pot: [92, 23] }, a), [potB, rowB, badge] = centerBoxes(hot, b);
    expect(rowB.y0).toBeCloseTo(rowA.y0, 6);
    expect(potB.y1).toBeLessThan(potA.y1);
    expect(apart(potB, badge)).toBe(true);
    expect(badge.y0 - potB.y1).toBeGreaterThanOrEqual(2 - 1e-6);
  });

  it("keeps the D button nearer the button's seat than any other, even on a crowded table", () => {
    for (const width of WIDTHS)
      for (const n of [6, 8, 9, 10])
        for (const me of [0, 1, 2]) {
          // every seat betting, me in the small blind (the D's usual spot is toward my seat)
          const btn = (n - 1 - me + n) % n;
          const t: TableIn = {
            compact: false,
            width,
            seats: Array.from({ length: n }, (_, k): SeatIn => ({ bubble: BUB, ...(k === 0 ? { me: [22, 13] as Size } : {}) })),
            dealer: btn,
            heroCards: true,
            pot: [96, 23],
            board: 3,
            hot: null,
          };
          const o = layoutTable(t);
          const s = width / TABLE_W, spots = seatSpots(n, false).map((p) => ({ x: p.x * s, y: p.y * s }));
          const d = (k: number) => Math.hypot(o.dealer!.x - spots[k].x, o.dealer!.y - spots[k].y);
          for (let k = 0; k < n; k++) if (k !== btn) expect(d(btn)).toBeLessThan(d(k));
        }
  });

  it("keeps every seat, bubble, the D button and my cards clear of the 되돌리기 pill while recording", () => {
    for (const width of WIDTHS)
      for (const n of [2, 4, 6, 9, 10])
        for (const board of [0, 3, 5]) {
          const t = recording(width, n, board);
          const o = layoutTable(t);
          expect(o.clash, `${width} ${n} ${board}`).toBe(0);
          const u = undoBox(o);
          expect(inTable(u, o)).toBe(true);
          const s = width / TABLE_W;
          seatSpots(n, false).forEach((p, k) => {
            expect(discGap(p.x * s, p.y * s, 27, u)).toBeGreaterThan(0);
            for (const b of bubbleBoxes(t, o, k)) expect(apart(b, u)).toBe(true);
          });
          expect(discGap(o.dealer!.x, o.dealer!.y, 10, u)).toBeGreaterThan(0);
          expect(apart({ x0: o.heroCards!.x - 24, y0: o.heroCards!.y - 16, x1: o.heroCards!.x + 24, y1: o.heroCards!.y + 16 }, u)).toBe(true);
        }
  });

  it("hangs the pill centred right under the board row (under the pot before the flop), no wider than its echo or a full board", () => {
    for (const width of WIDTHS)
      for (const n of [3, 6, 9])
        for (const board of [0, 3, 4, 5])
          for (const pill of [PILL, [96, 40] as Size, [130, 40] as Size]) {
            const t = recording(width, n, board, (k) => k === 1, 1, pill);
            const o = layoutTable(t);
            const u = undoBox(o), [pot, row] = centerBoxes(t, o);
            expect(u.y0 - (board ? row : pot).y1).toBeCloseTo(UNDO_GAP, 6);
            expect(o.undo!.x).toBeCloseTo(o.width / 2, 6);
            expect(o.undo!.h).toBeCloseTo(40, 6);
            expect(o.undo!.w).toBeGreaterThanOrEqual(Math.min(UNDO_MIN, pill[0]));
            expect(o.undo!.w).toBeLessThanOrEqual(Math.min(pill[0], fullBoard(o)) + 1e-6);
          }
  });

  it("keeps the board's full-size cards and draws the pill a full board wide on a phone the width of mine", () => {
    for (const width of [366, 390, 400])
      for (let n = 2; n <= 10; n++)
        for (const board of [3, 4, 5]) {
          const o = layoutTable(recording(width, n, board, (k) => k === 0 || k === Math.floor(n / 2)));
          expect(o.board.cw, `${width} ${n} ${board}`).toBe(30);
          expect(o.undo!.w).toBeCloseTo(fullBoard(o), 6);
        }
  });

  it("never gives the board smaller cards than the same table without the pill, on a phone 360px or wider", () => {
    for (const width of WIDTHS.slice(1))
      for (let n = 2; n <= 10; n++)
        for (const board of [3, 4, 5])
          for (const betting of [() => false, (k: number) => k === 0 || k === Math.floor(n / 2), () => true]) {
            const t = recording(width, n, board, betting);
            expect(layoutTable(t).board.cw, `${width} ${n} ${board}`).toBeGreaterThanOrEqual(layoutTable({ ...t, undo: null }).board.cw);
          }
  });

  it("keeps the pill (and the pot and board) in one spot whatever its echo says or whose turn it is, on a phone 360px or wider", () => {
    // (on a 320px phone the "차례" tag can be in the column's way on a few tables: it moves to the nearest clear spot)
    for (const width of WIDTHS.slice(1))
      for (const n of [2, 6, 7, 9, 10])
        for (const board of [0, 3, 5]) {
          const at = layoutTable(recording(width, n, board, () => false)).undo!;
          for (let turn = 0; turn < n; turn++)
            for (const pill of [PILL, [96, 40] as Size]) {
              const o = layoutTable(recording(width, n, board, () => false, turn, pill));
              expect(o.undo!.y, `${width} ${n} ${board} ${turn}`).toBeCloseTo(at.y, 6);
            }
        }
  });

  it("doesn't move the pill (or the pot and board) as the bets come in, on a phone 360px or wider", () => {
    // (on a 320px phone, ten-handed, my own bet can still lift the column a little to make room for my cards)
    for (const width of WIDTHS.slice(1))
      for (const n of [2, 6, 9, 10])
        for (const board of [0, 3, 5]) {
          const before = layoutTable(recording(width, n, board, () => false));
          for (let k = 0; k < n; k++) {
            const o = layoutTable(recording(width, n, board, (j) => j === k));
            expect(o.undo!.y, `${width} ${n} ${board} ${k}`).toBeCloseTo(before.undo!.y, 6);
            expect(o.center).toBeCloseTo(before.center, 6);
          }
        }
  });

  it("draws no pill where none is asked for (the result replay, the setup table)", () => {
    expect(layoutTable(result(366, 9, [0, 7], 5)).undo).toBeNull();
    expect(layoutTable({ ...recording(366, 9, 3), undo: null }).undo).toBeNull();
  });

  it("lays out before the table is measured (server render) at the unit size", () => {
    const o = layoutTable(result(0, 9, [0, 7], 4));
    expect(o.width).toBe(TABLE_W);
    expect(o.clash).toBe(0);
  });
});
