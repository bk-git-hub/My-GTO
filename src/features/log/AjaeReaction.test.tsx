import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RANKS } from "../../poker/cards";
import { ajaeOn, settingsStore } from "../../state/settings";
import { AJAE_START, ajaeSeen, ajaeStep, type AjaeState } from "./ajae";
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
function typeIn(seat: string, cls: string, s: AjaeState = AJAE_START): { s: AjaeState; d: FastDraft } {
  const steps: FastDraft[] = [newDraft(seat)];
  steps.push(tapRank(steps[steps.length - 1], R(cls[0])));
  steps.push(tapRank(steps[steps.length - 1], R(cls[1])));
  if (cls[2]) steps.push(pickSuited(steps[steps.length - 1], cls[2] === "s"));
  for (let i = 1; i < steps.length; i++) s = ajaeStep(s, steps[i - 1], steps[i], "mid", 9);
  return { s, d: steps[steps.length - 1] };
}
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
  it("pops up by the class when the cards are typed in: AA at UTG is a monster with its own line", () => {
    const { s, d } = typeIn("UTG", "AA");
    const html = row(s, d);
    expect(html).toMatch(/^<span class="ajae-host"><span class="aj-slot aj-pop" aria-hidden="true"><span class="aj-face aj-monster aj-play"><svg class="aj-fig"/);
    expect(html).toContain('<span class="aj-bubble">주머니 로켓!</span>');
    // the class itself is untouched, after the overlays, in the jolt wrapper
    expect(html).toMatch(/<span class="aj-jolt"><span class="fast-class done" aria-live="polite">CLS<\/span><\/span><\/span>$/);
    expect(html).not.toContain("aj-kick");
  });

  it("makes each tier's face: a yawn for K9o at UTG, a nod for JTs, a ? for meh, the beer for 72o", () => {
    const typed = (seat: string, cls: string) => {
      const { s, d } = typeIn(seat, cls);
      return row(s, d);
    };
    expect(typed("UTG", "K9o")).toMatch(/aj-face aj-fold aj-play.*<span class="aj-bubble">자리가 아쉽네<\/span>/s);
    expect(typed("UTG", "JTs")).toContain("aj-face aj-good aj-play");
    expect(typed("CO", "Q9o")).toContain("aj-face aj-meh aj-play");
    expect(typed("BTN", "72o")).toMatch(/aj-face aj-hammer aj-play.*해머네 ㅋ 건배/s);
  });

  it("kicks a trash hand: no face, the whole 아재 with 뻥! and his line, and the class jolts", () => {
    const { s, d } = typeIn("CO", "J4o");
    const html = row(s, d);
    expect(html).not.toContain("aj-slot");
    expect(html).toMatch(/<span class="aj-kick" aria-hidden="true"><span class="aj-kicker"><svg[^>]*>.*<\/svg><\/span><span class="aj-boom">뻥!<\/span><span class="aj-kbubble">에잉!<\/span><\/span>/s);
    expect(html).toContain(`<span class="aj-jolt aj-kicked aj-k${s.cue!.n % 2}"><span class="fast-class done" aria-live="polite">CLS</span></span>`);
    // a second kick right after gets the other keyframes, so the jolt starts over
    const again = typeIn("CO", "93o", s);
    expect(row(again.s, again.d)).toContain(`aj-jolt aj-kicked aj-k${again.s.cue!.n % 2}"`);
    expect(again.s.cue!.n % 2).not.toBe(s.cue!.n % 2);
    expect(row(again.s, again.d)).toContain('<span class="aj-kbubble">저리 가!</span>');
  });

  it("goes at once when the class is cleared", () => {
    const { s, d } = typeIn("UTG", "K9o");
    const back = undoTap(d);
    const html = row(ajaeStep(s, d, back, "mid", 9), back, false);
    expect(html).toBe('<span class="ajae-host"><span class="aj-jolt"><span class="fast-class" aria-live="polite">CLS</span></span></span>');
  });

  it("shows the new seat's face at rest when my seat changes, without moving or talking, and doesn't replay on the way back", () => {
    const { s, d } = typeIn("UTG", "K9o");
    const btn = withSeat(d, "BTN", 9);
    const next = ajaeStep(s, d, btn, "mid", 9);
    expect(next).toBe(s);
    const html = row(next, btn);
    expect(html).toContain('<span class="aj-slot" aria-hidden="true"><span class="aj-face aj-good"><svg');
    expect(html).not.toContain("aj-play");
    expect(html).not.toContain("aj-bubble");
    // back at UTG (a fold again, as when the cards went in): the yawn at rest, no pop, no line
    const atBtn = ajaeSeen(next, btn, "mid", 9);
    const utg = withSeat(btn, "UTG", 9);
    const back = row(ajaeStep(atBtn, btn, utg, "mid", 9), utg);
    expect(back).toContain('<span class="aj-slot" aria-hidden="true"><span class="aj-face aj-fold"><svg');
    expect(back).not.toContain("aj-play");
    expect(back).not.toContain("aj-bubble");
    // a cue whose tier changed and came back, as FastView passes it (settled), never moves; one that never left still does
    expect(render(<AjaeReaction cue={atBtn.cue} seat="UTG" stage="mid" players={9}>K9o</AjaeReaction>)).not.toContain("aj-pop");
    expect(render(<AjaeReaction cue={s.cue} seat="UTG" stage="mid" players={9}>K9o</AjaeReaction>)).toContain("aj-slot aj-pop");
  });

  it("shows nothing for a class restored on load or opened to correct, in FastView itself", () => {
    // a draft left in the editor (a reload): the class is there, the 아재 is not
    fastStore.set({ stage: "mid", players: 9, draft: typeIn("CO", "J4o").d });
    let html = page("fast");
    expect(html).toContain('<span class="ajae-host"><span class="aj-jolt"><span class="fast-class done" aria-live="polite">J4o</span></span></span>');
    expect(html).not.toMatch(/aj-(slot|kick)/);
    // a saved hand opened to correct
    const h = fastHand(typeIn("UTG", "AA").d, "open", { ...emptyHand(null), id: "h1", createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 }, "mid", 9)!;
    handLogStore.set({ ...initialLog, hands: [h] });
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("CO"), parked: null }, h));
    html = page("fast");
    expect(html).toContain('<span class="fast-class done" aria-live="polite">AA</span>');
    expect(html).not.toMatch(/aj-(slot|kick)/);
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
    for (const sel of [".aj-slot", ".aj-kick"]) {
      const rule = new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule).toContain("position: absolute");
      expect(rule).toContain("pointer-events: none");
    }
    for (const sel of [".aj-bubble", ".aj-kicker", ".aj-boom", ".aj-kbubble"]) expect(new RegExp(`\\n${sel.replace(".", "\\.")} \\{[^}]*position: absolute`).test(css)).toBe(true);
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(reduce).toContain(".aj-play *");
    expect(reduce).toContain(".aj-kicker");
    expect(reduce).toContain("animation: none !important");
    expect(reduce).toMatch(/\.aj-bubble \{[^}]*animation: aj-fade/);
    expect(reduce).toMatch(/\.aj-kbubble \{[^}]*animation: aj-fade/);
    // at rest he is cut to his slot (no shirt over the pad keys); the cut opens only while he pops
    expect(/\n\.aj-face \{[^}]*clip-path: inset\(0\)/.test(css)).toBe(true);
    expect(/\n\.aj-pop \.aj-face \{[^}]*aj-open 1\.9s step-end both/.test(css)).toBe(true);
    expect(/\n\.aj-slot \{[^}]*bottom: -3px/.test(css)).toBe(true);
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
