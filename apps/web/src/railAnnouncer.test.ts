import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RAIL_STATUS_ID } from "./railAnnouncement.js";

/**
 * The one part of the announcement that is not TypeScript.
 *
 * `RailAnnouncer` portals into a node it does not create, and on purpose: a live
 * region has to exist before the first message lands in it, and React cannot
 * offer that on a cold load. The cost of that choice is an invariant split
 * across two languages — delete the node from `index.html` and every
 * announcement in the app stops, with the types still checking, every other test
 * still green, and nothing visible changing for a sighted reader.
 *
 * `RailAnnouncer` returns null rather than throwing when the node is missing,
 * because blanking the whole view over an sr-only paragraph is worse than losing
 * the announcements. This file is what makes that survivable: it is the check
 * that would otherwise have had to be a runtime explosion.
 *
 * `RAIL_STATUS_ID` is IMPORTED, not retyped. An earlier version of this file
 * carried its own copy of the string, which made it a check of `index.html`
 * against itself: renaming the constant in `TimelinePage` alone silenced the
 * whole application and this file passed.
 */
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

/**
 * Comments are stripped BEFORE matching, because an HTML comment containing a
 * lookalike tag would otherwise satisfy every assertion below while the real
 * node sat broken underneath it — a false pass, which is the only kind of bug
 * this file can have that matters.
 */
const markup = html.replace(/<!--[\s\S]*?-->/g, "");

/** Attribute order is free and quoting is free; presence and emptiness are not. */
const REGION = new RegExp(`<p[^>]*\\bid=["']${RAIL_STATUS_ID}["'][^>]*>([\\s\\S]*?)</p>`, "g");

function regionTags(): string[] {
  return [...markup.matchAll(REGION)].map((m) => m[0]);
}

function regionTag(): string {
  const [first] = regionTags();
  if (first === undefined) throw new Error(`no <p id="${RAIL_STATUS_ID}"> in index.html`);
  return first;
}

describe("the rail's live region in index.html", () => {
  it("is present exactly once, so RailAnnouncer portals to the node it was shown", () => {
    // Exactly once rather than at least once: `getElementById` takes the FIRST
    // match, so a second copy is a node that looks guarded and is not.
    expect(regionTags()).toHaveLength(1);
  });

  it("is EMPTY, because text that ships with the node is text nobody hears", () => {
    const inner = regionTag().replace(/^<p[^>]*>/, "").replace(/<\/p>$/, "");
    expect(inner).toBe("");
  });

  it("carries the live-region attributes, not just the id", () => {
    // `role="status"` is what implies `aria-atomic`, so the sentence is read
    // whole; `aria-live="polite"` is what keeps it out of the reader's way.
    // An id with neither is a paragraph, and announces nothing.
    expect(regionTag()).toMatch(/\brole=["']status["']/);
    expect(regionTag()).toMatch(/\baria-live=["']polite["']/);
  });

  it("is visually hidden by the shared class rather than by its own styles", () => {
    // `.sr-only` is the clip-rect pattern (`index.css`), which keeps the node in
    // the accessibility tree. `display: none` or `hidden` here would remove it
    // from that tree and silence the region while looking perfectly correct.
    // What this canNOT see is `index.css` redefining `.sr-only` out of the
    // tree — that is one file further away than a regex over markup reaches.
    const tag = regionTag();
    expect(tag).toMatch(/\bclass=["'][^"']*\bsr-only\b/);
    expect(tag).not.toMatch(/\bhidden\b/);
    expect(tag).not.toMatch(/display:\s*none/);
  });

  it("lives outside #root, which React empties on its first commit", () => {
    // The subtle one. React's HostRoot commit clears the container's contents,
    // so a region nested inside #root is deleted before the first sentence is
    // written and the portal then writes into a detached node — silent, total,
    // and invisible to every other assertion here. Pinning the root as EMPTY in
    // the markup is what makes that unrepresentable.
    expect(markup).toMatch(/<div[^>]*\bid=["']root["'][^>]*>\s*<\/div>/);
  });
});
