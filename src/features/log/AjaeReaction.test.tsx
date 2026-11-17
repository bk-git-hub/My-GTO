import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RANKS } from "../../poker/cards";
import { ajaeOn, settingsStore } from "../../state/settings";
import { AJAE_CRAMPED, AJAE_MOVES, AJAE_START, ajaeSeen, ajaeStep, ajaeTier, BODY_MOVES, type AjaeCue, type AjaeMove, type AjaeState, type AjaeTier } from "./ajae";
import { AjaeReaction } from "./AjaeReaction";
import { fastHand, fastOtherStore, fastStore, newDraft, pickSuited, startEdit, tapRank, undoTap, withSeat, type FastDraft } from "./fastLog";
import { emptyHand, handLogStore } from "./handLog";
import { SettingsPage } from "../settings/SettingsPage";
import { LogPage } from "./LogPage";

// No @types/node here: reach node:fs through an untyped handle (vitest serves an imported .css as empty).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const css = fs.readFileSync(new URL("./ajae.css", import.meta.url), "utf8");

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
  it("shoves all in for a monster: AA at UTG is the whole 아재 with his chip stacks, then the grinning face in the slot", () => {
    const { s, d } = typeIn("UTG", "AA");
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

  it("makes the face's moves for meh, fold and 72o: a ? for meh, a yawn or a glare at the seat row for a fold, the beer for 72o", () => {
    const typed = (seat: string, cls: string, s?: AjaeState) => {
      const r = typeIn(seat, cls, s);
      return { html: row(r.s, r.d), s: r.s };
    };
    const yawn = typed("UTG", "K9o");
    expect(yawn.html).toContain('<span class="aj-slot aj-pop" aria-hidden="true"><span class="aj-face aj-fold aj-play aj-mv-yawn"><svg');
    expect(typed("UTG", "K9o", yawn.s).html).toContain('<span class="aj-face aj-fold aj-play aj-mv-glare">');
    const meh = typed("CO", "Q9o").html;
    const beer = typed("BTN", "72o").html;
    expect(meh).toContain('<span class="aj-face aj-meh aj-play aj-mv-hmm">');
    expect(beer).toContain('<span class="aj-face aj-hammer aj-play aj-mv-beer">');
    for (const h of [yawn.html, meh, beer]) {
      expect(h).not.toContain("aj-act");
      expect(h).toMatch(/<span class="aj-jolt"><span class="fast-class done"/);
    }
  });

  it("goes for a trash hand three ways (kick, mallet, card slam) and stays beside it furious: no walking off", () => {
    let s = AJAE_START;
    const fumes = ["aj-puff aj-p0", "aj-puff aj-p1", "aj-puff aj-p2", "aj-poof"];
    const kids: Record<string, string[]> = {
      kick: ["aj-body", "aj-whoosh", "aj-burst", "aj-dust aj-d1", "aj-dust aj-d2", ...fumes],
      mallet: ["aj-body", "aj-burst", "aj-crack", "aj-dizzy", "aj-speed", ...fumes],
      slam: ["aj-body", "aj-card aj-cd1", "aj-card aj-cd2", "aj-lines", "aj-bang", "aj-burst", "aj-dust aj-d1", "aj-dust aj-d2", ...fumes],
    };
    const parity: number[] = [];
    for (const [cls, move] of [["J4o", "kick"], ["93o", "mallet"], ["T8o", "slam"], ["J4o", "kick"]]) {
      const r = typeIn("CO", cls, s);
      s = r.s;
      const html = row(s, r.d);
      // the face is in the slot from the start (it pops in, furious, as he finishes) and stays there
      expect(html).toContain('<span class="aj-slot aj-after" aria-hidden="true"><span class="aj-face aj-trash"><svg');
      expect(html).toContain(`<span class="aj-act aj-mv-${move}" aria-hidden="true">`);
      expect(actChildren(html)).toEqual(kids[move]);
      expect(html).toContain(`<span class="aj-jolt aj-x-${move} aj-j${s.cue!.n % 2}"><span class="fast-class done" aria-live="polite">CLS</span></span>`);
      parity.push(s.cue!.n % 2);
      // the furious face's parts are all there (the resting face shows them by .aj-trash), and so is the mallet when he swings it
      for (const part of ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-steam aj-st-rest"]) expect(html).toContain(`class="${part}"`);
      expect(html.includes('class="aj-r-mallet"')).toBe(move === "mallet");
    }
    // back to back, each reaction gets the other keyframes, so the class's move starts over
    expect(parity).toEqual([1, 0, 1, 0]);
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
          // no text at all but the symbols ? and z (in the svg)
          for (const t of html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect(["?", "z", "Z"]).toContain(t[1].trim());
          expect(html.replace(/<[^>]*>/g, "").replace("CLS", "").replace(/[?zZ\s]/g, "")).toBe("");
          if (!c.settled) expect(html.includes("aj-act")).toBe(BODY_MOVES.has(move));
          else expect(html).not.toMatch(/aj-act|aj-play/);
        }
      }
    }
    expect([...left]).toEqual([]);
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
    // a face move with room for the full pop pops as usual; settled, nothing pops at all
    const meh = typeIn("CO", "Q9o", AJAE_START, 70);
    expect(row(meh.s, meh.d)).toContain('<span class="aj-slot aj-pop" aria-hidden="true"><span class="aj-face aj-meh aj-play aj-mv-hmm">');
    const lowMeh = typeIn("CO", "Q9o", AJAE_START, 40);
    expect(row(lowMeh.s, lowMeh.d)).toContain('<span class="aj-slot aj-pop aj-low" aria-hidden="true"><span class="aj-face aj-meh aj-play aj-mv-hmm">');
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
    // back at UTG (a fold again, as when the cards went in): the doze at rest, no pop
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
    expect(row(j4.s, withSeat(j4.d, "BB", 9))).toContain("aj-act aj-mv-kick");
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
    for (const m of ["hmm", "yawn", "glare", "beer", "cheer", "nod", "fume"]) expect(css).toContain(`.aj-play.aj-mv-${m} `);
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
      hmm: ["aj-head", "aj-shades", "aj-qmark"], yawn: ["aj-head", "aj-yawn", "aj-zfly"], glare: ["aj-head", "aj-shades", "aj-sweat"], beer: ["aj-mug", "aj-head"],
      cheer: ["aj-shades", "aj-sp", "aj-smile"], nod: ["aj-head", "aj-smile"], fume: ["aj-head", "aj-vbrows", "aj-vein", "aj-flush"],
    };
    for (const [m, parts] of Object.entries(faceParts)) for (const part of parts) expect(declsOf(`.aj-play.aj-mv-${m} .${part}`).flatMap(animNames), `${m} ${part}`).not.toEqual([]);
    // the resting faces: hidden parts the tier shows at rest (the trash face's fury above all: red, brows, teeth, vein, steam)
    const resting: Record<string, string[]> = {
      trash: ["aj-flush", "aj-teeth", "aj-vbrows", "aj-vein", "aj-st-rest"], monster: ["aj-smile", "aj-sp.aj-one"], good: ["aj-smile"], meh: ["aj-flat", "aj-qmark"], fold: ["aj-zrest"], hammer: ["aj-mug"],
    };
    for (const [tier, parts] of Object.entries(resting)) {
      for (const part of parts) {
        const shown = declsOf(`.aj-${tier} .${part}`).map((d) => Number(/opacity: ([\d.]+)/.exec(d)?.[1] ?? 0));
        expect(Math.max(0, ...shown), `${tier} ${part}`).toBeGreaterThan(0.3);
      }
    }
    // the dance without its ball hides the ball and its beams
    expect(RULES.some((r) => r.sel.includes(".aj-noball .aj-ball") && r.sel.includes(".aj-noball .aj-beams") && r.decl.includes("display: none"))).toBe(true);
    // the smaller pop (the page scrolled): its own keyframes, smaller than the full pop's
    expect(declsOf(".aj-pop.aj-low .aj-face").flatMap(animNames)).toEqual(["aj-pop-low", "aj-open"]);
    const maxScale = (k: string) => Math.max(...[...keyframes(k).matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1])));
    expect(maxScale("aj-pop")).toBe(2.15);
    expect(maxScale("aj-pop-low")).toBeGreaterThan(1.2);
    expect(maxScale("aj-pop-low")).toBeLessThan(1.6);
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
