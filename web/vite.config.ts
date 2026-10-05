import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The server serves the build under /panel; in development the API is the local server
const API = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  base: "/panel/",
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      ["/auth", "/chat", "/docs", "/admin", "/exports"].map((path) => [path, API]),
    ),
  },
  // The component library alone is most of the bundle; an internal panel loads it once
  // Nothing inlined as data: URLs, so the panel's strict CSP holds for every font and image
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900, assetsInlineLimit: 0 },
});
