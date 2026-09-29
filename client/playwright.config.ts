import { defineConfig } from "@playwright/test";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SERVER_PORT = 8790;
const CLIENT_PORT = 5190;

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    viewport: { width: 1600, height: 900 },
  },
  webServer: [
    {
      command: "npm run dev",
      cwd: path.join(root, "server"),
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(SERVER_PORT),
        PROVIDERS: process.env.PROVIDERS ?? "mock",
        STREAM_INTERVAL_MS: "1000",
        CACHE_DB: ":memory:",
        AI_PROVIDER: process.env.AI_PROVIDER ?? "mock",
        PLUGINS: process.env.PLUGINS ?? "./plugins/edgar",
      },
    },
    {
      command: "npm run dev",
      cwd: path.join(root, "client"),
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: false,
      env: {
        CLIENT_PORT: String(CLIENT_PORT),
        API_URL: `http://localhost:${SERVER_PORT}`,
      },
    },
  ],
});
