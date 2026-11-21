import { beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticPacks, type SyntheticPacks } from "../../tests/fixtures/solverPack";
import {
  CATALOG_FORMAT,
  cdnUrls,
  indexFilePath,
  isSafeRelPath,
  joinCatalog,
  splitManifest,
  utf8Bytes,
  validateCatalog,
  validatePackIndex,
  validatePointer,
  type DataPointer,
  type PackIndex,
} from "./format";

// No @types/node here: reach node:crypto through an untyped handle.
const crypto = (await import(/* @vite-ignore */ "node:crypto" as string)) as { createHash(a: string): { update(s: string): { digest(e: "hex"): string } } };
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

let synth: SyntheticPacks;
beforeAll(async () => {
  synth = await buildSyntheticPacks();
});

describe("catalog v2", () => {
  it("splits a v1 manifest into a catalog and content-addressed indexes, and joins back to it", () => {
    const spot = { chart: "solver", stage: "55bb-2.2", stack: 55, pot: "srp", raiser: "BTN", caller: "BB" } as const;
    const { catalog, indexes } = splitManifest(synth.manifest, { spot: (id) => (id === "pub-srp-btn-bb-40" ? spot : undefined), planned: [{ id: "sv-srp-hj-bb-55", title: "HJ", pot: 5.9, stack: 51.8 }] }, sha256);
    expect(catalog.v).toBe(CATALOG_FORMAT);
    expect(validateCatalog(catalog)).toEqual([]);
    expect(indexes).toHaveLength(synth.manifest.packs.length);
    catalog.packs.forEach((p, i) => {
      const src = synth.manifest.packs[i];
      const ix = indexes[i];
      expect(p.index.path).toBe(indexFilePath(src.id, src.version, sha256(ix.json)));
      expect(p.index.path).toMatch(new RegExp(`^${src.id}/v1/index-[0-9a-f]{16}\\.json$`));
      expect(p.index.sha256).toBe(sha256(ix.json));
      expect(p.index.bytes).toBe(utf8Bytes(ix.json));
      expect(p.flops).toBe(src.files.length);
      expect(p.weight).toBe(src.files.reduce((s, f) => s + f.weight, 0));
      expect("files" in p).toBe(false);
      expect(validatePackIndex(JSON.parse(ix.json) as PackIndex, p)).toEqual([]);
    });
    expect(catalog.packs[1].spot).toEqual(spot);
    expect(catalog.packs[0].spot).toBeUndefined();
    expect(catalog.planned?.[0].id).toBe("sv-srp-hj-bb-55");
    const byPath = new Map(indexes.map((ix) => [ix.path, JSON.parse(ix.json) as PackIndex]));
    const joined = joinCatalog(catalog, (p) => byPath.get(p.index.path)!);
    // Byte-identical to the v1 manifest apart from generatedAt (and here generatedAt is carried over too).
    expect(JSON.stringify(joined)).toBe(JSON.stringify(synth.manifest));
    // The same input gives the same names: an unchanged pack keeps its index.
    expect(splitManifest(synth.manifest, {}, sha256).indexes.map((ix) => ix.path)).toEqual(indexes.map((ix) => ix.path));
  });

  it("validates catalogs", () => {
    const { catalog } = splitManifest(synth.manifest, {}, sha256);
    expect(validateCatalog({ ...catalog, v: 1 } as never)).toEqual(["v must be 2"]);
    const dup = { ...catalog, packs: [catalog.packs[0], catalog.packs[0]] };
    expect(validateCatalog(dup).some((e) => e.includes("duplicate"))).toBe(true);
    const wrongIndex = { ...catalog, packs: [{ ...catalog.packs[0], index: { ...catalog.packs[0].index, path: "other/v1/index-0000000000000000.json" } }] };
    expect(validateCatalog(wrongIndex).some((e) => e.includes("index path"))).toBe(true);
    const unsafe = { ...catalog, packs: [{ ...catalog.packs[0], index: { ...catalog.packs[0].index, path: "../x.json" } }] };
    expect(validateCatalog(unsafe).some((e) => e.includes("invalid path"))).toBe(true);
    const plannedTwice = { ...catalog, planned: [{ id: catalog.packs[0].id, title: "x", pot: 1, stack: 1 }] };
    expect(validateCatalog(plannedTwice).some((e) => e.includes("also in packs"))).toBe(true);
  });

  it("validates an index against its catalog entry", () => {
    const { catalog, indexes } = splitManifest(synth.manifest, {}, sha256);
    const p = catalog.packs[0];
    const idx = JSON.parse(indexes[0].json) as PackIndex;
    expect(validatePackIndex({ ...idx, files: idx.files.slice(1) }, p).some((e) => e.includes("catalog says"))).toBe(true);
    const outside = { ...idx, files: idx.files.map((f, i) => (i ? f : { ...f, path: `other-pack/v1/flop-${f.board}.json` })) };
    expect(validatePackIndex(outside, p).some((e) => e.includes("path must be"))).toBe(true);
    const badSha = { ...idx, files: idx.files.map((f, i) => (i ? f : { ...f, sha256: "XYZ" })) };
    expect(validatePackIndex(badSha, p).some((e) => e.includes("sha256"))).toBe(true);
    expect(validatePackIndex({ ...idx, version: 2 }, p).some((e) => e.includes("v2"))).toBe(true);
  });

  it("validates data pointers: a full 40-hex commit, a plain repo and directory, a safe catalog path", () => {
    const good: DataPointer = { v: 2, repo: "bk-git-hub/My-GTO", commit: "a".repeat(40), dir: "packs/", catalog: { path: "manifest.json", sha256: "b".repeat(64), bytes: 10 } };
    expect(validatePointer(good)).toEqual([]);
    expect(validatePointer({ ...good, commit: "aaaaaaa" })).toEqual(["commit must be a full 40-hex SHA"]);
    expect(validatePointer({ ...good, commit: "A".repeat(40) })).toHaveLength(1);
    expect(validatePointer({ ...good, repo: "../x" })).toHaveLength(1);
    expect(validatePointer({ ...good, dir: "/abs/" })).toHaveLength(1);
    expect(validatePointer({ ...good, catalog: { ...good.catalog, path: "a/../b.json" } })).toHaveLength(1);
    expect(validatePointer({ ...good, v: 1 } as never)).toEqual(["v must be 2"]);
  });

  it("builds the CDN URLs: jsDelivr pinned to the commit first, raw.githubusercontent.com second", () => {
    const p = { repo: "bk-git-hub/My-GTO", commit: "c".repeat(40), dir: "packs/" };
    expect(cdnUrls(p, "srp-btn-bb-100/v1/flop-AsKh7d.json")).toEqual([
      `https://cdn.jsdelivr.net/gh/bk-git-hub/My-GTO@${"c".repeat(40)}/packs/srp-btn-bb-100/v1/flop-AsKh7d.json`,
      `https://raw.githubusercontent.com/bk-git-hub/My-GTO/${"c".repeat(40)}/packs/srp-btn-bb-100/v1/flop-AsKh7d.json`,
    ]);
    expect(() => cdnUrls(p, "../secret")).toThrow("unsafe");
    expect(isSafeRelPath("a/b-c/v1/x.json")).toBe(true);
    expect(isSafeRelPath("/a")).toBe(false);
    expect(isSafeRelPath("a//b")).toBe(false);
    expect(isSafeRelPath(".hidden")).toBe(false);
  });

  it("counts UTF-8 bytes", () => {
    for (const s of ["", "abc", "체크", "벳 33%", "🂡x", JSON.stringify({ label: "레이즈 7.4" })]) expect(utf8Bytes(s)).toBe(new TextEncoder().encode(s).length);
  });
});
