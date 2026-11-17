import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_HANDS, RANKS } from "../../poker/cards";
import { ajaeOn, settingsStore } from "../../state/settings";
import { AJAE_CRAMPED, AJAE_MOVES, AJAE_SPECIALS, AJAE_START, ajaeCards, ajaeSeen, ajaeStep, ajaeTier, BODY_MOVES, SPECIAL_MOVES, type AjaeCue, type AjaeMove, type AjaeState, type AjaeTier } from "./ajae";
import { AjaeReaction } from "./AjaeReaction";
import { fastHand, fastOtherStore, fastStore, newDraft, pickSuited, startEdit, tapRank, undoTap, withSeat, type FastDraft } from "./fastLog";
import { emptyHand, handLogStore } from "./handLog";
import { SettingsPage } from "../settings/SettingsPage";
import { LogPage } from "./LogPage";

// No @types/node here: reach node:fs through an untyped handle (vitest serves an imported .css as empty).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const css = fs.readFileSync(new URL("./ajae.css", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
const iconSvg = fs.readFileSync(new URL("../../../public/icons/icon.svg", import.meta.url), "utf8");

const noop = () => {};
/** renderToString puts <!-- --> between adjacent text nodes. */
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
const page = (sub: string) => render(<LogPage sub={sub} go={noop} />);
const R = (k: string) => RANKS.indexOf(k);
const initialSettings = settingsStore.get();
const initialLog = handLogStore.get();

/** The 아재 after the taps that type `cls` at `seat` (the last tap completes it), and the draft on screen. */
function typeIn(seat: string, cls: string, s: AjaeState = AJAE_START, room?: number): { s: AjaeState; d: FastDraft } {
  const steps: FastDraft[] = [newDraft(seat)];
  steps.push(tapRank(steps[steps.length - 1], R(cls[0])));
  steps.push(tapRank(steps[steps.length - 1], R(cls[1])));
  if (cls[2]) steps.push(pickSuited(steps[steps.length - 1], cls[2] === "s"));
  for (let i = 1; i < steps.length; i++) s = ajaeStep(s, steps[i - 1], steps[i], "mid", 9, room);
  return { s, d: steps[steps.length - 1] };
}
/** A hand of each tier at the middle stage, 9-handed. */
const SAMPLE: Record<AjaeTier, [string, string]> = { monster: ["UTG", "AA"], good: ["UTG", "JTs"], meh: ["CO", "Q9o"], fold: ["UTG", "K9o"], trash: ["CO", "J4o"], hammer: ["BTN", "72o"] };
/** A cue of the tier doing `move` (as if it were the tier's move in turn), and the seat it is for. */
const cueOf = (tier: AjaeTier, move: AjaeMove, n = 1): { cue: AjaeCue; seat: string } => {
  const [seat, cls] = SAMPLE[tier];
  return { cue: { n, key: `${cls}|`, cls, tier, move }, seat };
};
/** The class names of an act's direct children, in order (what ajae.css places with `.aj-act > *`). */
const actChildren = (html: string): string[] => {
  const m = /<span class="aj-act[^"]*" aria-hidden="true">([\s\S]*)<\/span><span class="aj-jolt/.exec(html);
  if (!m) return [];
  const out: string[] = [];
  let depth = 0;
  for (const t of m[1].matchAll(/<(\/?)([a-z]+)([^>]*?)(\/?)>/g)) {
    if (t[1]) depth--;
    else {
      if (depth === 0) out.push(/class="([^"]*)"/.exec(t[3])?.[1] ?? t[2]);
      if (!t[4]) depth++;
    }
  }
  return out;
};
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
/** The rage's four card halves (front card's left and right, back card's left and right): each half's svg markup. */
const rageHalves = (html: string): string[] => [...html.matchAll(/<span class="aj-half aj-q(\d) aj-h[lr]">(<svg[\s\S]*?<\/svg>)<\/span>/g)].map((m) => m[2]);
/**
 * What a rage card draws: its big pip, its small pip (path and fill), its index (the stroked paths: the index, then again
 * over the pips with a white edge under it), the clip that keeps that second drawing to the pips, and the markup with the
 * clip's id taken out (each card has its own).
 */
const rageCard = (svg: string) => {
  const big = /<path d="([^"]+)" fill="([^"]+)" transform="translate\(1.6 2.2\) scale\(0.8\)"/.exec(svg);
  const small = /<path d="([^"]+)" fill="([^"]+)" transform="translate\(2.3 7.4\) scale\(0.3\)"/.exec(svg);
  const strokes = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="([^"]+)" stroke-width="([\d.]+)"/g)].map((m) => ({ d: m[1], stroke: m[2], width: m[3] }));
  const id = /<clipPath id="([^"]+)">/.exec(svg)?.[1] ?? "";
  const clip = [...(/<clipPath id="[^"]+">([\s\S]*?)<\/clipPath>/.exec(svg)?.[1] ?? "").matchAll(/<path d="([^"]+)" transform="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const clipped = /<g clip-path="url\(#([^)]+)\)">((?:<path [^>]*><\/path>)+)<\/g><\/svg>$/.exec(svg);
  return { pip: big?.[1], color: big?.[2], small: small?.[1], smallColor: small?.[2], strokes, id, clip, clippedBy: clipped?.[1], clippedStrokes: (clipped?.[2].match(/<path /g) ?? []).length, same: svg.split(id).join("ID") };
};
/** 72o's indices as they have always been drawn: the 7 of clubs in ink, the 2 of diamonds in red. */
const SEVEN = "M2.6 2.6 H 6.4 L 3.8 8.4";
const TWO = "M2.8 4.2 Q 3 2.5 4.6 2.5 Q 6.3 2.5 6.2 4.1 Q 6.1 5.5 2.7 8.4 H 6.5";
/** The stylesheet's rules (comments out, @media's too, keyframe steps as well): each rule's selectors and its declarations. */
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].split(",").map((x) => x.trim()), decl: m[2] }));
/** The declarations of every rule with exactly `selector` among its selectors. */
const declsOf = (selector: string): string[] => RULES.filter((r) => r.sel.includes(selector)).map((r) => r.decl);
/** The keyframe names an `animation` or `animation-name` declaration refers to. */
const animNames = (decl: string): string[] =>
  [...decl.matchAll(/(?:^|[;\s])animation(?:-name)?\s*:\s*([^;]+)/g)].flatMap((m) => m[1].split(",").flatMap((item) => item.trim().split(/\s+/).filter((t) => /^aj-[\w-]+$/.test(t))));
/** The body of `@keyframes name` (its steps). */
const keyframes = (name: string): string => new RegExp(`@keyframes ${name} \\{((?:[^{}]*\\{[^{}]*\\})*)[^{}]*\\}`).exec(css)?.[1] ?? "";
/** The hand row's class with the 아재 as FastView puts them together (what is left of the reaction with `d` on screen). */
const row = (s: AjaeState, d: FastDraft, done = true) =>
  render(
    <AjaeReaction cue={ajaeSeen(s, d, "mid", 9).cue} seat={d.seat} stage="mid" players={9}>
      <span className={`fast-class${done ? " done" : ""}`} aria-live="polite">
        CLS
      </span>
    </AjaeReaction>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  settingsStore.set(initialSettings);
  handLogStore.set(initialLog);
  fastStore.set({});
  fastOtherStore.set({});
});

describe("빠른 기록's 아재 (react-dom/server)", () => {
  it("shoves all in for a monster: AK at UTG is the whole 아재 with his chip stacks, then the grinning face in the slot", () => {
    const { s, d } = typeIn("UTG", "AKs");
    const html = row(s, d);
    expect(html).toMatch(/^<span class="ajae-host"><span class="aj-slot aj-after" aria-hidden="true"><span class="aj-face aj-monster"><svg class="aj-fig"/);
    expect(html).toContain('<span class="aj-act aj-mv-shove" aria-hidden="true">');
    // the class itself is untouched, after the overlays, in the jolt wrapper, which takes the hit
    expect(html).toMatch(/<span class="aj-jolt aj-x-shove aj-j1"><span class="fast-class done" aria-live="polite">CLS<\/span><\/span><\/span>$/);
    expect(actChildren(html)).toEqual([
      "aj-flash", "aj-body", "aj-stack aj-s1", "aj-stack aj-s2",
      ...[1, 2, 3, 4, 5, 6].map((i) => `aj-chip aj-c${i}`), ...[1, 2, 3, 4, 5, 6, 7].map((i) => `aj-roll aj-r${i}`),
      "aj-spk aj-k1", "aj-spk aj-k2", "aj-spk aj-k3", "aj-poof",
    ]);
  });

  it("dances for a good hand: a shuffle under the mirror ball, every other time the robot (same ball, its own lights)", () => {
    const one = typeIn("UTG", "JTs");
    const html = row(one.s, one.d);
    expect(html).toContain('<span class="aj-slot aj-after" aria-hidden="true"><span class="aj-face aj-good"><svg');
    expect(html).toContain('<span class="aj-act aj-mv-shuffle" aria-hidden="true">');
    expect(actChildren(html)).toEqual(["aj-disco", "aj-beams", "aj-ball", "aj-body", "aj-note aj-n1", "aj-note aj-n2", "aj-note aj-n3", "aj-note aj-n4", "aj-shine", "aj-poof"]);
    expect(html).toContain('<span class="aj-jolt aj-x-shuffle aj-j1">');
    // the ball's facet lines and glints are clipped to the ball (the sliding meridians would show beside it), by an id of its own
    const ball = /<svg class="aj-ballsvg"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
    const clip = /<clipPath id="([^"]+)"><circle r="13"><\/circle><\/clipPath>/.exec(ball)?.[1];
    expect(clip).toBeTruthy();
    expect(ball).toContain(`<g clip-path="url(#${clip})"><g fill="none" stroke="#5b6b80" stroke-width="0.9">`);
    const clipped = /<g clip-path="url\(#[^"]+\)">([\s\S]*)<circle r="13.5" fill="none"/.exec(ball)?.[1] ?? "";
    expect(clipped).toContain('class="aj-mer"');
    expect(clipped).toContain('fill="#eef6ff"');
    const two = render(
      <>
        <AjaeReaction cue={cueOf("good", "shuffle").cue} seat="UTG" stage="mid" players={9}>A</AjaeReaction>
        <AjaeReaction cue={cueOf("good", "robot", 2).cue} seat="UTG" stage="mid" players={9}>B</AjaeReaction>
      </>,
    );
    const ids = [...two.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(two).toContain(`clip-path="url(#${id})"`);
    const second = typeIn("UTG", "JTs", one.s);
    const again = row(second.s, second.d);
    expect(again).toContain('<span class="aj-act aj-mv-robot" aria-hidden="true">');
    expect(actChildren(again)).toEqual(actChildren(html));
    expect(again).toContain('<span class="aj-jolt aj-x-robot aj-j0">');
    // the ball needs the room above the row: scrolled under the stage bar, the dance goes on without it
    const low = typeIn("UTG", "JTs", AJAE_START, 70);
    expect(row(low.s, low.d)).toContain('<span class="aj-act aj-mv-shuffle aj-noball" aria-hidden="true">');
  });

  it("ponders the seat's call: meh and fold first ponder it (hand on his chin, a thought cloud), then 흠 for meh and a glare for fold", () => {
    const typed = (seat: string, cls: string, s?: AjaeState) => {
      const r = typeIn(seat, cls, s);
      return { html: row(r.s, r.d), s: r.s };
    };
    const fold = typed("UTG", "K9o");
    expect(fold.html).toContain('<span class="aj-slot aj-pop" aria-hidden="true"><span class="aj-face aj-fold aj-play aj-mv-ponder"><svg');
    expect(typed("UTG", "K9o", fold.s).html).toContain('<span class="aj-face aj-fold aj-play aj-mv-glare">');
    const meh = typed("CO", "Q9o");
    expect(meh.html).toContain('<span class="aj-slot aj-pop" aria-hidden="true"><span class="aj-face aj-meh aj-play aj-mv-ponder"><svg');
    expect(typed("CO", "Q9o", meh.s).html).toContain('<span class="aj-face aj-meh aj-play aj-mv-hmm">');
    for (const h of [fold.html, meh.html]) {
      expect(h).not.toContain("aj-act");
      expect(h).toMatch(/<span class="aj-jolt"><span class="fast-class done"/);
      // what the ponder draws: the hand, the mouth pushed aside, the thought cloud with its two bubbles and three dots
      for (const part of ["aj-hand", "aj-purse", "aj-think", "aj-tb1", "aj-tb2", "aj-cloud", "aj-dot aj-d1", "aj-dot aj-d2", "aj-dot aj-d3"]) expect(h).toContain(`class="${part}"`);
    }
  });

  it("goes into a rage for 72o: the whole 아재 double-takes, boils over, rips both cards in half and stomps them, then stays furious", () => {
    const { s, d } = typeIn("BTN", "72o");
    expect(s.cue).toMatchObject({ tier: "hammer", move: "rage" });
    const html = row(s, d);
    // the furious face is in the slot from the start (it comes in as he vanishes, on the rage's clock) and stays there, as for trash
    expect(html).toContain('<span class="aj-slot aj-after aj-for-rage" aria-hidden="true"><span class="aj-face aj-hammer"><svg');
    for (const part of ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-steam aj-st-rest"]) expect(html).toContain(`class="${part}"`);
    expect(html).toContain('<span class="aj-act aj-mv-rage" aria-hidden="true">');
    expect(html).toContain(`<span class="aj-jolt aj-x-rage aj-j${s.cue!.n % 2}"><span class="fast-class done" aria-live="polite">CLS</span></span>`);
    const kids = actChildren(html);
    expect(kids).toEqual([
      "aj-aura", "aj-body",
      "aj-half aj-q1 aj-hl", "aj-half aj-q2 aj-hr", "aj-half aj-q3 aj-hl", "aj-half aj-q4 aj-hr",
      "aj-bit aj-b1", "aj-bit aj-b2", "aj-bit aj-b3", "aj-bit aj-b4",
      "aj-burst", "aj-bang", "aj-dust aj-d1", "aj-dust aj-d2",
      "aj-puff aj-p0", "aj-puff aj-p1", "aj-puff aj-p2", "aj-poof",
    ]);
    // more going on than in any other trash move
    for (const m of AJAE_MOVES.trash.filter((x) => x !== "rage")) {
      const { cue, seat } = cueOf("trash", m);
      expect(actChildren(render(<AjaeReaction cue={cue} seat={seat} stage="mid" players={9}><span className="fast-class">X</span></AjaeReaction>)).length, m).toBeLessThan(kids.length);
    }
    // the doll: mad, with the shocked O, the shock lines and steam out of both ears (two puffs a side)
    for (const part of ["aj-r-flush", "aj-r-vbrows", "aj-r-teeth", "aj-r-oh", "aj-r-shock", "aj-r-jet aj-r-jl1", "aj-r-jet aj-r-jl2", "aj-r-jet aj-r-jr1", "aj-r-jet aj-r-jr2"]) expect(html).toContain(`class="${part}"`);
    // the two cards are the hand's: drawn with their indices (paths, no text), each cut in two along the tear: the 7 of
    // clubs in front, the 2 of diamonds behind, as they always were
    expect((html.match(/class="aj-half /g) ?? []).length).toBe(4);
    expect(html).not.toMatch(/<text[^>]*>[^<]*[27]/);
    const [q1, q2, q3, q4] = rageHalves(html).map(rageCard);
    expect(q1.same).toBe(q2.same);
    expect(q3.same).toBe(q4.same);
    const [seven, two] = [q1, q3];
    for (const [card, d, ink] of [[seven, SEVEN, "#1b1400"], [two, TWO, "#d6202f"]] as const) {
      expect(card.strokes[0]).toEqual({ d, stroke: ink, width: "1.5" });
      expect(card.strokes.at(-1)).toEqual({ d, stroke: ink, width: "1.5" });
    }
    expect(seven).toMatchObject({ color: "#1b1400", smallColor: "#1b1400" });
    expect(two).toMatchObject({ color: "#d6202f", smallColor: "#d6202f" });
    expect(seven.pip).toMatch(/^M5.3 9.6 a 2.7 2.7 0 1 0 5.4 0 /);
    expect(two.pip).toBe("M8 7.6 L 11.7 13 L 8 18.4 L 4.3 13 Z");
    // the other body moves never draw the rage's parts
    for (const m of ["kick", "mallet", "slam", "shove", "shuffle"] as AjaeMove[]) {
      const tier = (Object.keys(AJAE_MOVES) as AjaeTier[]).find((t) => (AJAE_MOVES[t] as readonly string[]).includes(m))!;
      const other = render(<AjaeReaction cue={cueOf(tier, m).cue} seat={cueOf(tier, m).seat} stage="mid" players={9}>X</AjaeReaction>);
      expect(other).not.toMatch(/aj-r-oh|aj-r-shock|aj-r-jet|aj-half|aj-aura/);
    }
  });

  it("goes for a trash hand four ways (72o's rage with the hand's own cards, kick, mallet, card slam) and stays beside it furious: no walking off", () => {
    let s = AJAE_START;
    const fumes = ["aj-puff aj-p0", "aj-puff aj-p1", "aj-puff aj-p2", "aj-poof"];
    const kids: Record<string, string[]> = {
      rage: [
        "aj-aura", "aj-body",
        "aj-half aj-q1 aj-hl", "aj-half aj-q2 aj-hr", "aj-half aj-q3 aj-hl", "aj-half aj-q4 aj-hr",
        "aj-bit aj-b1", "aj-bit aj-b2", "aj-bit aj-b3", "aj-bit aj-b4",
        "aj-burst", "aj-bang", "aj-dust aj-d1", "aj-dust aj-d2", ...fumes,
      ],
      kick: ["aj-body", "aj-whoosh", "aj-burst", "aj-dust aj-d1", "aj-dust aj-d2", ...fumes],
      mallet: ["aj-body", "aj-burst", "aj-crack", "aj-dizzy", "aj-speed", ...fumes],
      slam: ["aj-body", "aj-card aj-cd1", "aj-card aj-cd2", "aj-lines", "aj-bang", "aj-burst", "aj-dust aj-d1", "aj-dust aj-d2", ...fumes],
    };
    const parity: number[] = [];
    for (const [cls, move] of [["J4o", "rage"], ["93o", "kick"], ["T8o", "mallet"], ["Q2o", "slam"], ["83o", "rage"]]) {
      const r = typeIn("CO", cls, s);
      s = r.s;
      const html = row(s, r.d);
      // the face is in the slot from the start (it pops in, furious, as he finishes: after the rage, on its clock) and stays there
      expect(html).toContain(`<span class="aj-slot aj-after${move === "rage" ? " aj-for-rage" : ""}" aria-hidden="true"><span class="aj-face aj-trash"><svg`);
      expect(html).toContain(`<span class="aj-act aj-mv-${move}" aria-hidden="true">`);
      expect(actChildren(html)).toEqual(kids[move]);
      expect(html).toContain(`<span class="aj-jolt aj-x-${move} aj-j${s.cue!.n % 2}"><span class="fast-class done" aria-live="polite">CLS</span></span>`);
      parity.push(s.cue!.n % 2);
      // the furious face's parts are all there (the resting face shows them by .aj-trash), and so is the mallet when he swings it
      for (const part of ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-steam aj-st-rest"]) expect(html).toContain(`class="${part}"`);
      expect(html.includes('class="aj-r-mallet"')).toBe(move === "mallet");
      // the rage's parts only in the rage, its cards the hand's own
      expect(/aj-r-oh|aj-r-shock|aj-r-jet|aj-half|aj-aura/.test(html), move).toBe(move === "rage");
      if (move === "rage") {
        const [front, back] = [rageHalves(html)[0], rageHalves(html)[2]].map((c) => rageCard(c).strokes[0].d);
        expect(front, cls).not.toBe(back);
        for (const d of [front, back]) expect([SEVEN, TWO], cls).not.toContain(d);
      }
    }
    // back to back, each reaction gets the other keyframes, so the class's move starts over
    expect(parity).toEqual([1, 0, 1, 0, 1]);
  });

  it("rips the hand's own two cards in the rage, for any hand: its ranks drawn (paths, no text), the high card in front, its suits", () => {
    /** The rage's act for `cls` (as if it were its tier's move: the art is the same for any hand). */
    const rage = (cls: string) => {
      const html = render(<AjaeReaction cue={{ n: 1, key: `${cls}|`, cls, tier: ajaeTier(cls, "CO", "mid", 9), move: "rage" }} seat="CO" stage="mid" players={9}><span className="fast-class">X</span></AjaeReaction>);
      return /<span class="aj-act aj-mv-rage"[\s\S]*<\/span>(?=<span class="aj-jolt)/.exec(html)?.[0] ?? "";
    };
    const index = new Map<string, string>();
    const pips = new Map<string, string>();
    for (const h of ALL_HANDS) {
      const html = rage(h);
      expect(rageHalves(html), h).toHaveLength(4);
      expect(html, h).not.toMatch(/<text/);
      expect(html.replace(/<[^>]*>/g, ""), h).toBe("");
      const [q1, q2, q3, q4] = rageHalves(html).map(rageCard);
      // each card's two halves are the same card, cut apart by ajae.css, each with a clip of its own
      expect(q1.same, h).toBe(q2.same);
      expect(q3.same, h).toBe(q4.same);
      expect(new Set([q1, q2, q3, q4].map((q) => q.id)).size, h).toBe(4);
      ajaeCards(h).forEach((c, i) => {
        const card = i ? q3 : q1;
        const red = c.suit === "h" || c.suit === "d";
        const ink = red ? "#d6202f" : "#1b1400";
        // the index in the suit's colour, the same stroke as 72o's, and again over the pips with a white edge under it,
        // clipped to the pips (the card's own clip: its two pips)
        const d = card.strokes[0]?.d ?? "";
        expect(card.strokes, `${h} ${c.rank}`).toEqual([
          { d, stroke: ink, width: "1.5" },
          { d, stroke: "#fff", width: "2.2" },
          { d, stroke: ink, width: "1.5" },
        ]);
        expect([card.clippedBy, card.clippedStrokes], h).toEqual([card.id, 2]);
        expect(card.clip, h).toEqual([[card.pip, "translate(2.3 7.4) scale(0.3)"], [card.pip, "translate(1.6 2.2) scale(0.8)"]]);
        expect(d, h).toMatch(/^M[\d. ]/);
        expect(d.length, h).toBeGreaterThan(10);
        expect(index.get(c.rank) ?? d, `${h} ${c.rank}`).toBe(d);
        index.set(c.rank, d);
        // the pip, big and small, in the suit's colour
        expect(card.small, h).toBe(card.pip);
        expect([card.color, card.smallColor], h).toEqual([ink, ink]);
        expect(pips.get(c.suit) ?? card.pip, `${h} ${c.suit}`).toBe(card.pip);
        pips.set(c.suit, card.pip!);
      });
      if (h.endsWith("s")) expect(q1.pip, h).toBe(q3.pip);
      else expect(q1.pip, h).not.toBe(q3.pip);
    }
    // a drawing of its own for each of the 13 ranks and each of the 4 suits; 72o's 7 and 2 as they always were
    expect([...index.keys()].sort()).toEqual([...RANKS].sort());
    expect(new Set(index.values()).size).toBe(13);
    expect(index.get("7")).toBe(SEVEN);
    expect(index.get("2")).toBe(TWO);
    expect(new Set(pips.values()).size).toBe(4);
    // J4o: a jack in front, a four behind, in two suits; T3s: a ten and a three, both diamonds
    const j4 = rageHalves(rage("J4o")).map(rageCard);
    expect([j4[0].strokes[0].d, j4[2].strokes[0].d]).toEqual([index.get("J"), index.get("4")]);
    expect(j4[0].pip).not.toBe(j4[2].pip);
    const t3 = rageHalves(rage("T3s")).map(rageCard);
    expect([t3[0].strokes[0].d, t3[2].strokes[0].d]).toEqual([index.get("T"), index.get("3")]);
    expect([t3[0].pip, t3[2].pip]).toEqual([pips.get("d"), pips.get("d")]);
  });

  it("never says a word: nothing he draws, for any tier and move, has Hangul in it, and the bubbles are gone", () => {
    const left = new Set<AjaeMove>([...Object.values(AJAE_MOVES).flat(), ...Object.values(AJAE_CRAMPED)]);
    let n = 0;
    for (const tier of Object.keys(SAMPLE) as AjaeTier[]) {
      for (const move of [...(AJAE_MOVES[tier] as readonly AjaeMove[]), AJAE_CRAMPED[tier]]) {
        left.delete(move);
        const { cue, seat } = cueOf(tier, move, ++n);
        for (const c of [cue, { ...cue, settled: true as const }, { ...cue, noBall: true as const }, { ...cue, low: true as const }]) {
          const html = render(
            <AjaeReaction cue={c} seat={seat} stage="mid" players={9}>
              <span className="fast-class done">CLS</span>
            </AjaeReaction>,
          );
          expect(html).toContain("aj-slot");
          expect(html).not.toMatch(HANGUL);
          expect(html).not.toMatch(/aj-bubble|aj-kbubble|aj-boom|aj-kicker/);
          // no text at all but the symbol ? (in the svg)
          for (const t of html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect(t[1].trim()).toBe("?");
          expect(html.replace(/<[^>]*>/g, "").replace("CLS", "").replace(/[?\s]/g, "")).toBe("");
          // no beer, no yawn, no doze (the z's) anywhere
          expect(html).not.toMatch(/aj-(mug|foam|yawn|zfly|zrest)|aj-mv-(beer|yawn)/);
          if (!c.settled) expect(html.includes("aj-act")).toBe(BODY_MOVES.has(move));
          else expect(html).not.toMatch(/aj-act|aj-play/);
        }
      }
    }
    expect([...left]).toEqual([]);
  });

  it("is bald everywhere he appears (the face, the doll, the launch splash, the app icon): brown only for the mustache and the brows", () => {
    const MUSTACHE_D = "M0 14 C -8 6, -24 5, -34 14 C -39 19, -46 19, -50 14 C -46 28, -28 31, -14 23 C -7 19, -3 18, 0 21 C 3 18, 7 19, 14 23 C 28 31, 46 28, 50 14 C 46 19, 39 19, 34 14 C 24 5, 8 6, 0 14 Z";
    const BROWS = new Set(["M-29 -14 Q -21 -19.5 -13 -15.5", "M13 -15.5 Q 21 -19.5 29 -14", "M-29 -14 Q -21 -19.5 -13 -15.5 M13 -15.5 Q 21 -19.5 29 -14"]);
    const HAIR = ["M-44 -10 C -50 -30", "M44 -10 C 50 -30", "M-14 -56 q 14 -8 30 2", "M-32 -50", "M32 -50"];
    /** Every shape painted in the hair brown, as its path (a brown group's paths each count). */
    const brown = (markup: string): string[] => {
      const out: string[] = [];
      for (const m of markup.matchAll(/<(\w+)((?:[^>"]|"[^"]*")*)>/g)) {
        if (!/#3b2a1e/i.test(m[2])) continue;
        if (m[1] === "g") {
          const inner = markup.slice(m.index! + m[0].length, markup.indexOf("</g>", m.index!));
          for (const d of inner.matchAll(/ d="([^"]+)"/g)) out.push(d[1]);
        } else out.push(/ d="([^"]+)"/.exec(m[2])?.[1] ?? `<${m[1]}>`);
      }
      return out;
    };
    const splash = indexHtml.slice(indexHtml.indexOf('<div id="splash"'), indexHtml.indexOf("<!-- /splash -->"));
    expect(splash.length).toBeGreaterThan(1000);
    // the reaction: every tier's face, every move (the doll's head too), settled or not
    const faces: string[] = [];
    for (const tier of Object.keys(SAMPLE) as AjaeTier[]) {
      for (const move of [...(AJAE_MOVES[tier] as readonly AjaeMove[]), AJAE_CRAMPED[tier]]) {
        const { cue, seat } = cueOf(tier, move);
        faces.push(render(<AjaeReaction cue={cue} seat={seat} stage="mid" players={9}><span className="fast-class">X</span></AjaeReaction>));
      }
    }
    for (const [name, markup] of [["splash", splash], ["icon", iconSvg], ...faces.map((f, i) => [`reaction ${i}`, f])] as [string, string][]) {
      for (const h of HAIR) expect(markup, `${name} has hair`).not.toContain(h);
      const shapes = brown(markup);
      expect(shapes, name).toContain(MUSTACHE_D);
      for (const d of shapes) expect(d === MUSTACHE_D || BROWS.has(d), `${name}: brown ${d}`).toBe(true);
      // the same bald head everywhere: ears either side, the shine on top
      expect(markup, name).toMatch(/<ellipse cx="-43" cy="-8" rx="7.5" ry="10.5"/);
      expect(markup, name).toMatch(/<ellipse cx="43" cy="-8" rx="7.5" ry="10.5"/);
      expect(markup, name).toContain("M-26.4 -42 A13 6.5 -18 1 1 -1.6 -50 A13 6.5 -18 1 1 -26.4 -42 Z");
    }
    // the doll's head is the same bald head (the body moves draw it at 0.4)
    const doll = faces.find((f) => f.includes("aj-rig"))!;
    expect(doll.match(/<ellipse cx="-43" cy="-8"/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("plays the face's stand-in when there is no room above the row for the whole 아재 (the page scrolled under the stage bar)", () => {
    const trash = typeIn("CO", "J4o", AJAE_START, 30);
    const html = row(trash.s, trash.d);
    // with that little room the full pop would reach under the bar too: it pops smaller (.aj-low)
    expect(html).toContain('<span class="aj-slot aj-pop aj-low" aria-hidden="true"><span class="aj-face aj-trash aj-play aj-mv-fume"><svg');
    expect(html).not.toContain("aj-act");
    expect(html).toMatch(/<span class="aj-jolt"><span class="fast-class done"/);
    const good = typeIn("UTG", "JTs", AJAE_START, 30);
    expect(row(good.s, good.d)).toContain('<span class="aj-face aj-good aj-play aj-mv-nod">');
    const aa = typeIn("UTG", "AA", AJAE_START, 30);
    expect(row(aa.s, aa.d)).toContain('<span class="aj-face aj-monster aj-play aj-mv-cheer">');
    // 72o boils over in the face, as trash does, and rests as furious
    const h = typeIn("BTN", "72o", AJAE_START, 30);
    expect(row(h.s, h.d)).toContain('<span class="aj-slot aj-pop aj-low" aria-hidden="true"><span class="aj-face aj-hammer aj-play aj-mv-fume"><svg');
    // a face move with room for the full pop pops as usual; settled, nothing pops at all
    const meh = typeIn("CO", "Q9o", AJAE_START, 70);
    expect(row(meh.s, meh.d)).toContain('<span class="aj-slot aj-pop" aria-hidden="true"><span class="aj-face aj-meh aj-play aj-mv-ponder">');
    const lowMeh = typeIn("CO", "Q9o", AJAE_START, 40);
    expect(row(lowMeh.s, lowMeh.d)).toContain('<span class="aj-slot aj-pop aj-low" aria-hidden="true"><span class="aj-face aj-meh aj-play aj-mv-ponder">');
    const settled = render(<AjaeReaction cue={{ ...lowMeh.s.cue!, settled: true }} seat="CO" stage="mid" players={9}>Q9o</AjaeReaction>);
    expect(settled).toContain('<span class="aj-slot" aria-hidden="true"><span class="aj-face aj-meh"><svg');
  });

  it("goes at once when the class is cleared", () => {
    const { s, d } = typeIn("UTG", "K9o");
    const back = undoTap(d);
    const html = row(ajaeStep(s, d, back, "mid", 9), back, false);
    expect(html).toBe('<span class="ajae-host"><span class="aj-jolt"><span class="fast-class" aria-live="polite">CLS</span></span></span>');
  });

  it("shows the new seat's face at rest when my seat changes, without moving, and doesn't replay on the way back", () => {
    const { s, d } = typeIn("UTG", "K9o");
    const btn = withSeat(d, "BTN", 9);
    const next = ajaeStep(s, d, btn, "mid", 9);
    expect(next).toBe(s);
    const html = row(next, btn);
    expect(html).toContain('<span class="aj-slot" aria-hidden="true"><span class="aj-face aj-good"><svg');
    expect(html).not.toMatch(/aj-play|aj-act|aj-pop|aj-after|aj-x-/);
    // back at UTG (a fold again, as when the cards went in): the pondering face at rest, no pop
    const atBtn = ajaeSeen(next, btn, "mid", 9);
    const utg = withSeat(btn, "UTG", 9);
    const back = row(ajaeStep(atBtn, btn, utg, "mid", 9), utg);
    expect(back).toContain('<span class="aj-slot" aria-hidden="true"><span class="aj-face aj-fold"><svg');
    expect(back).not.toMatch(/aj-play|aj-act|aj-pop|aj-after|aj-x-/);
    // a cue whose tier changed and came back, as FastView passes it (settled), never moves; one that never left still does
    expect(render(<AjaeReaction cue={atBtn.cue} seat="UTG" stage="mid" players={9}>K9o</AjaeReaction>)).not.toContain("aj-pop");
    expect(render(<AjaeReaction cue={s.cue} seat="UTG" stage="mid" players={9}>K9o</AjaeReaction>)).toContain("aj-slot aj-pop");
    // a body move: a seat with the same tier keeps it going; one that changes the tier takes the whole 아재 away at
    // once, and the face rests with the tier on screen
    const j4 = typeIn("CO", "J4o");
    expect(ajaeTier("J4o", "BB", "mid", 9)).toBe("trash");
    expect(row(j4.s, withSeat(j4.d, "BB", 9))).toContain("aj-act aj-mv-rage");
    const k9 = typeIn("BTN", "K9o");
    expect(row(k9.s, k9.d)).toContain("aj-act aj-mv-shuffle");
    const moved = row(k9.s, withSeat(k9.d, "UTG", 9));
    expect(moved).toContain('<span class="aj-slot" aria-hidden="true"><span class="aj-face aj-fold"><svg');
    expect(moved).not.toMatch(/aj-play|aj-act|aj-pop|aj-after|aj-x-/);
  });

  it("shows nothing for a class restored on load or opened to correct, in FastView itself", () => {
    // a draft left in the editor (a reload): the class is there, the 아재 is not
    fastStore.set({ stage: "mid", players: 9, draft: typeIn("CO", "J4o").d });
    let html = page("fast");
    expect(html).toContain('<span class="ajae-host"><span class="aj-jolt"><span class="fast-class done" aria-live="polite">J4o</span></span></span>');
    expect(html).not.toMatch(/aj-(slot|act)/);
    // a saved hand opened to correct
    const h = fastHand(typeIn("UTG", "AA").d, "open", { ...emptyHand(null), id: "h1", createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 }, "mid", 9)!;
    handLogStore.set({ ...initialLog, hands: [h] });
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("CO"), parked: null }, h));
    html = page("fast");
    expect(html).toContain('<span class="fast-class done" aria-live="polite">AA</span>');
    expect(html).not.toMatch(/aj-(slot|act)/);
  });

  it("is only on 빠른 기록 (내 핸드): 남의 핸드 keeps its class as it was", () => {
    fastOtherStore.set({ stage: "mid", players: 9, draft: typeIn("CO", "AKs").d });
    const html = page("other");
    expect(html).toContain('<span class="fast-class done" aria-live="polite">AKs</span>');
    expect(html).not.toContain("ajae-host");
    const { s, d } = typeIn("UTG", "AA");
    expect(
      render(
        <AjaeReaction cue={ajaeSeen(s, d, "mid", 9).cue} seat="UTG" stage="mid" players={9} off>
          <b>AA</b>
        </AjaeReaction>,
      ),
    ).toBe("<b>AA</b>");
  });

  it("draws nothing with 빠른 기록 아재 리액션 off, and is on by default (older settings too)", () => {
    expect(initialSettings.ajae).toBe(true);
    expect(ajaeOn(undefined)).toBe(true);
    expect(ajaeOn("x")).toBe(true);
    expect(ajaeOn(false)).toBe(false);
    settingsStore.set({ ...initialSettings, ajae: false });
    const { s, d } = typeIn("UTG", "AA");
    expect(row(s, d)).toBe('<span class="fast-class done" aria-live="polite">CLS</span>');
    fastStore.set({ stage: "mid", players: 9, draft: d });
    expect(page("fast")).not.toContain("ajae-host");
  });

  it("never takes a tap or moves the row: every overlay is absolute with pointer-events off; reduce motion stops it all", () => {
    for (const sel of [".aj-slot", ".aj-act"]) {
      const rule = new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule).toContain("position: absolute");
      expect(rule).toContain("pointer-events: none");
    }
    // everything an act draws is one of its direct children, placed absolutely (hidden until its move shows it)
    expect(/\n\.aj-act > \* \{[^}]*position: absolute;[^}]*opacity: 0/.test(css)).toBe(true);
    expect(/\n\.aj-face \{[^}]*position: absolute/.test(css)).toBe(true);
    // a move reaching past the screen's edge is clipped there (no sideways scroll, the sticky bar still sticks)
    expect(css).toContain(".page:has(.aj-act) { overflow-x: clip; }");
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(reduce).toContain(".aj-act { display: none; }");
    expect(reduce).toContain(".aj-play *, .aj-pop .aj-face, .aj-after .aj-face, .aj-after .aj-face *, .aj-jolt { animation: none !important; }");
    // at rest he is cut to his slot (no shirt over the pad keys); the cut opens only while he moves
    expect(/\n\.aj-face \{[^}]*clip-path: inset\(0\)/.test(css)).toBe(true);
    expect(/\n\.aj-pop \.aj-face \{[^}]*aj-open 1\.9s step-end backwards/.test(css)).toBe(true);
    expect(/\n\.aj-after \.aj-face \{[^}]*aj-open 2\.5s step-end backwards/.test(css)).toBe(true);
    expect(/\n\.aj-slot \{[^}]*bottom: -3px/.test(css)).toBe(true);
    // every body move has its parts and its class's own pair of keyframes (so back to back reactions restart)
    for (const m of BODY_MOVES) {
      expect(css).toContain(`.aj-mv-${m} .aj-body {`);
      expect(css).toContain(`@keyframes aj-x-${m}-0 `);
      expect(css).toContain(`@keyframes aj-x-${m}-1 `);
      expect(css).toContain(`.aj-mv-${m} .aj-poof {`);
    }
    for (const m of ["ponder", "hmm", "glare", "cheer", "nod", "fume"]) expect(css).toContain(`.aj-play.aj-mv-${m} `);
    // the class goes over the popped face and the lights (its letters stay readable) and under the doll
    expect(declsOf(".aj-jolt").join(";")).toMatch(/position: relative;[^}]*z-index: 2/);
    // every body move poses every joint of the doll, and its class's move alternates between its two keyframes
    const joints = ["aj-body", "aj-r-all", "aj-r-head", "aj-r-arm-l", "aj-r-fore-l", "aj-r-arm-r", "aj-r-fore-r", "aj-r-leg-l", "aj-r-shin-l", "aj-r-leg-r", "aj-r-shin-r"];
    for (const m of BODY_MOVES) {
      for (const j of joints) expect(declsOf(`.aj-mv-${m} .${j}`).flatMap(animNames), `${m} ${j}`).not.toEqual([]);
      for (const p of [0, 1]) expect(declsOf(`.aj-jolt.aj-x-${m}.aj-j${p}`).flatMap(animNames), `${m} j${p}`).toEqual([`aj-x-${m}-${p}`]);
    }
    // each face move moves the parts that make it
    const faceParts: Record<string, string[]> = {
      ponder: ["aj-head", "aj-hand", "aj-shades", "aj-pupils", "aj-brow-r", "aj-purse", "aj-think", "aj-tb1", "aj-tb2", "aj-cloud", "aj-dot.aj-d1", "aj-dot.aj-d2", "aj-dot.aj-d3"],
      hmm: ["aj-head", "aj-shades", "aj-qmark"], glare: ["aj-head", "aj-shades", "aj-sweat", "aj-hand", "aj-cloud", "aj-dot.aj-d3"],
      cheer: ["aj-shades", "aj-sp", "aj-smile"], nod: ["aj-head", "aj-smile"], fume: ["aj-head", "aj-vbrows", "aj-vein", "aj-flush"],
    };
    for (const [m, parts] of Object.entries(faceParts)) for (const part of parts) expect(declsOf(`.aj-play.aj-mv-${m} .${part}`).flatMap(animNames), `${m} ${part}`).not.toEqual([]);
    // the resting faces: hidden parts the tier shows at rest (the trash face's fury above all: red, brows, teeth, vein, steam)
    const resting: Record<string, string[]> = {
      trash: ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-st-rest"], hammer: ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-st-rest"],
      monster: ["aj-smile", "aj-sp.aj-one"], good: ["aj-smile"], meh: ["aj-flat", "aj-qmark"], fold: ["aj-hand", "aj-think", "aj-purse"],
    };
    for (const [tier, parts] of Object.entries(resting)) {
      for (const part of parts) {
        const shown = declsOf(`.aj-${tier} .${part}`).map((d) => Number(/opacity: ([\d.]+)/.exec(d)?.[1] ?? 0));
        expect(Math.max(0, ...shown), `${tier} ${part}`).toBeGreaterThan(0.3);
      }
    }
    // no beer, no yawn, no doze left in the stylesheet
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/aj-(mug|foam|yawn|zfly|zrest)|aj-mv-(beer|yawn)|aj-f-|aj-k-/);
    // the ponder is the fold's resting face: the ponder stops short of its end (each part then goes to the tier's own
    // resting face) on the fold's resting face, and the glare ends right on it
    const transformOf = (selector: string) => declsOf(selector).map((d) => /transform: ([^;]+);/.exec(d)?.[1]).find(Boolean) ?? "none";
    const steps = (name: string) => [...keyframes(name).matchAll(/([\d.%, ]+)\{([^}]*)\}/g)].map((m) => ({ at: m[1].split(",").map((x) => parseFloat(x)), decl: m[2] }));
    const at = (name: string, pct: number) => steps(name).filter((x) => x.at.includes(pct)).map((x) => x.decl).join(" ");
    const lastAt = (name: string) => Math.max(...steps(name).flatMap((x) => x.at));
    const foldRest: Record<string, string> = { "aj-head": "rotate(5deg)", "aj-shades": "translateY(-21px) rotate(-5deg)", "aj-pupils": "translate(2px, -2.4px)", "aj-brow-r": "translateY(-5px) rotate(8deg)" };
    for (const [part, tf] of Object.entries(foldRest)) {
      expect(transformOf(`.aj-fold .${part}`), part).toBe(tf);
      const [p] = declsOf(`.aj-play.aj-mv-ponder .${part}`).flatMap(animNames);
      expect(lastAt(p), `${p} ends early`).toBe(84);
      expect(at(p, 84), p).toContain(`transform: ${tf};`);
      const [g] = declsOf(`.aj-play.aj-mv-glare .${part}`).flatMap(animNames);
      expect(at(g, 100), g).toContain(`transform: ${tf};`);
    }
    for (const part of ["aj-hand", "aj-purse", "aj-think"]) {
      const [p] = declsOf(`.aj-play.aj-mv-ponder .${part}`).flatMap(animNames);
      expect(lastAt(p), `${p} ends early`).toBe(84);
      expect(at(p, 84), p).toContain("opacity: 1;");
    }
    // the hand and the cloud wait out of place (the hand below his chin, the cloud up and bigger): the fold puts them back
    // in place at rest, and the ponder (84%) and the glare (100%) bring the hand there
    for (const part of ["aj-hand", "aj-think"]) expect(declsOf(`.aj-fold .${part}`).join(";"), part).toContain("transform: none");
    expect(at("aj-p-hand", 84)).toContain("transform: none;");
    expect(at("aj-g-hand", 100)).toContain("transform: none;");
    for (const part of ["aj-hand", "aj-purse", "aj-tb1", "aj-tb2", "aj-cloud", "aj-dot.aj-d1", "aj-dot.aj-d2", "aj-dot.aj-d3"]) {
      const [g] = declsOf(`.aj-play.aj-mv-glare .${part}`).flatMap(animNames);
      expect(at(g, 100), g).toContain("opacity: 1;");
    }
    // meh's ponder ends on the 흠 face: the parts the ponder leaves for it to set (the brow, the mouth, the ?) stop at 84% too
    for (const part of ["aj-brow-l", "aj-flat", "aj-qmark"]) for (const p of declsOf(`.aj-play.aj-mv-ponder .${part}`).flatMap(animNames)) expect(lastAt(p), p).toBe(84);
    // 72o rests furious, exactly as trash does
    for (const part of ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-st-rest"]) expect(RULES.some((r) => r.sel.includes(`.aj-trash .${part}`) && r.sel.includes(`.aj-hammer .${part}`))).toBe(true);
    expect(RULES.some((r) => r.sel.includes(".aj-trash .aj-head") && r.sel.includes(".aj-hammer .aj-head"))).toBe(true);
    // the rage is longer than the other body moves (its act, its class's move and the face coming in after it)
    expect(declsOf(".aj-act.aj-mv-rage *").join(";")).toContain("animation-duration: 3.2s");
    expect(declsOf(".aj-act *").join(";")).toContain("animation-duration: 2.5s");
    for (const p of [0, 1]) expect(declsOf(`.aj-jolt.aj-x-rage.aj-j${p}`).join(";")).toContain(" 3.2s ");
    expect(RULES.some((r) => r.sel.includes(".aj-after .aj-face.aj-hammer") && r.sel.includes(".aj-after .aj-hammer *") && r.decl.includes("animation-duration: 3.2s"))).toBe(true);
    // a trash hand's face waits for its rage the same (the slot's .aj-for-rage), not the other trash moves' 2.5 s
    expect(RULES.some((r) => r.sel.includes(".aj-after.aj-for-rage .aj-face") && r.sel.includes(".aj-after.aj-for-rage .aj-face *") && r.decl.includes("animation-duration: 3.2s"))).toBe(true);
    expect(RULES.some((r) => r.sel.includes(".aj-after .aj-face.aj-trash") && r.sel.includes(".aj-after .aj-face.aj-hammer") && animNames(r.decl).includes("aj-after-mad"))).toBe(true);
    // the dance without its ball hides the ball and its beams
    expect(RULES.some((r) => r.sel.includes(".aj-noball .aj-ball") && r.sel.includes(".aj-noball .aj-beams") && r.decl.includes("display: none"))).toBe(true);
    // the smaller pop (the page scrolled): its own keyframes, smaller than the full pop's
    expect(declsOf(".aj-pop.aj-low .aj-face").flatMap(animNames)).toEqual(["aj-pop-low", "aj-open"]);
    const maxScale = (k: string) => Math.max(...[...keyframes(k).matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1])));
    expect(maxScale("aj-pop")).toBe(2.15);
    expect(maxScale("aj-pop-low")).toBeGreaterThan(1.2);
    expect(maxScale("aj-pop-low")).toBeLessThan(1.6);
    // and in it the ponder's cloud stays put (no float up toward the stage bar), stopping short like the rest of the ponder
    expect(declsOf(".aj-pop.aj-low .aj-play.aj-mv-ponder .aj-think").flatMap(animNames)).toEqual(["aj-p-think-low"]);
    expect(lastAt("aj-p-think-low")).toBe(84);
    expect(keyframes("aj-p-think-low")).not.toContain("translate");
    // every animation names keyframes that exist, and every keyframes is used
    const defined = new Set([...css.matchAll(/@keyframes ([\w-]+) \{/g)].map((m) => m[1]));
    const used = new Set(RULES.flatMap((r) => animNames(r.decl)));
    expect([...used].filter((k) => !defined.has(k))).toEqual([]);
    expect([...defined].filter((k) => !used.has(k))).toEqual([]);
    expect(defined.size).toBeGreaterThan(150);
    for (const k of defined) expect(k.startsWith("aj-")).toBe(true);
    // the animations end on their element's own style, so they fill backwards only (nothing holds on once over)
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/\bboth\b|forwards/);
    // no words in the stylesheet either (no generated text), only in its comments
    expect(rules).not.toMatch(HANGUL);
    expect(css).not.toContain("content:");
  });

  it("puts on a show of its own for AA, KK (the gorilla, then the crown), QQ and JJ: the whole stage, then the hand's resting face", () => {
    const fireworks = (n: number) => Array.from({ length: n }, (_, i) => [`aj-rk aj-rk${i + 1}`, `aj-fw aj-fw${i + 1}`]).flat();
    const conf = Array.from({ length: 12 }, (_, i) => `aj-conf aj-f${i + 1}`);
    const kids: Record<string, string[]> = {
      plane: ["aj-search", "aj-trail aj-t1", "aj-ring", "aj-trail aj-t2", ...fireworks(5), "aj-flash", "aj-body", "aj-dust aj-d1", "aj-dust aj-d2", ...conf, "aj-poof"],
      gorilla: ["aj-pool", ...[1, 2, 3, 4, 5].map((i) => `aj-wave aj-w${i}`), ...[1, 2, 3, 4, 5, 6].map((i) => `aj-leaf aj-l${i}`), ...fireworks(2), "aj-burst", "aj-body", "aj-roarl", "aj-flash", "aj-spk aj-k1", "aj-spk aj-k2", "aj-spk aj-k3", "aj-dust aj-d1", "aj-dust aj-d2", ...conf, "aj-poof"],
      crown: ["aj-rays", "aj-halo", "aj-trump aj-tp1", "aj-trump aj-tp2", ...[1, 2, 3, 4].map((i) => `aj-tn aj-tn${i}`), ...fireworks(2), "aj-body", "aj-flash", "aj-gleam", ...[1, 2, 3, 4].map((i) => `aj-spk aj-k${i}`), ...conf, "aj-poof"],
      waltz: ["aj-pink", "aj-lights", ...[1, 2, 3, 4, 5].map((i) => `aj-spk aj-k${i}`), "aj-queen aj-qn1", "aj-body", "aj-queen aj-qn2", ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `aj-heart aj-h${i}`), ...fireworks(2), "aj-flash", ...conf.slice(0, 8), "aj-poof"],
      split: ["aj-felt", "aj-sweep", "aj-jack aj-jk2", "aj-jack aj-jk1", "aj-body", "aj-snap aj-sn1", "aj-snap aj-sn2", "aj-strk aj-strk1", "aj-strk aj-strk2", ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `aj-pip aj-pp${i}`), ...fireworks(2), "aj-flash", "aj-spk aj-k1", "aj-spk aj-k2", "aj-spk aj-k3", ...conf.slice(0, 8), "aj-poof"],
    };
    /** How many things move on the stage: the act's HTML boxes (a light, a beam, a puff of smoke, a piece of confetti, a firework...). */
    const layers = (html: string) => (/<span class="aj-act[\s\S]*<\/span><span class="aj-jolt/.exec(html)?.[0].match(/<(span|i)[ >]/g) ?? []).length;
    const shuffle = layers(row(typeIn("UTG", "JTs").s, typeIn("UTG", "JTs").d));
    const counts: Record<string, number> = {};
    let s = AJAE_START;
    const played: string[] = [];
    for (const [seat, cls] of [["UTG", "AA"], ["CO", "KK"], ["BTN", "KK"], ["HJ", "QQ"], ["UTG", "JJ"]]) {
      const r = typeIn(seat, cls, s);
      s = r.s;
      const { move, tier, n } = s.cue!;
      played.push(move);
      expect(SPECIAL_MOVES.has(move)).toBe(true);
      expect(tier).toBe(ajaeTier(cls, seat, "mid", 9));
      const html = row(s, r.d);
      // the face waits on the show's own clock, in the slot, and rests as the hand's tier does
      expect(html).toContain(`<span class="aj-slot aj-after aj-for-${move}" aria-hidden="true"><span class="aj-face aj-${tier}"><svg`);
      expect(html).toContain(`<span class="aj-act aj-mv-${move}" aria-hidden="true">`);
      expect(html).toContain(`<span class="aj-jolt aj-x-${move} aj-j${n % 2}"><span class="fast-class done" aria-live="polite">CLS</span></span>`);
      expect(actChildren(html), move).toEqual(kids[move]);
      // more going on than in the good hands' mirror-ball shuffle
      counts[move] = layers(html);
      expect(counts[move], move).toBeGreaterThan(shuffle + 8);
      // the parts each show draws
      const parts: Record<string, string[]> = {
        plane: ["aj-rig", "aj-r-prop", "aj-r-scarf", "aj-r-arm-l"],
        gorilla: ["aj-r-mask", "aj-r-roar", "aj-r-shut"],
        crown: ["aj-r-crown", "aj-r-cape", "aj-r-collar", "aj-r-scep"],
        waltz: ["aj-r-tie", "aj-qd", "aj-qd-arm-l", "aj-qd-arm-r", "aj-qd-leg-l", "aj-qd-leg-r"],
        split: ["aj-jc-pic", "aj-jc-shades", "aj-sheen"],
      };
      for (const part of parts[move]) expect(html, `${move} ${part}`).toContain(`class="${part}"`);
      for (const other of SPECIAL_MOVES) if (other !== move) for (const part of parts[other].filter((x) => x !== "aj-rig" && x !== "aj-r-arm-l")) expect(html, `${move} draws ${part}`).not.toContain(`class="${part}"`);
    }
    expect(played).toEqual(["plane", "gorilla", "crown", "waltz", "split"]);
    // AA's the most of all
    for (const m of ["gorilla", "crown", "waltz", "split"]) expect(counts[m], m).toBeLessThan(counts.plane);
    expect(Object.values(AJAE_SPECIALS).flat().sort()).toEqual([...SPECIAL_MOVES].sort());
    // the ring of smoke the loop leaves: sixteen puffs; the jacks: two cards, each frame clipped by an id of its own, the
    // first with its court picture still to come (he dives into it), the second with it from the start
    const plane = row(typeIn("UTG", "AA").s, typeIn("UTG", "AA").d);
    expect(/<span class="aj-ring">((?:<i><\/i>)+)<\/span>/.exec(plane)?.[1].match(/<i>/g)).toHaveLength(16);
    const jj = typeIn("UTG", "JJ");
    const jacks = row(jj.s, jj.d);
    const ids = [...jacks.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(jacks.match(/class="aj-jc-pic"/g)).toHaveLength(1);
    expect(jacks.indexOf('class="aj-jc-pic"')).toBeGreaterThan(jacks.indexOf("aj-jack aj-jk1"));
    // the queens: hearts and spades, their index drawn as paths (no text anywhere)
    const qq = typeIn("UTG", "QQ");
    expect(/<span class="aj-act[\s\S]*<\/span><span class="aj-jolt/.exec(row(qq.s, qq.d))?.[0]).not.toContain("<text");
  });

  it("says no word and stays bald in the pairs' shows too: no text, no Hangul; brown only for the mustache and the brows", () => {
    const MUSTACHE_D = "M0 14 C -8 6, -24 5, -34 14 C -39 19, -46 19, -50 14 C -46 28, -28 31, -14 23 C -7 19, -3 18, 0 21 C 3 18, 7 19, 14 23 C 28 31, 46 28, 50 14 C 46 19, 39 19, 34 14 C 24 5, 8 6, 0 14 Z";
    const BROWS = new Set(["M-29 -14 Q -21 -19.5 -13 -15.5", "M13 -15.5 Q 21 -19.5 29 -14", "M-29 -14 Q -21 -19.5 -13 -15.5 M13 -15.5 Q 21 -19.5 29 -14"]);
    const brown = (markup: string): string[] => {
      const out: string[] = [];
      for (const m of markup.matchAll(/<(\w+)((?:[^>"]|"[^"]*")*)>/g)) {
        if (!/#3b2a1e/i.test(m[2])) continue;
        if (m[1] === "g") {
          const inner = markup.slice(m.index! + m[0].length, markup.indexOf("</g>", m.index!));
          for (const d of inner.matchAll(/ d="([^"]+)"/g)) out.push(d[1]);
        } else out.push(/ d="([^"]+)"/.exec(m[2])?.[1] ?? `<${m[1]}>`);
      }
      return out;
    };
    let n = 0;
    for (const [pair, moves] of Object.entries(AJAE_SPECIALS)) {
      for (const move of moves as readonly AjaeMove[]) {
        for (const settled of [false, true]) {
          const cue: AjaeCue = { n: ++n, key: `${pair}|`, cls: pair, tier: "monster", move, ...(settled ? { settled: true as const } : {}) };
          if (pair === "JJ") cue.tier = ajaeTier("JJ", "UTG", "mid", 9);
          const html = render(
            <AjaeReaction cue={cue} seat="UTG" stage="mid" players={9}>
              <span className="fast-class done">CLS</span>
            </AjaeReaction>,
          );
          expect(html).not.toMatch(HANGUL);
          for (const t of html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect(t[1].trim()).toBe("?");
          expect(html.replace(/<[^>]*>/g, "").replace("CLS", "").replace(/[?\s]/g, "")).toBe("");
          expect(html.includes("aj-act")).toBe(!settled);
          const shapes = brown(html);
          expect(shapes, move).toContain(MUSTACHE_D);
          for (const d of shapes) expect(d === MUSTACHE_D || BROWS.has(d), `${move}: brown ${d}`).toBe(true);
          // the same bald head as everywhere: no hair shape of the old drawing, ears either side, the shine on top
          for (const h of ["M-44 -10 C -50 -30", "M44 -10 C 50 -30", "M-14 -56 q 14 -8 30 2", "M-32 -50", "M32 -50"]) expect(html, `${move} has hair`).not.toContain(h);
          expect(html).toMatch(/<ellipse cx="-43" cy="-8" rx="7.5" ry="10.5"/);
          expect(html).toMatch(/<ellipse cx="43" cy="-8" rx="7.5" ry="10.5"/);
          expect(html).toContain("M-26.4 -42 A13 6.5 -18 1 1 -1.6 -50 A13 6.5 -18 1 1 -26.4 -42 Z");
          if (!settled) {
            // the doll in his costume or with his props is the same bald head (the face, the doll, and the jack's picture)
            const heads = html.match(/<ellipse cx="-43" cy="-8"/g)!.length;
            expect(heads, move).toBeGreaterThanOrEqual(move === "split" ? 4 : 2);
            // the gorilla costume's fur is no hair colour of his
            if (move === "gorilla") expect(html).not.toMatch(/#3b2a1e"[^>]*class="aj-r-mask/);
          }
        }
      }
    }
  });

  it("runs every pair's show on CSS alone: up to 3 s, longer than the tiers' moves, its face on the same clock, cheap to animate", () => {
    const dur = (decls: string[]) => Number(/animation-duration: ([\d.]+)s/.exec(decls.join(";"))?.[1]);
    for (const m of SPECIAL_MOVES) {
      const d = dur(declsOf(`.aj-act.aj-mv-${m} *`));
      expect(d, m).toBeGreaterThan(2.5);
      expect(d, m).toBeLessThanOrEqual(3);
      // the face comes in as the show ends: on its clock
      expect(RULES.some((r) => r.sel.includes(`.aj-after.aj-for-${m} .aj-face`) && r.sel.includes(`.aj-after.aj-for-${m} .aj-face *`) && r.decl.includes(`animation-duration: ${d}s`)), m).toBe(true);
      for (const p of [0, 1]) expect(declsOf(`.aj-jolt.aj-x-${m}.aj-j${p}`).join(";"), m).toContain(` ${d}s `);
      // and nothing of it outlasts it: every delayed part ends by then
      for (const r of RULES.filter((x) => x.sel.some((sel) => sel.startsWith(`.aj-mv-${m} `)))) {
        const delay = Number(/animation-delay: ([\d.]+)s/.exec(r.decl)?.[1] ?? NaN);
        const own = Number(/animation-duration: ([\d.]+)s/.exec(r.decl)?.[1] ?? NaN);
        if (!Number.isNaN(delay) && !Number.isNaN(own)) expect(delay + own, `${r.sel.join(",")}`).toBeLessThanOrEqual(d + 1e-9);
        // the shorthands too, with a delay or not (the prop and the scarf repeat from the start)
        const short = /animation: (aj-[\w-]+) ([\d.]+)s [\w-]+(?:\([^)]*\))?(?: ([\d.]+)s)?(?: (\d+))?/.exec(r.decl);
        if (short) expect(Number(short[3] ?? 0) + Number(short[2]) * Number(short[4] ?? 1), r.sel.join(",")).toBeLessThanOrEqual(d + 1e-9);
      }
    }
    // transforms and opacity only: no filters, no blur, no animated layout (cheap on iPhone Safari)
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/filter|blur\(|backdrop/);
    for (const k of rules.matchAll(/@keyframes ([\w-]+) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
      for (const step of k[2].matchAll(/\{([^}]*)\}/g)) {
        for (const decl of step[1].split(";").map((x) => x.trim()).filter(Boolean)) expect(["transform", "opacity", "animation-timing-function", "z-index", "clip-path"], `${k[1]}: ${decl}`).toContain(decl.split(":")[0].trim());
      }
    }
  });

  it("has its switch in 설정, like 카드 색: on by default, off kept, and older saved settings load as on", async () => {
    let html = render(<SettingsPage />);
    expect(html).toContain('<h2>빠른 기록 아재 리액션</h2><div class="seg small" role="group" aria-label="빠른 기록 아재 리액션"><button type="button" class="on" aria-pressed="true">켜기</button><button type="button" class="" aria-pressed="false">끄기</button></div><span class="muted small">카드 두 장을 넣으면 아재가 반응해요. 옆 사람에게 보일까 걱정되면 끄세요.</span>');
    settingsStore.set({ ...initialSettings, ajae: false });
    html = render(<SettingsPage />);
    expect(html).toContain('<button type="button" class="" aria-pressed="false">켜기</button><button type="button" class="on" aria-pressed="true">끄기</button>');

    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    // settings saved before the switch existed: everything else kept, the 아재 on
    saved.set("mygto.settings", JSON.stringify({ model: "claude-sonnet-5-5", cardColors: "two" }));
    vi.resetModules();
    let mod = await import("../../state/settings");
    expect(mod.settingsStore.get()).toMatchObject({ model: "claude-sonnet-5-5", cardColors: "two", ajae: true });
    // switched off: written, and still off on the next launch
    mod.settingsStore.set((x) => ({ ...x, ajae: false }));
    expect(JSON.parse(saved.get("mygto.settings")!).ajae).toBe(false);
    vi.resetModules();
    mod = await import("../../state/settings");
    expect(mod.ajaeOn(mod.settingsStore.get().ajae)).toBe(false);
  });
});
