import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "My GTO — 홀덤 GTO 학습",
        short_name: "My GTO",
        description: "프리플랍 차트, 퀴즈, AI 코치로 홀덤 GTO 공부하기",
        lang: "ko",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#0f1419",
        theme_color: "#0f1419",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
});
