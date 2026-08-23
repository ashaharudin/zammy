// The one thing the SPA needs to prove: a RELATIVE fetch to /api/... reaches
// the function on the same origin, with no CORS and no build-time base URL —
// which is the property VERCEL-ALL-IN-SCOPE §1.1 picks the one-project layout
// for (apps/web/src/api.ts fetches relative today).
// An async IIFE, not top-level await: Vite's default build target is the
// browserslist baseline (chrome87 and friends) and rejects top-level await
// outright, so this is a build error rather than a runtime one.
void (async () => {
  const out = document.querySelector("#out")!;
  const paths = ["/api/v1/echo/deep/path?q=1", "/healthz", "/readyz"];
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetch(path);
        return `${path} → ${response.status} ${await response.text()}`;
      } catch (error) {
        return `${path} → FAILED ${String(error)}`;
      }
    }),
  );
  out.textContent = results.join("\n");
})();
