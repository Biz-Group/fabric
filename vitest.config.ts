import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // `src` is included so frontend logic that is not a component — derivations,
    // status rules — can be tested at all. The edge-runtime environment suits
    // pure modules; a component test would need its own environment.
    include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
    // The default 5s is per test, not per file, and the convex-test suites run a
    // simulated database with fake timers while sibling workers transform heavy
    // dependencies (@react-pdf/renderer for the report tests). Those tests
    // finish in well under a second in isolation but were landing at 5.0-5.1s
    // under full-suite contention, failing on machine load rather than on
    // behavior. Raised so a failure means a real hang.
    testTimeout: 20_000,
  },
});
