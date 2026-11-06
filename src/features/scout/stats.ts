import { handCounts, handOrder, parseShow, type Act, type ScoutHand, type ScoutSession } from "./scout";

/**
 * Per-player preflop stats from scout hands.
 *
 * - hands: hands the player was dealt into (closed hands, plus the open one once something is entered).
 * - VPIP / PFR / limp share one denominator, `opps`: hands minus the BB's walks (everyone folded to the BB,
 *   so it had no decision). VPIP = limp, call, raise, 3bet or all-in; the BB "calling" with no raise in
 *   front is a check and does not count. PFR = raise, 3bet or all-in. Limp = L with no raise in front
 *   (the SB completing counts; the BB never limps).
 * - 3bet: out of hands where the player faced a raise (a raise in front, or a raise behind their limp);
 *   counts 3bet+ and an all-in over a raise. Each player stores one action, so a "3" with no raise in
 *   front is read from the raises behind it: followed by a plain raise it is a limp-reraise (limp + 3bet
 *   over the iso), otherwise the player opened and later 4bet (a raise, not a 3bet, and no 3bet chance).
 */

export interface ShowRecord {
  no: number;
  pos: string;
  show: string;
  cls: string | null;
  won: boolean;
  act: Act | null;
}

export interface PlayerStats {
  pid: string;
  seat: number;
  name: string;
  /** Still sitting in that seat (not replaced or gone). */
  seated: boolean;
  hands: number;
  opps: number;
  vpip: number;
  pfr: number;
  limp: number;
  limpCall: number;
  threeOpps: number;
  three: number;
  shows: ShowRecord[];
}

export const SMALL_SAMPLE = 20;
const AGGRO = new Set<Act | undefined>(["R", "3", "A"]);

/** Percent rounded, or null without a sample. */
export const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((100 * n) / d) : null);

/** One hand's contribution, per player id. */
export function handFacts(h: ScoutHand) {
  const order = handOrder(h);
  const out = new Map<string, { pos: string; opp: boolean; vpip: boolean; pfr: boolean; limp: boolean; limpCall: boolean; threeOpp: boolean; three: boolean }>();
  const anyoneIn = (except: string) => order.some((x) => x.pid !== except && h.acts[x.pid]);
  const aggroAt = order.map((x) => AGGRO.has(h.acts[x.pid]));
  // the hand's first raise: the first aggressive action, unless that is a "3" with a plain raise behind
  // it (limp, iso, limp-reraise): then the iso is the first raise
  let first = aggroAt.indexOf(true);
  let limpRaiser = -1;
  if (first >= 0 && h.acts[order[first].pid] === "3") {
    const next = aggroAt.indexOf(true, first + 1);
    if (next >= 0 && h.acts[order[next].pid] === "R") [limpRaiser, first] = [first, next];
  }
  order.forEach((x, i) => {
    const a = h.acts[x.pid];
    const isBB = order.length >= 2 && i === order.length - 1;
    // everyone folded to the BB (a BB "check" entered there changes nothing)
    const walk = isBB && !anyoneIn(x.pid) && (a === undefined || a === "L");
    // they limped and a raise came behind: they faced it (a raiser facing a 3bet is a 4bet spot, left out)
    const facedBehind = a === "L" && order.some((_, j) => j > i && aggroAt[j]);
    const limpRaise = i === limpRaiser;
    const before = first >= 0 && first < i;
    const vpip = a !== undefined && !(isBB && a === "L" && !before);
    const limp = ((a === "L" && !before) || limpRaise) && !isBB;
    out.set(x.pid, {
      pos: x.pos,
      opp: !walk,
      vpip,
      pfr: AGGRO.has(a),
      limp,
      limpCall: limp && h.called.includes(x.pid),
      threeOpp: before || facedBehind || limpRaise,
      three: ((a === "3" || a === "A") && before) || limpRaise,
    });
  });
  return out;
}

export function sessionStats(s: ScoutSession): PlayerStats[] {
  const by = new Map<string, PlayerStats>();
  const seatedNow = new Set(s.occ.filter((p): p is string => !!p));
  for (const h of s.hands) {
    if (!handCounts(h)) continue;
    const facts = handFacts(h);
    for (const [pid, f] of facts) {
      const p = s.players[pid];
      if (!p || p.me) continue;
      let st = by.get(pid);
      if (!st) {
        st = { pid, seat: p.seat, name: p.name, seated: seatedNow.has(pid), hands: 0, opps: 0, vpip: 0, pfr: 0, limp: 0, limpCall: 0, threeOpps: 0, three: 0, shows: [] };
        by.set(pid, st);
      }
      st.hands++;
      if (f.opp) {
        st.opps++;
        if (f.vpip) st.vpip++;
        if (f.pfr) st.pfr++;
        if (f.limp) st.limp++;
        if (f.limpCall) st.limpCall++;
      }
      if (f.threeOpp) {
        st.threeOpps++;
        if (f.three) st.three++;
      }
      const sd = h.sd[pid];
      if (sd && (sd.show || sd.won)) {
        const parsed = parseShow(sd.show);
        st.shows.push({ no: h.no, pos: f.pos, show: parsed.ok ? parsed.norm : sd.show, cls: parsed.ok ? parsed.cls : null, won: !!sd.won, act: h.acts[pid] ?? null });
      }
    }
  }
  // loosest first; players without a VPIP sample last
  return [...by.values()].sort((a, b) => (pct(b.vpip, b.opps) ?? -1) - (pct(a.vpip, a.opps) ?? -1) || b.hands - a.hands);
}

/** Hands that count (closed, or open with something entered). */
export const handsRecorded = (s: ScoutSession) => s.hands.filter(handCounts).length;

export const playerLabel = (p: { seat: number; name: string }) => p.name || `${p.seat}번 자리`;
