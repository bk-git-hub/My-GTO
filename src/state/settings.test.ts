import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Loads the settings module fresh against `saved` (localStorage), as an app start does. */
async function launch(saved: Map<string, string>) {
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
  vi.resetModules();
  return import("./settings");
}

describe("the default chart set", () => {
  it("is the solver's computed tournament chart on a first launch", async () => {
    const mod = await launch(new Map());
    expect(mod.settingsStore.get().chartSet).toBe("solver");
  });

  it("moves settings saved on the old default (pub) to it once, keeping everything else", async () => {
    const saved = new Map([["mygto.settings", JSON.stringify({ model: "claude-sonnet-5-5", chartSet: "pub", cardColors: "two" })]]);
    const mod = await launch(saved);
    expect(mod.settingsStore.get()).toMatchObject({ model: "claude-sonnet-5-5", chartSet: "solver", cardColors: "two" });
    expect(JSON.parse(saved.get("mygto.settings")!).chartSet).toBe("solver");
  });

  it("keeps a set picked by hand, pub included, and any other saved set", async () => {
    const saved = new Map<string, string>();
    let mod = await launch(saved);
    mod.settingsStore.set((s) => ({ ...s, chartSet: "pub", chartSetPicked: true }));
    mod = await launch(saved);
    expect(mod.settingsStore.get().chartSet).toBe("pub");
    saved.set("mygto.settings", JSON.stringify({ chartSet: "cash6" }));
    mod = await launch(saved);
    expect(mod.settingsStore.get().chartSet).toBe("cash6");
  });
});
