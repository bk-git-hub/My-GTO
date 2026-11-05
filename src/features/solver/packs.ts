/**
 * Loading solver content packs (docs/solver-packs.md): `${BASE_URL}packs/manifest.json` and the flop files it lists.
 * Loads are cached in memory for the session. Each flop file's sha256 is checked with WebCrypto in the background;
 * a mismatch only logs a warning and flags the file, it never blocks rendering.
 */
import { decodeFlopFile, validateManifest, type DecodedFlop, type FileEntry, type FlopFile, type Manifest } from "../../presolve/format";

export type Integrity = "ok" | "mismatch" | "unavailable";

export type ManifestState = { status: "ready"; manifest: Manifest; problems: string[] } | { status: "empty" };

export interface LoadedFlop {
  entry: FileEntry;
  file: FlopFile;
  flop: DecodedFlop;
  /** Downloaded size in bytes. */
  bytes: number;
  /** Resolves when the sha256 check is done; never rejects. */
  integrity: Promise<Integrity>;
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

/**
 * The packs directory URL. In dev builds `?packs=packs-<name>` switches to another directory under public/
 * (e.g. a synthetic pack in public/packs-dev/) so local testing never touches real packs.
 */
export function packsBase(
  baseUrl: string = import.meta.env.BASE_URL,
  dev: boolean = import.meta.env.DEV,
  search: string = typeof location !== "undefined" ? location.search : "",
): string {
  let dir = "packs";
  if (dev) {
    const q = new URLSearchParams(search).get("packs");
    if (q && /^packs-[a-z0-9-]+$/.test(q)) dir = q;
  }
  return `${baseUrl}${dir}/`;
}

/** Lowercase hex sha256, or null when WebCrypto isn't available (e.g. plain http on a LAN address). */
export async function sha256Hex(data: ArrayBuffer, subtle: SubtleCrypto | null | undefined): Promise<string | null> {
  if (!subtle) return null;
  try {
    const d = new Uint8Array(await subtle.digest("SHA-256", data));
    let s = "";
    for (const b of d) s += b.toString(16).padStart(2, "0");
    return s;
  } catch {
    return null;
  }
}

export interface PackClientOptions {
  /** Directory URL ending in "/", e.g. packsBase(). */
  base: string;
  fetch?: typeof fetch;
  subtle?: SubtleCrypto | null;
  warn?: (msg: string) => void;
}

export interface PackClient {
  readonly base: string;
  manifest(): Promise<ManifestState>;
  flop(entry: FileEntry): Promise<LoadedFlop>;
  /** Forget everything cached, so the next call fetches again (retry after an error). */
  reset(): void;
}

/** A static host with an SPA fallback answers a missing JSON file with index.html. */
const looksLikeHtml = (text: string) => /^\s*</.test(text);

export function createPackClient(opts: PackClientOptions): PackClient {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const subtle = opts.subtle === undefined ? (globalThis.crypto?.subtle ?? null) : opts.subtle;
  const warn = opts.warn ?? ((msg: string) => console.warn(`[packs] ${msg}`));
  let manifestP: Promise<ManifestState> | null = null;
  const flops = new Map<string, Promise<LoadedFlop>>();

  async function loadManifest(): Promise<ManifestState> {
    let res: Response;
    try {
      res = await doFetch(`${opts.base}manifest.json`, { cache: "no-cache" });
    } catch {
      throw new PackError("팩 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) throw new PackError(`팩 목록을 불러오지 못했어요 (HTTP ${res.status}).`);
    const text = await res.text();
    if (looksLikeHtml(text)) return { status: "empty" };
    let m: Manifest;
    try {
      m = JSON.parse(text) as Manifest;
    } catch {
      throw new PackError("팩 목록 형식이 올바르지 않아요.");
    }
    if (!m || m.v !== 1 || !Array.isArray(m.packs)) throw new PackError("지원하지 않는 팩 목록 버전이에요.");
    const packs = m.packs.filter((p) => p && Array.isArray(p.files) && Array.isArray(p.summaryNodes) && p.scenario);
    if (!packs.some((p) => p.files.length > 0)) return { status: "empty" };
    const manifest = { ...m, packs };
    const problems = validateManifest(manifest);
    if (problems.length) warn(`manifest has ${problems.length} problem(s): ${problems.slice(0, 3).join("; ")}`);
    return { status: "ready", manifest, problems };
  }

  async function loadFlop(entry: FileEntry): Promise<LoadedFlop> {
    let res: Response;
    try {
      res = await doFetch(`${opts.base}${entry.path}`);
    } catch {
      throw new PackError("플랍 파일을 받지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    if (res.status === 404) throw new PackError("이 플랍 파일이 서버에 없어요.");
    if (!res.ok) throw new PackError(`플랍 파일을 받지 못했어요 (HTTP ${res.status}).`);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    if (looksLikeHtml(text)) throw new PackError("이 플랍 파일이 서버에 없어요.");
    let file: FlopFile;
    let flop: DecodedFlop;
    try {
      file = JSON.parse(text) as FlopFile;
      flop = decodeFlopFile(file);
    } catch (e) {
      throw new PackError(`플랍 파일을 읽지 못했어요: ${(e as Error).message}`);
    }
    if (buf.byteLength !== entry.bytes) warn(`${entry.path}: ${buf.byteLength} bytes, manifest says ${entry.bytes}`);
    if (file.board !== entry.board) warn(`${entry.path}: board ${file.board}, manifest says ${entry.board}`);
    const integrity = sha256Hex(buf, subtle).then((hex): Integrity => {
      if (hex === null) return "unavailable";
      if (hex === entry.sha256) return "ok";
      warn(`${entry.path}: sha256 ${hex} does not match the manifest (${entry.sha256})`);
      return "mismatch";
    });
    return { entry, file, flop, bytes: buf.byteLength, integrity };
  }

  return {
    base: opts.base,
    manifest() {
      if (!manifestP) {
        const p = loadManifest();
        manifestP = p;
        p.catch(() => {
          if (manifestP === p) manifestP = null;
        });
      }
      return manifestP;
    },
    flop(entry) {
      const key = entry.path;
      let p = flops.get(key);
      if (!p) {
        const q = loadFlop(entry);
        p = q;
        flops.set(key, q);
        q.catch(() => {
          if (flops.get(key) === q) flops.delete(key);
        });
      }
      return p;
    },
    reset() {
      manifestP = null;
      flops.clear();
    },
  };
}

let defaultClient: PackClient | null = null;

/** The app-wide client for packsBase(). */
export function packClient(): PackClient {
  return (defaultClient ??= createPackClient({ base: packsBase() }));
}
