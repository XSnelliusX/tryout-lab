import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dashboard is opened straight from disk (file://), so the build must not
// need a web server:
//   - base "./" keeps every asset URL relative;
//   - the bundle is a single classic (IIFE) script (CSS is injected by it), because Chrome blocks
//     <script type="module"> loaded from file:// (CORS), and `crossorigin`
//     attributes break file:// requests too;
//   - data/models.js (written by compare.mjs / aasync) is a classic script that
//     sets window.__MODEL_COMPARISON__, loaded before the app bundle.
// `vite dev` has no data/models.js; useSnapshot falls back to fetch there.
function classicScripts() {
  return {
    name: "classic-scripts-for-file-protocol",
    apply: "build" as const,
    transformIndexHtml: {
      order: "post" as const,
      handler(html: string) {
        const out = html
          // <script type="module" crossorigin src="./assets/x.js"> -> <script defer src=...>
          .replace(/<script\b([^>]*)>/g, (_m, attrs: string) => {
            const cleaned = attrs
              .replace(/\s+type="module"/g, "")
              .replace(/\s+crossorigin(="[^"]*")?/g, "");
            return /\bsrc=/.test(cleaned) ? `<script defer${cleaned}>` : `<script${cleaned}>`;
          })
          .replace(/<link\b([^>]*)>/g, (_m, attrs: string) => `<link${attrs.replace(/\s+crossorigin(="[^"]*")?/g, "")}>`)
          // modulepreload hints are meaningless for a classic bundle.
          .replace(/\s*<link rel="modulepreload"[^>]*>/g, "");
        // Data first (classic, synchronous); the deferred app bundle runs after it.
        return out.replace("<script", '<script src="./data/models.js"></script>\n    <script');
      },
    },
  };
}

// A plain object avoids the self-referential `vitest/config` type export in
// Vitest 5 while remaining a valid Vite/Vitest configuration.
export default {
  base: "./",
  plugins: [react(), tailwindcss(), classicScripts()],
  build: {
    modulePreload: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        format: "iife" as const,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
};
