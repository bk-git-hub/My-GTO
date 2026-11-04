import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
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
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
});
