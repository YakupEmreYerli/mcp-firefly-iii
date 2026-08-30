import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The suite never reaches the network, and creating a server now starts an
    // update check. test/update.test.ts drives that module directly, with its
    // own fetch and its own environment, so nothing here has to be reachable.
    env: { MCP_UPDATE_CHECK: "false" },
  },
});
