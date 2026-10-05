import { defineConfig } from "vitest/config";

// Integration tests need the docker-compose services; they only run with INTEGRATION_TESTS=true
const runIntegration = process.env.INTEGRATION_TESTS === "true";
// Golden tests also need the real embedding model, too heavy for CI; they run with GOLDEN_TESTS=true
const runGolden = process.env.GOLDEN_TESTS === "true";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      ...(runIntegration ? [] : ["tests/integration/**"]),
      ...(runGolden ? [] : ["tests/golden/**"]),
    ],
    environment: "node",
    testTimeout: runIntegration || runGolden ? 60_000 : 5_000,
  },
});
