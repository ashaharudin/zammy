import { describe, expect, it } from "vitest";
import { TRACE_ID_PATTERN } from "@zammy/shared/request-trace";
import {
  TRACE_ID_SOURCE,
  isTraceId,
  parsePlaybackLocation,
  playbackHref,
  type PlaybackTarget,
} from "./playbackRoute.js";

/**
 * The playback view's place in the URL (ADR-0029, ADR-0031).
 *
 * Two regressions this exists to catch. The first is the view escaping its own
 * parameter: `/?q=x` or a storyline path suddenly rendering the playback page
 * because something upstream of `App` started matching loosely. The second is the
 * trace id drifting away from the API's: this module cannot import the shared
 * pattern (it would pull zod into the main chunk), so the only thing keeping the
 * copy honest is the equality test below.
 */

const ID = "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b";

describe("parsePlaybackLocation", () => {
  it("opens the newest recorded trace on a bare /?trace", () => {
    expect(parsePlaybackLocation("/", "?trace", "")).toEqual({ kind: "latest" });
  });

  it("reads an old example link as the bare parameter", () => {
    expect(parsePlaybackLocation("/", "?trace=cache-hit", "")).toEqual({ kind: "latest" });
  });

  it("opens a recorded trace from the fragment", () => {
    expect(parsePlaybackLocation("/", "?trace", `#t=${ID}`)).toEqual({
      kind: "recorded",
      id: ID,
    });
  });

  it("lets a valid id in the fragment win over a value in the query", () => {
    expect(parsePlaybackLocation("/", "?trace=cache-hit", `#t=${ID}`)).toEqual({
      kind: "recorded",
      id: ID,
    });
  });

  it("falls back to the newest, noticed, on a fragment that is not an id", () => {
    for (const junk of ["#t=junk", "#t=", `#t=${ID.toUpperCase()}`, `#t=${ID}x`]) {
      expect(parsePlaybackLocation("/", "?trace", junk)).toEqual({
        kind: "latest",
        notice: "bad_id",
      });
    }
  });

  it("ignores a fragment that carries no t key", () => {
    expect(parsePlaybackLocation("/", "?trace", "#section")).toEqual({ kind: "latest" });
  });

  it("is not the playback view without the trace parameter", () => {
    expect(parsePlaybackLocation("/", "?q=x", "")).toBeNull();
    expect(parsePlaybackLocation("/", "", "")).toBeNull();
    // An id in the fragment alone is not an ask for playback either.
    expect(parsePlaybackLocation("/", "", `#t=${ID}`)).toBeNull();
  });

  it("is the playback view when trace rides alongside a search", () => {
    expect(parsePlaybackLocation("/", "?q=x&trace", "")).toEqual({ kind: "latest" });
  });

  it("leaves every other path alone, the storyline route included", () => {
    expect(parsePlaybackLocation(`/storyline/${ID}/a-slug`, "?trace", "")).toBeNull();
    expect(parsePlaybackLocation("/replay", "?trace", "")).toBeNull();
    expect(parsePlaybackLocation("/index.html", "?trace", "")).toBeNull();
  });
});

describe("playbackHref", () => {
  it("round-trips every target through parsePlaybackLocation", () => {
    const targets: PlaybackTarget[] = [
      { kind: "latest" },
      { kind: "recorded", id: ID },
    ];
    for (const target of targets) {
      const url = new URL(playbackHref(target), "https://zammy.info");
      expect(parsePlaybackLocation(url.pathname, url.search, url.hash)).toEqual(target);
    }
  });

  it("keeps a recorded id out of the query string", () => {
    const url = new URL(playbackHref({ kind: "recorded", id: ID }), "https://zammy.info");
    expect(url.search).toBe("?trace");
    expect(url.hash).toBe(`#t=${ID}`);
  });

  it("drops a notice, so a copied link opens on the page itself", () => {
    expect(playbackHref({ kind: "latest", notice: "bad_id" })).toBe("/?trace");
  });
});

describe("isTraceId", () => {
  it("accepts what crypto.randomUUID mints", () => {
    for (let i = 0; i < 50; i += 1) expect(isTraceId(crypto.randomUUID())).toBe(true);
  });

  it("rejects an uppercase id and a version-1 id", () => {
    expect(isTraceId(ID.toUpperCase())).toBe(false);
    expect(isTraceId("3f2b8c1e-9a4d-1e7f-8b21-0c5d6e7f8a9b")).toBe(false);
  });
});

describe("TRACE_ID_SOURCE", () => {
  it("is the shared contract's pattern, character for character", () => {
    // The copy exists only to keep zod out of the main chunk; it must never mean
    // something different from what the API mints and the read route accepts.
    expect(TRACE_ID_SOURCE).toBe(TRACE_ID_PATTERN.source);
  });
});
