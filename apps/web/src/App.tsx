import { useEffect, useState } from "react";

/**
 * Phase 0 placeholder. Its only job is to prove the wiring: browser → Vite proxy
 * → API → Postgres/Redis. The timeline and wordcloud land in Phase 4 / 5b.
 */
type Readiness =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; status: string; checks: Record<string, { ok: boolean; error?: string }> };

export function App() {
  const [readiness, setReadiness] = useState<Readiness>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/readyz", { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          status: string;
          checks: Record<string, { ok: boolean; error?: string }>;
        };
        setReadiness({ state: "ok", status: body.status, checks: body.checks });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setReadiness({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "720px",
        margin: "4rem auto",
        padding: "0 1.5rem",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ marginBottom: "0.25rem" }}>Zammy</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        News aggregator — Phase 0 scaffold.
      </p>

      <h2 style={{ fontSize: "1rem", marginTop: "2rem" }}>API readiness</h2>
      {readiness.state === "loading" && <p>Checking…</p>}
      {readiness.state === "error" && (
        <p style={{ color: "#b00" }}>
          Could not reach the API: {readiness.message}
          <br />
          <small>Is it running? `pnpm dev` in another terminal.</small>
        </p>
      )}
      {readiness.state === "ok" && (
        <ul>
          <li>
            <strong>status:</strong> {readiness.status}
          </li>
          {Object.entries(readiness.checks).map(([name, check]) => (
            <li key={name}>
              <strong>{name}:</strong> {check.ok ? "ok" : `failed — ${check.error ?? "unknown"}`}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
