import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const api = process.env.API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client", "zustand"],
          charts: ["lightweight-charts"],
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
