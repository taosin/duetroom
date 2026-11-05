import { defineConfig } from "vitest/config";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist/web" },
  test: { include: ["test/**/*.test.ts"] },
});
