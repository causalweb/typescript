import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["dist/test/*.test.js", "reference/*.test.mjs"],
    testTimeout: 30_000,
  },
});
