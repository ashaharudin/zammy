import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MONO } from "../theme.js";
import { NOTICE_TEXT } from "./pageNotices.js";
import { RECORD_KINDS, recordRequest, type RecordKind, type RecordResult } from "./traceFetch.js";

/**
 * Recording a real request (ADR-0029, "The change", item 8): pick a route, give it its
 * input, paste the trace token, run it, and the page plays back what that request touched.
 *
 * **The token lives in this component's state and nowhere else.** Not in storage, not in the
 * URL, not in the page's state: it is typed into a password field with autocomplete off,
 * handed to `recordRequest` for the length of one `fetch` (where it travels only in the
 * `x-zammy-trace` header), and forgotten when the page is left. The page switches to the new
 * trace with `history.replaceState` and no reload, so this panel stays mounted and the token
 * survives one recording after another in the same visit — and nothing longer.
 *
 * It says where the token comes from (`REQUEST_TRACE_TOKEN` in the API's `.env`) and what a
 * run costs: it is a REAL request, and a search nobody asked for recently spends upstream
 * quota. It is never retried for the same reason (`traceFetch.ts`).
 *
 * Run is never `disabled` while its request is in flight, only `aria-disabled` with its
 * activation ignored: disabling the focused control throws keyboard focus to `<body>`, and a
 * screen-reader user who pressed Run would be left at the top of the page, with the outcome
 * spoken (`pageNotices.ts`) but nowhere to be. The summary keeps its native disclosure
 * triangle — `display: flex` on a `<summary>` removes it, and it is the only way in.
 *
 * Deliberately not here: interpreting the result beyond its own form errors. `invalid` (the
 * input or the token cannot travel) is shown here, next to the field that caused it;
 * everything else is the page's to act on (`onResult`).
 */
export function RecordPanel({ onResult }: { onResult: (result: RecordResult) => void }) {
  const [kind, setKind] = useState<RecordKind>("search");
  const [input, setInput] = useState("");
  const [token, setToken] = useState("");
  const [bypassEdge, setBypassEdge] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A run in flight when the page goes away is abandoned, not left to land on nothing.
  useEffect(() => () => abort.current?.abort(), []);

  const field = INPUTS[kind];

  const run = async () => {
    setError(null);
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await recordRequest(
        { kind, input, token, bypassEdge },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result.kind === "invalid") setError(result.error);
      else onResult(result);
    } catch {
      if (!controller.signal.aborted) {
        setError("The request did not complete: the API could not be reached.");
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  return (
    <details style={{ fontFamily: MONO, fontSize: "0.8rem" }}>
      <summary
        style={{
          cursor: "pointer",
          // A list item still, for its marker; the padding makes the 44 px target.
          display: "list-item",
          padding: "12px 0",
          lineHeight: "20px",
        }}
      >
        Record a real request
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) void run();
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.6rem",
          padding: "0.8rem",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          background: "var(--surface)",
        }}
      >
        <p style={NOTICE_TEXT}>
          This is a real request; a search nobody asked recently spends upstream quota.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
          <label style={LABEL}>
            <span>Request</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as RecordKind);
                setError(null);
              }}
              style={FIELD}
            >
              {RECORD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {INPUTS[k].option}
                </option>
              ))}
            </select>
          </label>
          {field.label !== null && (
            <label style={{ ...LABEL, flex: "2 1 14rem" }}>
              <span>{field.label}</span>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={field.placeholder}
                spellCheck={false}
                autoComplete="off"
                style={FIELD}
              />
            </label>
          )}
        </div>
        <label style={LABEL}>
          <span>
            Trace token — <code>REQUEST_TRACE_TOKEN</code> in the API's <code>.env</code>
          </span>
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            spellCheck={false}
            style={FIELD}
          />
        </label>
        {kind === "trending" && (
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", minHeight: "44px" }}
          >
            <input
              type="checkbox"
              checked={bypassEdge}
              onChange={(event) => setBypassEdge(event.target.checked)}
              style={{ width: "1.1rem", height: "1.1rem" }}
            />
            Skip the edge cache
          </label>
        )}
        <p style={{ margin: 0, color: "var(--fg-muted)", lineHeight: 1.5 }}>
          The token stays in this form for this visit: it is never stored or put in a link.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem" }}>
          <button
            type="submit"
            // Not `disabled`: see the header. The form's submit handler ignores it meanwhile.
            aria-disabled={running}
            style={{
              minHeight: "44px",
              padding: "0 1rem",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              background: "var(--fg)",
              color: "var(--bg)",
              cursor: running ? "progress" : "pointer",
              fontFamily: MONO,
              fontSize: "0.8rem",
            }}
          >
            {running ? "Running…" : "Run"}
          </button>
          {error && (
            <p role="alert" style={NOTICE_TEXT}>
              {error}
            </p>
          )}
        </div>
      </form>
    </details>
  );
}

/** What each kind of run asks for: its option text, and its input's label and placeholder. */
const INPUTS: Readonly<
  Record<RecordKind, { option: string; label: string | null; placeholder: string }>
> = {
  search: {
    option: "Search (GET /api/v1/timeline?q=)",
    label: "Keywords",
    placeholder: "climate policy",
  },
  view: {
    option: "Storyline view (GET /api/v1/timeline?storyline=)",
    label: "Storyline ids, comma-separated",
    placeholder: "1b671a64-40d5-491e-99b0-da01ff1f3341",
  },
  storylines: {
    option: "Storyline search (GET /api/v1/storylines?q=)",
    label: "Keywords",
    placeholder: "floods",
  },
  open: {
    option: "Open a storyline (POST …/storylines/:id/refresh)",
    label: "Storyline id",
    placeholder: "1b671a64-40d5-491e-99b0-da01ff1f3341",
  },
  trending: { option: "Trending (GET /api/v1/trending)", label: "Language", placeholder: "en" },
  reference: { option: "Reference (GET /api/v1/reference)", label: null, placeholder: "" },
};

const LABEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  flex: "1 1 12rem",
  minWidth: 0,
  color: "var(--fg-muted)",
};

const FIELD: CSSProperties = {
  width: "100%",
  minHeight: "44px",
  minWidth: 0,
  padding: "0 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--bg)",
  color: "var(--fg)",
  fontFamily: MONO,
  fontSize: "0.8rem",
};
