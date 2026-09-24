import { useState } from "react";
import { MONO } from "../theme.js";
import { EXAMPLE_TRACES } from "./exampleTraces.js";
import { NOTICE_TEXT } from "./pageNotices.js";
import { isTraceId } from "./playbackRoute.js";

/**
 * Choosing what to play (ADR-0029, "The change", item 8): the built-in examples, and a
 * recorded trace by its id.
 *
 * The examples are toggle buttons (`aria-pressed` on the one showing), so the set reads as one
 * control with a state rather than as seven links. A recorded trace is opened by pasting its
 * id — or the whole `/?trace#t=…` link, since that is what an operator has to hand — and the
 * form only accepts what `isTraceId` accepts, so a typo is caught here rather than spent as a
 * read that 404s.
 *
 * A pasted id that is not one says so with `role="alert"`, as the record panel's form errors
 * do: the error appears after a submit, away from where the reader's attention is, and a
 * field's `aria-describedby` is read only when the field is next focused.
 *
 * Deliberately not here: any list of recorded traces. The store is keyed by an unguessable id
 * and has no index (ADR-0029, item 7: the id IS the capability), on purpose; the page knows
 * only the ids it was given.
 */
export function SourceBar({
  current,
  onExample,
  onRecorded,
}: {
  /** The example on screen, or null when a recorded or browser-only trace is. */
  current: string | null;
  onExample: (slug: string) => void;
  onRecorded: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", fontFamily: MONO }}>
      <div
        role="group"
        aria-label="Examples"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}
      >
        {EXAMPLE_TRACES.map((example) => {
          const pressed = example.slug === current;
          return (
            <button
              key={example.slug}
              type="button"
              aria-pressed={pressed}
              title={example.summary}
              onClick={() => onExample(example.slug)}
              style={{
                minHeight: "44px",
                padding: "0 0.8rem",
                border: "1px solid var(--border)",
                borderRadius: "999px",
                background: pressed ? "var(--fg)" : "var(--chip-bg)",
                color: pressed ? "var(--bg)" : "var(--fg)",
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: "0.8rem",
              }}
            >
              {example.title}
            </button>
          );
        })}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const id = traceIdFrom(draft);
          if (id === null) {
            setError("That is not a trace id: paste the id, or the whole #t= link.");
            return;
          }
          setError(null);
          setDraft("");
          onRecorded(id);
        }}
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem" }}
      >
        <label
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.4rem",
            flex: "1 1 16rem",
            fontSize: "0.8rem",
          }}
        >
          <span style={{ color: "var(--fg-muted)" }}>Open a recorded trace</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="trace id or #t= link"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby={error ? "trace-id-error" : undefined}
            style={{
              flex: "1 1 12rem",
              minWidth: 0,
              minHeight: "44px",
              padding: "0 0.6rem",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              background: "var(--surface)",
              fontFamily: MONO,
              fontSize: "0.8rem",
            }}
          />
        </label>
        <button
          type="submit"
          style={{
            minHeight: "44px",
            padding: "0 0.9rem",
            border: "1px solid var(--border)",
            borderRadius: "999px",
            background: "var(--chip-bg)",
            cursor: "pointer",
            fontFamily: MONO,
            fontSize: "0.8rem",
          }}
        >
          Open
        </button>
        {error && (
          <p
            id="trace-id-error"
            role="alert"
            style={{ ...NOTICE_TEXT, flexBasis: "100%", fontSize: "0.8rem" }}
          >
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

/** A trace id from what was pasted: the id itself, or a playback link carrying `#t=<id>`. */
function traceIdFrom(pasted: string): string | null {
  const value = pasted.trim().toLowerCase();
  if (isTraceId(value)) return value;
  const fragment = /[#&]t=([0-9a-f-]{36})(?:$|&)/.exec(value);
  return fragment && isTraceId(fragment[1]!) ? fragment[1]! : null;
}
