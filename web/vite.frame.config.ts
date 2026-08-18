import { defineConfig } from "vite";

/**
 * The mermaid bundle for the sandboxed review-document iframe.
 *
 * This is a second, separate build rather than a second input of the main one,
 * and that is forced by the frame's security model rather than chosen:
 *
 *   - The frame is sandboxed without `allow-same-origin`, so it is an opaque
 *     origin. Module scripts are fetched in CORS mode, so `<script type=module>`
 *     from an opaque origin needs `Access-Control-Allow-Origin` on every chunk.
 *     A classic script is a no-cors request and needs nothing. So the output has
 *     to be one classic IIFE.
 *   - Mermaid lazily `import()`s a chunk per diagram type. A multi-input build
 *     emits those as separate hashed modules and fetches them at runtime, which
 *     the point above rules out. `build.lib` with the iife format inlines them
 *     all into the single file instead. That is why the bundle is large.
 *
 * It lands in `public/assets/` so the dev server serves it at the same path the
 * Go renderer hardcodes, and so the main build copies it into
 * `../internal/webui/dist/assets/mermaid-frame.js` along with the rest of public/.
 */
export default defineConfig({
  // Nothing to copy: this build only produces the bundle, and its output dir
  // lives inside the main build's public dir.
  publicDir: false,
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: "public/assets",
    emptyOutDir: false,
    target: "es2022",
    cssCodeSplit: false,
    sourcemap: false,
    // Reported so a jump in mermaid's size is visible rather than quiet.
    reportCompressedSize: true,
    chunkSizeWarningLimit: 4096,
    lib: {
      entry: "src/frame/mermaid-frame.ts",
      name: "herdrerMermaidFrame",
      formats: ["iife"],
    },
    rollupOptions: {
      output: {
        // Stable and unhashed: internal/review/render.go references this path
        // literally from the nonced bootstrap script.
        entryFileNames: "mermaid-frame.js",
      },
    },
  },
});
