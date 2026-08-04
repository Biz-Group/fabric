import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // `src` is included so frontend logic that is not a component — derivations,
    // status rules — can be tested at all. The edge-runtime environment suits
    // pure modules; a component test would need its own environment.
    include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
  },
});
