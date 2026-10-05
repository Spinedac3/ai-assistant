import { defineConfig } from "vitest/config";

// Integration tests need the docker-compose services; they only run with INTEGRATION_TESTS=true
const runIntegration = process.env.INTEGRATION_TESTS === "true";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", ...(runIntegration ? [] : ["tests/integration/**"])],
    environment: "node",
    testTimeout: runIntegration ? 30_000 : 5_000,
  },
});
