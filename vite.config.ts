import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  // Let TS files import WGSL as raw strings
  assetsInclude: ["**/*.wgsl"],
});
