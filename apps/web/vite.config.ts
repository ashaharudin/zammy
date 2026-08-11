import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API base URL is the one thing that genuinely differs between local dev and
// production (ARCHITECTURE 4.1): a dev-server proxy here, an absolute CloudFront
// origin in AWS. Configured, never defaulted.
export default defineConfig({
  plugins: [react()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_ORIGIN ?? "http://localhost:3000", changeOrigin: true },
      "/healthz": { target: process.env.VITE_API_ORIGIN ?? "http://localhost:3000", changeOrigin: true },
      "/readyz": { target: process.env.VITE_API_ORIGIN ?? "http://localhost:3000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
