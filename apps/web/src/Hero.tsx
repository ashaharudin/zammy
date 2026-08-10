import { useState } from "react";
import { MONO } from "./theme.js";

/**
 * The empty state: the command-bar prompt scaled up and centered. Searching
 * "docks" this same prompt to the top of the timeline (CommandBar), which is
 * the continuity the prototype verdict picked. Filters deliberately absent
 * here — they appear once a topic is open.
 */
export function Hero({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = useState("");

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 1rem",
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
              padding: "0.9rem 3.25rem 0.9rem 1.25rem",
              fontSize: "1.1rem",
              borderRadius: "999px",
              border: "none",
              background: "var(--surface)",
              boxShadow: "var(--shadow)",
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
    </main>
  );
}
