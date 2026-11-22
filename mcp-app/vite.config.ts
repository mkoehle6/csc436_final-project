import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Builds the MCP App into ONE self-contained HTML file (dist/quiz.html): MCP
 * hosts load it as a single `ui://` resource in a sandboxed iframe whose default
 * CSP allows no network access, so scripts and styles must be inlined.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: "quiz.html" },
  },
});
