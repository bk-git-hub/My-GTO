import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// This file runs in Node, but @types/node is not installed; declare what it uses.
declare const process: { cwd(): string };

interface NodeFs {
  readdirSync(path: string, options: { recursive: true }): string[];
  readFileSync(path: string): Uint8Array;
  statSync(path: string): { isFile(): boolean };
  existsSync(path: string): boolean;
}
interface NodeCrypto {
  createHash(algorithm: string): { update(data: string | Uint8Array): unknown; digest(encoding: "hex"): string };
}

/** The app's own sources: a change anywhere here is a new version. */
const VERSION_INPUTS = ["src", "public", "index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts"];
/** Never part of the version: solver packs (regenerated nightly, not precached) and tests (not shipped). */
const VERSION_SKIP = /^public\/packs\/|\.test\.tsx?$/;

/**
 * Short hash of the app's content. A rebuild of the same sources (a nightly pack-only commit, a
 * redeploy) gives byte-identical assets and service worker, so installed apps see no update.
 * No git: Vercel's clone is shallow, and the commit changes with every pack commit anyway.
 */
async function appVersion(): Promise<string> {
  try {
    // Variable specifiers keep tsc from looking for Node's types.
    const fsName: string = "node:fs";
    const cryptoName: string = "node:crypto";
    const fs = (await import(fsName)) as NodeFs;
    const { createHash } = (await import(cryptoName)) as NodeCrypto;
    const root = process.cwd().replace(/\\/g, "/");
    const files: string[] = [];
    for (const input of VERSION_INPUTS) {
      const full = `${root}/${input}`;
      if (!fs.existsSync(full)) continue;
      if (fs.statSync(full).isFile()) files.push(input);
      else for (const f of fs.readdirSync(full, { recursive: true })) files.push(`${input}/${f.replace(/\\/g, "/")}`);
    }
    const hash = createHash("sha256");
    for (const f of files.filter((f) => !VERSION_SKIP.test(f)).sort()) {
      const full = `${root}/${f}`;
      if (!fs.statSync(full).isFile()) continue;
      hash.update(`${f}\0`);
      hash.update(fs.readFileSync(full));
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 7);
  } catch {
    return "dev";
  }
}

/**
 * A small script the generated service worker loads with importScripts.
 *
 * Builds before the explicit update flow (src/pwa/update.ts) used "autoUpdate": their pages never
 * ask a waiting worker to take over, they only reload once a new worker activates. So the first
 * worker that finds no marker takes over by itself (those old pages then reload into the new
 * version) and leaves the marker, so every later worker waits until the page applies it. On a
 * first install there is nothing to wait for anyway.
 */
const SW_MIGRATE_FILE = "sw-migrate.js";
const SW_MIGRATE_SOURCE = `(() => {
  const MARK = "pubaj-update-flow-v1";
  self.addEventListener("install", (event) => {
    event.waitUntil(
      caches.has(MARK).then((marked) => (marked ? undefined : self.skipWaiting())).catch(() => undefined),
    );
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(caches.open(MARK).then(() => undefined, () => undefined));
  });
})();
`;

function swMigrate(): Plugin {
  return {
    name: "pubaj-sw-migrate",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: SW_MIGRATE_FILE, source: SW_MIGRATE_SOURCE });
    },
  };
}

export default defineConfig(async () => ({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(await appVersion()),
  },
  plugins: [
    react(),
    swMigrate(),
    VitePWA({
      // New workers wait until src/pwa/update.ts applies them, so a running page keeps one
      // consistent set of assets (no lazy-chunk 404s after a deploy).
      registerType: "prompt",
      includeAssets: ["icons/icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "PubAJ 펍아재 — 펍아재 잡는 홀덤 공부",
        short_name: "PubAJ",
        description: "펍아재 잡는 홀덤 공부: 프리플랍 차트, 퀴즈, 핸드 플레이, AI 코치",
        lang: "ko",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#0f1419",
        theme_color: "#0f1419",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // No json: solver packs (public/packs, regenerated nightly) are never precached.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // iOS launch images (public/splash) are read once, when the app is added to the Home Screen.
        globIgnores: ["**/node_modules/**/*", "splash/**"],
        // Navigations to the API or to pack files go to the network, not the app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/packs\//],
        // The first install controls the open page right away (same build, nothing to mix up).
        clientsClaim: true,
        importScripts: [SW_MIGRATE_FILE],
      },
    }),
  ],
}));
