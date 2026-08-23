import { defineConfig } from "vite";

// Nothing clever. The point of the SPA half is only that Vercel detects the
// Vite preset and still builds the `api/` directory alongside it — the
// combination the plan rests on and the docs never show together.
export default defineConfig({ build: { outDir: "dist" } });
