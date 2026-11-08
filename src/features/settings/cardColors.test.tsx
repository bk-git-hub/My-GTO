import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardPicker } from "../../components/Cards";
import { applyCardColors, CARD_COLORS_ATTR, cardColorsOf, settingsStore, startCardColors, type Settings } from "../../state/settings";
import { SettingsPage } from "./SettingsPage";

// No @types/node here: reach node:fs through an untyped handle (vitest serves an imported .css as empty).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

const initial = settingsStore.get();
const withColors = (cardColors: unknown) => settingsStore.set({ ...initial, cardColors: cardColors as Settings["cardColors"] });

/** A stand-in for <html>: its attributes, and how often one was written. */
function fakeRoot() {
  const attrs = new Map<string, string>();
  const root = {
    writes: 0,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      root.writes++;
      attrs.set(name, value);
    },
  };
  return root;
}

afterEach(() => {
  settingsStore.set(initial);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("카드 색 setting", () => {
  it("defaults to 4색", () => {
    expect(initial.cardColors).toBe("four");
    expect(cardColorsOf(initial.cardColors)).toBe("four");
  });

  it("reads anything but 2색 as 4색 (missing, old or broken values)", () => {
    expect(cardColorsOf("two")).toBe("two");
    expect(cardColorsOf("four")).toBe("four");
    for (const v of [undefined, null, "", "2", "Two", "2색", 2, true, {}, ["two"]]) expect(cardColorsOf(v)).toBe("four");
  });

  it("is kept with the other settings, and settings saved before it load as 4색", async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });

    // Settings saved before 카드 색 existed: everything else kept, the deck is 4색.
    saved.set("mygto.settings", JSON.stringify({ model: "claude-sonnet-5-5", playMode: "cash" }));
    vi.resetModules();
    let mod = await import("../../state/settings");
    expect(mod.settingsStore.get()).toMatchObject({ model: "claude-sonnet-5-5", playMode: "cash", cardColors: "four" });

    // Picking 2색 is written to storage and comes back on the next launch.
    mod.settingsStore.set((s) => ({ ...s, cardColors: "two" }));
    expect(JSON.parse(saved.get("mygto.settings")!).cardColors).toBe("two");
    vi.resetModules();
    mod = await import("../../state/settings");
    expect(mod.settingsStore.get().cardColors).toBe("two");

    // A broken stored value still shows 4색.
    saved.set("mygto.settings", JSON.stringify({ cardColors: "rainbow" }));
    vi.resetModules();
    mod = await import("../../state/settings");
    const root = fakeRoot();
    mod.applyCardColors(root);
    expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("four");
  });
});

describe("카드 색 on <html>", () => {
  it("puts the deck on the root, and leaves it alone when it is already there", () => {
    const root = fakeRoot();
    applyCardColors(root, { cardColors: "two" });
    expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("two");
    applyCardColors(root, { cardColors: "two" });
    expect(root.writes).toBe(1);
    applyCardColors(root, { cardColors: "four" });
    expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("four");
  });

  it("is set at startup and follows every change of the setting", () => {
    const root = fakeRoot();
    vi.stubGlobal("document", { documentElement: root });
    withColors("two");
    const stop = startCardColors();
    try {
      expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("two");
      withColors("four");
      expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("four");
      withColors("two");
      expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("two");
      // Other settings changing never rewrite it.
      const writes = root.writes;
      settingsStore.set((s) => ({ ...s, userNotes: "숫자는 단계별로" }));
      expect(root.writes).toBe(writes);
    } finally {
      stop();
    }
    withColors("four");
    expect(root.getAttribute(CARD_COLORS_ATTR)).toBe("two");
  });

  it("does nothing without a document (server render, tests)", () => {
    expect(() => startCardColors()()).not.toThrow();
  });
});

describe("설정 · 카드 색 (react-dom/server)", () => {
  const page = () => renderToString(<SettingsPage />).replace(/<!-- -->/g, "");
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("offers 4색 and 2색, the saved one lit, with A♠ K♥ Q♦ J♣ as cards and as text", () => {
    withColors("four");
    let html = page();
    expect(html).toMatch(/<h2>카드 색<\/h2><div class="seg small" role="group" aria-label="카드 색"><button type="button" class="on" aria-pressed="true">4색 \(온라인 표준\)<\/button><button type="button" class="" aria-pressed="false">2색 \(실물 카드\)<\/button><\/div>/);
    const cards = [...html.matchAll(/<span class="card card-sm suit-([shdc])"><span class="card-rank">([2-9TJQKA])<\/span>/g)].map((m) => m[2] + m[1]);
    expect(cards).toEqual(["As", "Kh", "Qd", "Jc"]);
    expect(html).toMatch(/<span class="hole-text"><i class="s-s">A♠︎<\/i><i class="s-h">K♥︎<\/i><i class="s-d">Q♦︎<\/i><i class="s-c">J♣︎<\/i><\/span>/);
    expect(text(html)).toContain("수트마다 색이 달라서 한눈에 구분돼요.");

    withColors("two");
    html = page();
    expect(html).toContain('<button type="button" class="" aria-pressed="false">4색 (온라인 표준)</button><button type="button" class="on" aria-pressed="true">2색 (실물 카드)</button>');
    expect(text(html)).toContain("실물 카드처럼 검정과 빨강 두 색이에요.");
  });

  it("shows 4색 lit for a broken stored value", () => {
    withColors("rainbow");
    expect(page()).toContain('<button type="button" class="on" aria-pressed="true">4색 (온라인 표준)</button>');
  });
});

describe("the card picker (react-dom/server)", () => {
  it("names each row's suit, since in 2색 ♠/♣ and ♥/♦ rows share a color", () => {
    const html = renderToString(<CardPicker selected={[]} max={2} onChange={() => {}} />).replace(/<!-- -->/g, "");
    const rows = [...html.matchAll(/<div class="picker-row"><span class="picker-suit suit-([shdc])" aria-hidden="true">([♠♥♦♣])\uFE0E<\/span>/g)].map((m) => m[1] + m[2]);
    expect(rows).toEqual(["s♠", "h♥", "d♦", "c♣"]);
  });
});

describe("suit colors in styles.css", () => {
  /** Every rule as [selector, body], comments dropped. */
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
  const decl = (body: string, prop: string) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();

  it("colors every suit class from the shared variables, never a literal", () => {
    const suited = rules.filter(([sel, body]) => /\.(?:s|suit)-[shdc]\b/.test(sel) && decl(body, "color"));
    // the white cards (.card, .rt-card, .sv-mc), the keys, the picker and the colored text
    expect(suited.length).toBeGreaterThanOrEqual(24);
    for (const [sel, body] of suited) {
      const suit = /\.(?:s|suit)-([shdc])\b/.exec(sel)![1];
      expect(decl(body, "color"), sel).toMatch(new RegExp(`^var\\(--(?:face|suit)-${suit}\\)$`));
    }
  });

  it("defines 4색 on the root, and 2색 gives clubs the spade's colors and diamonds the heart's", () => {
    const root = rules.find(([sel, body]) => sel === ":root" && decl(body, "--face-s"))![1];
    expect([..."shdc"].map((s) => decl(root, `--face-${s}`))).toEqual(["#111", "#d6202f", "#1d6fd6", "#13893d"]);
    expect([..."shdc"].map((s) => decl(root, `--suit-${s}`))).toEqual(["#f4f7fb", "#ff6b6b", "#4dabf7", "#51cf66"]);
    const two = rules.find(([sel]) => sel === ':root[data-card-colors="two"]')![1];
    expect(decl(two, "--face-d")).toBe("var(--face-h)");
    expect(decl(two, "--face-c")).toBe("var(--face-s)");
    expect(decl(two, "--suit-d")).toBe("var(--suit-h)");
    expect(decl(two, "--suit-c")).toBe("var(--suit-s)");
    // spades and hearts are the same in both decks
    for (const v of ["--face-s", "--face-h", "--suit-s", "--suit-h"]) expect(decl(two, v)).toBeUndefined();
  });
});
