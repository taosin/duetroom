import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
  },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "dist/web",
    rollupOptions: {
      onwarn(warning, warn) {
        // This app renders entirely in the browser; dependencies also support RSC.
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes('"use client"')
        )
          return;
        warn(warning);
      },
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
