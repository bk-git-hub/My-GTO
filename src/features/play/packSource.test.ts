import { describe, expect, it } from "vitest";
import type { Catalog, CatalogPack, Manifest, PackEntry } from "../../presolve/format";
import { readManifest, srpAtFlop } from "../../play/testPacks";
import type { CatalogState, PackClient } from "../solver/packs";
import { createPackSource } from "./packSource";

/**
 * The AI table's pack source over a fake client: the catalog is the registry, a pack's file list loads only when a flop
 * could use it, and a bad entry or a failed fetch never sticks for the session.
 */

/** The catalog of a v1 manifest: each entry without its files, with their count. */
const catalogOf = (m: Manifest): Catalog => ({
  v: 2,
  packs: m.packs.map((p) => {
    const { files, ...rest } = p;
    return { ...rest, flops: files.length, weight: files.length, index: { path: `${p.id}/v${p.version}/index-0000000000000000.json`, sha256: "0".repeat(64), bytes: 1 } } as CatalogPack;
  }),
});

type FakeClient = PackClient & { calls: number; packCalls: string[] };

function fakeClient(m: Manifest, o: { catalog?: (() => Promise<Catalog>)[]; pack?: (id: string, n: number) => Promise<PackEntry> } = {}): FakeClient {
  const catalogs = o.catalog ?? [async () => catalogOf(m)];
  const c: FakeClient = {
    base: "/packs/",
    calls: 0,
    packCalls: [],
    catalog(): Promise<CatalogState> {
      const f = catalogs[Math.min(c.calls++, catalogs.length - 1)];
      return f().then((catalog): CatalogState => ({ status: "ready", catalog, source: "data", offline: false, problems: [] }));
    },
    pack(id: string): Promise<PackEntry> {
      c.packCalls.push(id);
      if (o.pack) return o.pack(id, c.packCalls.filter((x) => x === id).length);
      const e = m.packs.find((p) => p.id === id);
      return e ? Promise.resolve(e) : Promise.reject(new Error("no such pack"));
    },
    flop: () => Promise.reject(new Error("no flop files here")),
    reset() {},
  };
  return c;
}

describe("pack source", () => {
  it("lists the catalog's packs without their files, skipping a malformed entry, and downloads no file list for it", async () => {
    const m = readManifest();
    const bad = { ...m.packs[0], id: "bad", scenario: { ...m.packs[0].scenario, rangeSources: [m.packs[0].scenario.rangeSources![0]] as unknown as [string, string] } };
    const client = fakeClient({ ...m, packs: [bad, ...m.packs] });
    const src = createPackSource(client);
    expect(await src.load({ kind: "manifest" })).toBe(true);
    expect(src.packs()!.map((p) => p.id).sort()).toEqual(["pub-srp-btn-bb-55", "pub-srp-utg-bb-55", "srp-btn-bb-100"]);
    expect(src.packs()!.every((p) => p.pending && p.files.size === 0)).toBe(true);
    expect(client.packCalls).toEqual([]);
  });

  it("asks for the file lists of the packs that could match a flop, then matches it", async () => {
    const m = readManifest();
    const client = fakeClient(m);
    const src = createPackSource(client);
    const s = srpAtFlop("pub", "mid", "BTN", { holes: { BTN: "AcQc", BB: "Ts9s" }, board: "Kd7c2h", hero: "BTN" });
    // Before the catalog: the catalog. Then the packs this flop could use (the pub BTN pack, not the UTG one: other seat).
    expect(src.oracle.needs(s)).toEqual({ kind: "manifest" });
    await src.load({ kind: "manifest" });
    const need = src.oracle.needs(s);
    expect(need?.kind).toBe("packs");
    const ids = need?.kind === "packs" ? need.ids : [];
    expect(ids).toContain("pub-srp-btn-bb-55");
    expect(ids).not.toContain("pub-srp-utg-bb-55");
    expect(src.oracle.match(s)).toBeNull();
    expect(await src.load(need!)).toBe(true);
    expect(client.packCalls.sort()).toEqual([...ids].sort());
    expect(src.oracle.needs(s)).toBeNull();
    expect(src.oracle.match(s)?.file.path).toBe("pub-srp-btn-bb-55/v2/flop-Ks7h2d.json");
    // The UTG pack stays pending: nobody downloaded its 1,755-file list.
    expect(src.packs()!.find((p) => p.id === "pub-srp-utg-bb-55")!.pending).toBe(true);
    // A loaded pack is not asked for again.
    expect(await src.load({ kind: "packs", ids })).toBe(true);
    expect(client.packCalls.length).toBe(ids.length);
  });

  it("asks again after a failed catalog or file-list load, and a failed flop load answers false", async () => {
    const m = readManifest();
    const client = fakeClient(m, {
      catalog: [() => Promise.reject(new TypeError("offline")), async () => catalogOf(m)],
      pack: (id, n) => (n === 1 ? Promise.reject(new TypeError("offline")) : Promise.resolve(m.packs.find((p) => p.id === id)!)),
    });
    const src = createPackSource(client);
    expect(await src.load({ kind: "manifest" })).toBe(false);
    expect(src.packs()).toBeNull();
    expect(await src.load({ kind: "manifest" })).toBe(true);
    expect(client.calls).toBe(2);
    expect(await src.load({ kind: "packs", ids: ["srp-btn-bb-100"] })).toBe(false);
    expect(src.packs()!.find((p) => p.id === "srp-btn-bb-100")!.pending).toBe(true);
    expect(await src.load({ kind: "packs", ids: ["srp-btn-bb-100"] })).toBe(true);
    const pk = src.packs()!.find((p) => p.id === "srp-btn-bb-100")!;
    expect([pk.pending, pk.files.size]).toEqual([false, 1755]);
    const path = pk.files.values().next().value!.path;
    expect(await src.load({ kind: "flop", path })).toBe(false);
  });
});
