import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first PGlite (PostgreSQL-in-WebAssembly) instance in each worker takes a
    // few seconds to compile; later instances are fast. 30s leaves ample headroom
    // when test files start in parallel on a slower machine or CI runner.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
