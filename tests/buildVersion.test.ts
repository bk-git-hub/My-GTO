import { describe, expect, it } from "vitest";
import { build, loadConfigFromFile } from "vite";

// No @types/node here: reach Node's modules and globals through untyped handles.
const nodeProcess = (globalThis as { process?: { env: Record<string, string | undefined>; cwd(): string } }).process!;
const importNode = <T>(name: string): Promise<T> => import(/* @vite-ignore */ name) as Promise<T>;

async function configVersion(): Promise<unknown> {
  // The native loader imports vite.config.ts with Node (types stripped) instead of bundling it to a temp file in
  // node_modules/.vite-temp: node_modules is shared by every worktree, so a test must not write there.
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, undefined, nodeProcess.cwd(), "silent", undefined, "native");
  return loaded?.config.define;
}

describe("app version", () => {
  it("comes from the app's content only: no commit, no build time", async () => {
    const before = nodeProcess.env.VERCEL_GIT_COMMIT_SHA;
    try {
      nodeProcess.env.VERCEL_GIT_COMMIT_SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const a = (await configVersion()) as Record<string, string>;
      nodeProcess.env.VERCEL_GIT_COMMIT_SHA = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const b = (await configVersion()) as Record<string, string>;
      expect(a.__APP_VERSION__).toMatch(/^"[0-9a-f]{7}"$/);
      expect(b.__APP_VERSION__).toBe(a.__APP_VERSION__);
      expect(Object.keys(a)).toEqual(["__APP_VERSION__"]);
    } finally {
      if (before === undefined) delete nodeProcess.env.VERCEL_GIT_COMMIT_SHA;
      else nodeProcess.env.VERCEL_GIT_COMMIT_SHA = before;
    }
  });
});

describe("the solver packs' data pointer", () => {
  it("is not part of the version: the presolve job rewrites public/packs/data.json every run", async () => {
    const fs = await importNode<{ readFileSync(path: string, enc: "utf8"): string }>("node:fs");
    const src = fs.readFileSync(`${nodeProcess.cwd()}/vite.config.ts`, "utf8");
    const m = /const VERSION_SKIP = (\/.*\/);/.exec(src);
    expect(m).not.toBeNull();
    const skip = new Function(`return ${m![1]}`)() as RegExp;
    expect(skip.test("public/packs/data.json")).toBe(true);
    expect(skip.test("public/packs/manifest.json")).toBe(true);
    expect(skip.test("public/icons/icon.svg")).toBe(false);
    expect(skip.test("src/features/solver/packs.ts")).toBe(false);
  });
});

// Two full builds (about 10 s): BUILD_REPRO=1 npx vitest run tests/buildVersion.test.ts
describe.skipIf(!nodeProcess.env.BUILD_REPRO)("rebuilding the same sources", () => {
  it("gives a byte-identical service worker and assets, so installed apps see no update", async () => {
    const fs = await importNode<{
      mkdtempSync(prefix: string): string;
      readdirSync(path: string, options: { recursive: true }): string[];
      readFileSync(path: string): Uint8Array;
      statSync(path: string): { isFile(): boolean };
      rmSync(path: string, options: { recursive: true; force: true }): void;
    }>("node:fs");
    const os = await importNode<{ tmpdir(): string }>("node:os");
    const dirs = [fs.mkdtempSync(`${os.tmpdir()}/pubaj-a-`), fs.mkdtempSync(`${os.tmpdir()}/pubaj-b-`)];
    try {
      for (const outDir of dirs) await build({ logLevel: "silent", build: { outDir, emptyOutDir: true } });
      const files = (dir: string) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(`${dir}/${f}`).isFile()).sort();
      const [a, b] = dirs;
      expect(files(b)).toEqual(files(a));
      expect(files(a)).toContain("sw.js");
      const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);
      for (const f of files(a)) expect(same(fs.readFileSync(`${a}/${f}`), fs.readFileSync(`${b}/${f}`)), f).toBe(true);
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 120_000);
});
