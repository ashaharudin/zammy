import { useState } from "react";
import { MONO } from "./theme.js";
import { TrendingCloud } from "./TrendingCloud.js";

/**
 * The empty state: the command-bar prompt scaled up and centered, with the
 * day's wordcloud beneath it (ARCHITECTURE 10) — the landing page is never
 * blank, and the cloud gives users something to click before they know what
 * to type (§9.3 cold start).
 */
export function Hero({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = useState("");

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "2.5rem",
        padding: "3rem 1rem",
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (q.trim()) onSearch(q.trim());
        }}
        style={{
          width: "100%",
          maxWidth: "640px",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <h1 style={{ fontFamily: MONO, fontSize: "1.6rem", margin: 0, whiteSpace: "nowrap" }}>
          zammy&gt;
        </h1>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            autoFocus
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="e.g. ai regulation, wildfires, interest rates…"
            aria-label="Search topics"
            style={{
              width: "100%",
              padding: "0.9rem 3.25rem 0.9rem 0.25rem",
              fontSize: "1.1rem",
              border: "none",
              borderBottom: "1px solid var(--fg)",
              borderRadius: 0,
              background: "transparent",
              outline: "none",
            }}
          />
          <button
            type="submit"
            aria-label="Search"
            style={{
              position: "absolute",
              right: "0.5rem",
              top: "50%",
              transform: "translateY(-50%)",
              width: "2.4rem",
              height: "2.4rem",
              borderRadius: "50%",
              border: "none",
              background: "var(--fg)",
              color: "var(--bg)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="2" />
              <line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </form>
      <TrendingCloud onSearch={onSearch} />
    </main>
  );
}
