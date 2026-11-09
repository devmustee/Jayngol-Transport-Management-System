import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { BASE_URL } from "./e2e/config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 4,
  timeout: 45_000,
  reporter: [["dot"], ["./e2e/reporter.ts"]],
  use: { baseURL: BASE_URL },
  webServer: {
    command: "npm run audit:serve",
    url: `${BASE_URL}/login`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
