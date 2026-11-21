import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESETS } from "../../play/profile";
import { tableKeys, type Decision } from "../../play/table";

/** The AI table's own store, the seat mapping and the stats keys it records. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Loads the module fresh against `saved` (localStorage), as an app start does. */
async function launch(saved: Map<string, string>) {
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
  vi.resetModules();
  return import("./tableSettings");
}

describe("table settings", () => {
  it("sanitizes garbage, wrong lengths and out-of-range values", async () => {
    const { tableSettingsOf, DEFAULT_TABLE } = await launch(new Map());
    expect(tableSettingsOf(null)).toEqual(DEFAULT_TABLE);
    expect(tableSettingsOf("x")).toEqual(DEFAULT_TABLE);
    const t = tableSettingsOf({ v: 7, seats: [{ loose: 5, aggro: "a", sticky: -1 }, null, 3], button: 13.7, instant: "yes" });
    expect(t.seats).toHaveLength(8);
    expect(t.seats[0]).toEqual({ loose: 2, aggro: 0, sticky: 0 });
    expect(t.seats[1]).toEqual({ loose: 0, aggro: 0, sticky: 0 });
    expect(t.button).toBe(4);
    expect(t.instant).toBeUndefined();
    expect(tableSettingsOf({ seats: Array.from({ length: 12 }, () => PRESETS.pub.p), button: -1 }).seats).toHaveLength(8);
    expect(tableSettingsOf({ button: -1 }).button).toBe(8);
  });

  it("writes only mygto.table: the settings, stats and hand log keys are untouched", async () => {
    const saved = new Map([
      ["mygto.settings", '{"playMode":"pub"}'],
      ["mygto.stats", '{"byKey":{"play":{"attempts":3,"correct":2}},"streak":1,"bestStreak":2}'],
      ["mygto.handlog", '{"hands":[{"id":"h1"}]}'],
    ]);
    const before = new Map(saved);
    const mod = await launch(saved);
    mod.updateTable((t) => ({ ...t, seats: t.seats.map(() => PRESETS.pub.p), button: 3 }));
    expect([...saved.keys()].sort()).toEqual(["mygto.handlog", "mygto.settings", "mygto.stats", "mygto.table"]);
    for (const k of ["mygto.settings", "mygto.stats", "mygto.handlog"]) expect(saved.get(k)).toBe(before.get(k));
    expect(mod.readTable().seats[0]).toEqual(PRESETS.pub.p);
    // A broken stored value reads as the default, never throws.
    const bad = await launch(new Map([["mygto.table", '{"seats":"no","button":"x"}']]));
    expect(bad.readTable().button).toBe(0);
  });

  it("maps physical seats to the engine: the button is the BTN, then the blinds, then UTG", async () => {
    const { engineIndex, physicalSeat, profilesFor, DEFAULT_TABLE } = await launch(new Map());
    for (const n of [6, 9])
      for (let b = 0; b < n; b++) {
        expect(engineIndex(b, b, n)).toBe(n - 3);
        expect(engineIndex((b + 1) % n, b, n)).toBe(n - 2);
        expect(engineIndex((b + 2) % n, b, n)).toBe(n - 1);
        expect(engineIndex((b + 3) % n, b, n)).toBe(0);
        for (let p = 0; p < n; p++) expect(physicalSeat(engineIndex(p, b, n), b, n)).toBe(p);
      }
    // The seat on my left keeps its profile wherever the button is.
    const t = { ...DEFAULT_TABLE, seats: DEFAULT_TABLE.seats.map((p, i) => (i === 0 ? PRESETS.aggro.p : p)) };
    for (let b = 0; b < 9; b++) {
      const prof = profilesFor(t, b, 9);
      expect(prof[engineIndex(0, b, 9)]).toBeNull();
      expect(prof[engineIndex(1, b, 9)]).toEqual(PRESETS.aggro.p);
    }
  });

  it("records the play keys as before and the table keys beside them; 참고 records nothing", () => {
    const pre = { grade: "good", street: "preflop", source: "chart", chartInfo: { source: "solver", approx: [], tags: [], facts: [] } } as unknown as Decision;
    expect(tableKeys(pre, "mid")).toEqual(["table:pre", "table:pre:mid"]);
    expect(tableKeys({ ...pre, street: "flop", chartInfo: undefined, source: "solverApprox" }, "mid")).toEqual(["table:solver", "table:solver:approx"]);
    expect(tableKeys({ ...pre, street: "flop", chartInfo: undefined, source: "solver" }, "100bb")).toEqual(["table:solver", "table:solver:exact"]);
    expect(tableKeys({ ...pre, grade: "info" }, "mid")).toEqual([]);
  });
});

describe("setup and summary render", () => {
  const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("lists every opponent seat with its preset, and the packs the manifest holds", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.resetModules();
    const { TableSetup, mixText } = await import("./TableSetup");
    const raw = render(<TableSetup opponents={8} packText="지금 있는 솔버 팩 3개: A · B · C" onClose={() => {}} />);
    const html = text(raw);
    expect(html).toContain("1 · 내 왼쪽");
    expect(html).toContain("8 · 내 오른쪽");
    expect(raw.match(/>조절</g)).toHaveLength(8);
    expect(html).toContain("성향 조절은 근사 모델");
    expect(html).toContain("지금 있는 솔버 팩 3개");
    expect(mixText([PRESETS.gto.p, PRESETS.pub.p, PRESETS.pub.p, { loose: 1, aggro: 1, sticky: 0 }])).toBe("상대: GTO 1 · 펍 2 · 직접 1");
  });

  it("gives every decision a row with its reference and a 다시 이 상황 button", async () => {
    const { HandSummary } = await import("./HandSummary");
    const base = { board: [], pot: 5, toCall: 0, reqEquity: null, spr: 9, equity: null, villains: [], options: [] };
    const ds = [
      { ...base, street: "preflop", chosen: "call", chosenLabel: "콜 2.2", grade: "good", summary: "차트 기준 콜 빈도 80%", chart: "솔버 55bb · BB vs BTN 오픈 — 콜 80% / 폴드 20%", chartInfo: { source: "solver", confidence: "중간", approx: [], tags: [], facts: [] } },
      { ...base, street: "flop", chosen: "check", chosenLabel: "체크", grade: "ok", summary: "솔버 기준 …", pack: { packId: "p", title: "T", level: "approx", reasons: [], path: [0], labels: ["체크", "벳 33%"], freq: [0.2, 0.8], ev: [1, 1.4], chosen: 0, loss: 0.4, lossPct: 0.07 } },
      { ...base, street: "turn", chosen: "check", chosenLabel: "체크", grade: "info", summary: "", reason: "턴부터는 솔버 없음 · 근사" },
    ] as unknown as Decision[];
    const html = text(render(<HandSummary decisions={ds} onReplay={() => {}} />));
    expect(html.match(/다시 이 상황/g)).toHaveLength(3);
    expect(html).toContain("차트 55bb · BB vs BTN 오픈 · 콜 80% / 폴드 20% · 신뢰도 중간");
    expect(html).toContain("솔버 근사 · 체크: 20% / 벳 33%: 80% · 손실 팟의 7%");
    expect(html).toContain("턴부터는 솔버 없음 · 근사");
    expect(html).toContain("참고");
  });

  it("names the right source: no chart in a tournament is never the cash chart, and the opponents' profiles show", async () => {
    const { referenceLine } = await import("./HandSummary");
    const base = { street: "preflop", board: [], pot: 5, toCall: 0, reqEquity: null, spr: 9, equity: null, villains: [], options: [], chosen: "fold", chosenLabel: "폴드", grade: "info" };
    // A tournament limped pot: analyseComputed's no-chart decision (chartInfo with a null source).
    const none = { ...base, summary: "계산된 차트 없음 · 림프 팟", chart: "이 상황은 계산된 차트가 없어요 · 림프 팟", chartInfo: { source: null, none: "림프 팟", approx: [], tags: [], facts: [] } } as unknown as Decision;
    expect(referenceLine(none)).toBe("차트 없음 · 림프 팟");
    // The cash table's hand-made chart (no chartInfo), against a non-GTO table.
    const cash = { ...base, grade: "good", summary: "차트 기준 폴드 빈도 100%", chart: "BTN 오픈: 폴드", vsProfile: true } as unknown as Decision;
    expect(referenceLine(cash)).toBe("캐시 차트 (손으로 만든 근사) · BTN 오픈: 폴드 · 상대 성향 미반영");
    // A pack grade against a 펍 아저씨 opponent says so on the row, not only behind 왜?.
    const pack = { ...base, street: "flop", grade: "good", summary: "", pack: { packId: "p", title: "T", level: "approx", reasons: ["SPR 8.8 → 7.9", "상대 성향 미반영"], path: [], labels: ["체크", "벳 33%"], freq: [0.4, 0.6], ev: [1, 1.1], chosen: 1, loss: 0, lossPct: 0 } } as unknown as Decision;
    expect(referenceLine(pack)).toBe("솔버 근사 · 체크: 40% / 벳 33%: 60% · 손실 팟의 0% · 상대 성향 미반영");
  });
});
