/**
 * Reading and writing each set's manifest (scripts/presolve.mjs, scripts/packs-*.mjs). The calibration packs keep the v1
 * manifest exactly as it was always written (`JSON.stringify(manifest)` in calibration/packs/manifest.json). The app's
 * packs, on the data branch, are a v2 catalog plus one content-addressed index per pack (format.ts "catalog v2"); in
 * memory both are the same v1-shaped Manifest, so the pipeline's code is the same for both sets.
 *
 * The file system comes in as an adapter, so the rules are tested without touching the disk.
 */
import {
  CATALOG_FORMAT,
  PACK_FORMAT,
  joinCatalog,
  splitManifest,
  utf8Bytes,
  validateCatalog,
  validatePackIndex,
  type Catalog,
  type CatalogPack,
  type Manifest,
  type PackIndex,
  type PlannedPack,
  type SpotTag,
} from "./format";
import type { PackSet } from "./scenarios";
import { SET_FORMAT } from "./sets";

export interface StoreFs {
  exists(path: string): boolean;
  /** UTF-8 text. */
  read(path: string): string;
  /** Writes atomically (temp file + rename), creating directories. */
  write(path: string, text: string): void;
  remove(path: string): void;
  /** Entry names in a directory; [] when it doesn't exist. */
  list(dir: string): string[];
}

/** One set's manifest as read (and as last written by this process). */
export interface SetStore {
  set: PackSet;
  dir: string;
  /** `${dir}/manifest.json`. */
  file: string;
  /** The v1-shaped manifest (joined from the catalog for the app's set). */
  manifest: Manifest;
  /** The app set's catalog as it is on disk; null when there is none yet (or a v1 manifest was found). */
  catalog: Catalog | null;
}

export type Hash = (text: string) => string;

const strip = (p: string) => p.replace(/\/+$/, "");

/**
 * Reads a set's manifest. The app's catalog is checked (validateCatalog) and every index it references must be on disk
 * with the catalog's sha256 and size (validatePackIndex). A missing manifest reads as an empty one; a v1 manifest in the
 * app's directory (a scratch run of an older script) reads as it is and is written as a catalog next time.
 */
export function readSetManifest(fs: StoreFs, dir: string, set: PackSet, hash: Hash): SetStore {
  dir = strip(dir);
  const file = `${dir}/manifest.json`;
  const empty: Manifest = { v: PACK_FORMAT, packs: [] };
  if (!fs.exists(file)) return { set, dir, file, manifest: empty, catalog: null };
  const json = JSON.parse(fs.read(file)) as Manifest | Catalog;
  if (json.v === PACK_FORMAT) return { set, dir, file, manifest: json as Manifest, catalog: null };
  if (json.v !== CATALOG_FORMAT || SET_FORMAT[set] !== CATALOG_FORMAT) throw new Error(`${file}: v${json.v} is not a ${set} manifest format`);
  const catalog = json as Catalog;
  const errs = validateCatalog(catalog);
  if (errs.length) throw new Error(`${file}: ${errs.slice(0, 3).join("; ")}`);
  const manifest = joinCatalog(catalog, (p) => readIndex(fs, dir, p, hash));
  return { set, dir, file, manifest, catalog };
}

/** A pack's index from disk, checked against its catalog entry. */
export function readIndex(fs: StoreFs, dir: string, p: CatalogPack, hash: Hash): PackIndex {
  const path = `${strip(dir)}/${p.index.path}`;
  if (!fs.exists(path)) throw new Error(`${path}: missing (listed in the catalog for ${p.id})`);
  const text = fs.read(path);
  if (hash(text) !== p.index.sha256 || utf8Bytes(text) !== p.index.bytes) throw new Error(`${path}: sha256 or size differs from the catalog's`);
  const idx = JSON.parse(text) as PackIndex;
  const errs = validatePackIndex(idx, p);
  if (errs.length) throw new Error(`${path}: ${errs.slice(0, 3).join("; ")}`);
  return idx;
}

/** JSON with sorted keys, so two manifests compare equal whatever order their fields were written in. */
export function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

const sameApartFromTime = (a: { generatedAt?: string } | null, b: { generatedAt?: string } | null) =>
  a !== null && b !== null && canon({ ...a, generatedAt: undefined }) === canon({ ...b, generatedAt: undefined });

export interface WriteOptions {
  hash: Hash;
  /** App set: the spot tag of a pack by id. */
  spot?: (id: string) => SpotTag | undefined;
  /** App set: the packs the code defines that have no file yet. */
  planned?: PlannedPack[];
}

/**
 * Writes a set's manifest when more than `generatedAt` changed since `store` (what is on disk), and returns the store
 * as it is now. Calibration: `JSON.stringify(m)` to manifest.json, as always. App: the indexes that are new (their name
 * is their content, so an unchanged pack writes nothing), then the catalog (the last write, so a reader never sees a
 * catalog whose index isn't there yet), then every other `index-*.json` of the catalog's packs is deleted.
 */
export function writeSetManifest(fs: StoreFs, store: SetStore, m: Manifest, opts: WriteOptions): { written: boolean; store: SetStore } {
  if (SET_FORMAT[store.set] === PACK_FORMAT) {
    if (sameApartFromTime(m, store.manifest)) return { written: false, store };
    fs.write(store.file, JSON.stringify(m));
    return { written: true, store: { ...store, manifest: m } };
  }
  const { catalog, indexes } = splitManifest(m, { spot: opts.spot, planned: opts.planned }, opts.hash);
  const errs = validateCatalog(catalog);
  if (errs.length) throw new Error(`${store.file}: catalog invalid: ${errs.slice(0, 3).join("; ")}`);
  if (sameApartFromTime(catalog, store.catalog) && indexes.every((ix) => fs.exists(`${store.dir}/${ix.path}`)))
    return { written: false, store };
  for (const ix of indexes) {
    const path = `${store.dir}/${ix.path}`;
    if (fs.exists(path)) {
      if (fs.read(path) !== ix.json) throw new Error(`${path}: exists with other content (sha256 prefix collision?)`);
      continue;
    }
    fs.write(path, ix.json);
  }
  fs.write(store.file, JSON.stringify(catalog));
  const keep = new Set(indexes.map((ix) => ix.path));
  for (const p of catalog.packs) {
    for (const v of fs.list(`${store.dir}/${p.id}`)) {
      if (!/^v\d+$/.test(v)) continue;
      for (const f of fs.list(`${store.dir}/${p.id}/${v}`)) {
        const rel = `${p.id}/${v}/${f}`;
        if (/^index-[0-9a-f]{16}\.json$/.test(f) && !keep.has(rel)) fs.remove(`${store.dir}/${rel}`);
      }
    }
  }
  return { written: true, store: { ...store, manifest: m, catalog } };
}

/** The boards of a pack's version listed in a manifest (the index, on the data branch), whether or not they are on disk. */
export function listedBoards(m: Manifest, id: string, version: number): Map<string, Manifest["packs"][number]["files"][number]> {
  const p = m.packs.find((x) => x.id === id);
  const out = new Map<string, Manifest["packs"][number]["files"][number]>();
  if (!p || p.version !== version) return out;
  for (const f of p.files) out.set(f.board, f);
  return out;
}

/** A Node StoreFs (scripts pass node:fs; kept here so every script writes the same way). */
export function nodeStoreFs(nodeFs: {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, s: string): void;
  renameSync(a: string, b: string): void;
  mkdirSync(p: string, o: { recursive: true }): unknown;
  rmSync(p: string, o?: { force?: boolean }): void;
  readdirSync(p: string): string[];
}, pid: number): StoreFs {
  return {
    exists: (p) => nodeFs.existsSync(p),
    read: (p) => nodeFs.readFileSync(p, "utf8"),
    write: (p, text) => {
      nodeFs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      const tmp = `${p}.tmp-${pid}`;
      nodeFs.writeFileSync(tmp, text);
      nodeFs.renameSync(tmp, p);
    },
    remove: (p) => nodeFs.rmSync(p, { force: true }),
    list: (d) => (nodeFs.existsSync(d) ? nodeFs.readdirSync(d) : []),
  };
}
