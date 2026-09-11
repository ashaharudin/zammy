import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
 */
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

/** The same id `RAIL_STATUS_ID` carries in `TimelinePage.tsx`. */
const RAIL_STATUS_ID = "rail-status";

function railStatusTag(): string {
  const match = html.match(new RegExp(`<p[^>]*id="${RAIL_STATUS_ID}"[^>]*>(.*?)</p>`, "s"));
  if (!match) throw new Error(`no <p id="${RAIL_STATUS_ID}"> in index.html`);
  return match[0];
}

describe("the rail's live region in index.html", () => {
  it("is present, so RailAnnouncer has somewhere to portal to", () => {
    expect(railStatusTag()).toContain(`id="${RAIL_STATUS_ID}"`);
  });

  it("is EMPTY, because text that ships with the node is text nobody hears", () => {
    const inner = railStatusTag().replace(/^<p[^>]*>/, "").replace(/<\/p>$/, "");
    expect(inner).toBe("");
  });

  it("carries the live-region attributes, not just the id", () => {
    // `role="status"` is what implies `aria-atomic`, so the sentence is read
    // whole; `aria-live="polite"` is what keeps it out of the reader's way.
    // An id with neither is a paragraph, and announces nothing.
    const tag = railStatusTag();
    expect(tag).toContain('role="status"');
    expect(tag).toContain('aria-live="polite"');
  });

  it("is visually hidden by the shared class rather than by its own styles", () => {
    // `.sr-only` is the clip-rect pattern (`index.css`), which keeps the node in
    // the accessibility tree. `display: none` or `hidden` here would remove it
    // from that tree and silence the region while looking perfectly correct.
    const tag = railStatusTag();
    expect(tag).toContain('class="sr-only"');
    expect(tag).not.toMatch(/\bhidden\b/);
    expect(tag).not.toMatch(/display:\s*none/);
  });
});
