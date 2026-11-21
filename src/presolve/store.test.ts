import { beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticPacks, type SyntheticPacks } from "../../tests/fixtures/solverPack";
import type { Manifest } from "./format";
import { canon, listedBoards, readSetManifest, writeSetManifest, type StoreFs } from "./store";

const crypto = (await import(/* @vite-ignore */ "node:crypto" as string)) as { createHash(a: string): { update(s: string): { digest(e: "hex"): string } } };
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** An in-memory file system that records every write and removal. */
function memFs(init: Record<string, string> = {}) {
  const files = new Map(Object.entries(init));
  const log: string[] = [];
  const fs: StoreFs = {
    exists: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    read: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    write: (p, t) => {
      files.set(p, t);
      log.push(`write ${p}`);
    },
    remove: (p) => {
      files.delete(p);
      log.push(`remove ${p}`);
    },
    list: (d) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1).split("/")[0]))],
  };
  return { fs, files, log };
}

let synth: SyntheticPacks;
beforeAll(async () => {
  synth = await buildSyntheticPacks();
});
const withTime = (m: Manifest, t: string): Manifest => ({ ...m, generatedAt: t });

describe("set store, app (v2 catalog)", () => {
  it("writes the indexes, then the catalog; reads them back joined; unchanged → nothing written", () => {
    const { fs, files, log } = memFs();
    const store = readSetManifest(fs, "/d/packs", "app", hash);
    expect(store.manifest.packs).toEqual([]);
    const r = writeSetManifest(fs, store, withTime(synth.manifest, "2026-01-01T00:00:00Z"), { hash });
    expect(r.written).toBe(true);
    // Indexes first, the catalog last: a reader never sees a catalog whose index is missing.
    expect(log.at(-1)).toBe("write /d/packs/manifest.json");
    expect(log.filter((l) => /index-[0-9a-f]{16}\.json$/.test(l))).toHaveLength(2);
    const back = readSetManifest(fs, "/d/packs", "app", hash);
    expect(canon({ ...back.manifest, generatedAt: undefined })).toBe(canon({ ...synth.manifest, generatedAt: undefined }));
    log.length = 0;
    const again = writeSetManifest(fs, back, withTime(synth.manifest, "2026-02-02T00:00:00Z"), { hash });
    expect(again.written).toBe(false);
    expect(log).toEqual([]);
    expect(files.size).toBe(3);
  });

  it("rewrites only the changed pack's index and deletes the stale one: one index per pack", () => {
    const { fs, files, log } = memFs();
    let store = writeSetManifest(fs, readSetManifest(fs, "/d/packs", "app", hash), synth.manifest, { hash }).store;
    const [a, b] = synth.manifest.packs;
    const grown: Manifest = { ...synth.manifest, packs: [a, { ...b, files: b.files.slice(0, 2) }] };
    log.length = 0;
    store = writeSetManifest(fs, store, grown, { hash }).store;
    const writes = log.filter((l) => l.startsWith("write"));
    expect(writes).toHaveLength(2); // b's new index, the catalog
    expect(writes[0]).toContain(`/d/packs/${b.id}/v1/index-`);
    expect(log.filter((l) => l.startsWith("remove"))).toHaveLength(1);
    for (const id of [a.id, b.id]) expect([...files.keys()].filter((k) => k.startsWith(`/d/packs/${id}/`) && k.includes("/index-"))).toHaveLength(1);
    expect(store.catalog?.packs[1].flops).toBe(2);
  });

  it("writes the spot tags and the planned packs into the catalog", () => {
    const { fs } = memFs();
    const spot = { chart: "solver", stage: "35bb-2", stack: 35, pot: "3bp", raiser: "BB", caller: "BTN" } as const;
    const r = writeSetManifest(fs, readSetManifest(fs, "/d", "app", hash), synth.manifest, { hash, spot: (id) => (id === "srp-btn-bb-100" ? spot : undefined), planned: [{ id: "sv-x", title: "x", pot: 1, stack: 2 }] });
    expect(r.store.catalog?.packs[0].spot).toEqual(spot);
    expect(r.store.catalog?.planned).toEqual([{ id: "sv-x", title: "x", pot: 1, stack: 2 }]);
    // A changed spot alone is a catalog change.
    expect(writeSetManifest(fs, r.store, synth.manifest, { hash }).written).toBe(true);
  });

  it("refuses a catalog whose index is missing or differs from its hash", () => {
    const { fs, files } = memFs();
    const r = writeSetManifest(fs, readSetManifest(fs, "/d", "app", hash), synth.manifest, { hash });
    const ix = `/d/${r.store.catalog!.packs[0].index.path}`;
    files.set(ix, files.get(ix)!.replace('"v":2', '"v":2 '));
    expect(() => readSetManifest(fs, "/d", "app", hash)).toThrow("sha256 or size");
    files.delete(ix);
    expect(() => readSetManifest(fs, "/d", "app", hash)).toThrow("missing");
  });

  it("lists a version's published boards whether or not their files are on disk", () => {
    const m = synth.manifest;
    const boards = listedBoards(m, m.packs[0].id, 1);
    expect([...boards.keys()]).toEqual(m.packs[0].files.map((f) => f.board));
    expect(listedBoards(m, m.packs[0].id, 2).size).toBe(0);
    expect(listedBoards(m, "nope", 1).size).toBe(0);
  });

  it("reads a v1 manifest left in the app directory and writes a catalog next time", () => {
    const { fs, files } = memFs({ "/d/manifest.json": JSON.stringify(synth.manifest) });
    const st = readSetManifest(fs, "/d", "app", hash);
    expect(st.catalog).toBeNull();
    expect(st.manifest).toEqual(synth.manifest);
    expect(writeSetManifest(fs, st, synth.manifest, { hash }).written).toBe(true);
    expect(JSON.parse(files.get("/d/manifest.json")!).v).toBe(2);
  });
});

describe("set store, calibration (v1, unchanged)", () => {
  it("writes exactly JSON.stringify(manifest), as the presolve job always did", () => {
    const { fs, files, log } = memFs();
    const m = withTime(synth.manifest, "2026-03-03T00:00:00Z");
    const r = writeSetManifest(fs, readSetManifest(fs, "/c", "calibration", hash), m, { hash, planned: [{ id: "x", title: "x", pot: 1, stack: 1 }] });
    expect(r.written).toBe(true);
    expect(log).toEqual(["write /c/manifest.json"]);
    expect(files.get("/c/manifest.json")).toBe(JSON.stringify(m));
    // Unchanged apart from generatedAt → not rewritten.
    expect(writeSetManifest(fs, r.store, withTime(m, "2027-01-01T00:00:00Z"), { hash }).written).toBe(false);
    expect(readSetManifest(fs, "/c", "calibration", hash).manifest).toEqual(m);
  });

  it("refuses a v2 catalog in the calibration directory", () => {
    const { fs } = memFs({ "/c/manifest.json": JSON.stringify({ v: 2, packs: [] }) });
    expect(() => readSetManifest(fs, "/c", "calibration", hash)).toThrow("not a calibration manifest format");
  });
});
