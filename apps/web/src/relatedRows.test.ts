import { describe, expect, it } from "vitest";
import type { Article } from "@zammy/shared";
import { collapseCopies, outletLinks } from "./relatedRows.js";

/**
 * The related-disclosure fold (§14.3).
 *
 * Two invariants worth pinning: every folded article stays reachable — each
 * row links one copy per outlet, so no printing hides behind a count — and
 * the rows' copies tally to the article count, which is what keeps the
 * disclosure's "N related" promise reconcilable (the live report behind
 * counting articles, not rows).
 */

const article = (id: string, overrides: Partial<Article> = {}): Article => ({
  id,
  // A group of one, the state every article is born in (migration 0003).
  // Override it to put two articles in one piece: these rows fold by title
  // WITHIN a group, so the default keeps every fixture article distinct.
  groupId: id,
  url: `https://example.com/${id}`,
  title: `story ${id}`,
  description: null,
  author: null,
  imageUrl: null,
  language: "en",
  categories: [],
  sourceCategories: [],
  sourceDomain: "example.com",
  published: "2026-08-13T06:00:00.000Z",
  sightingCount: 1,
  latestSeen: "2026-08-13T06:00:00.000Z",
  ...overrides,
});

describe("collapseCopies", () => {
  it("folds word-identical titles into one row carrying every copy", () => {
    // One piece as two outlets ran it — same group, same words, two URLs. That
    // is what CONTEXT.md's Group entry describes, and it is the shape this fold
    // exists for.
    const wire = { title: "The Latest: markets rally", groupId: "7" };
    const a = article("1", wire);
    const b = article("2", wire);
    const other = article("3");

    const rows = collapseCopies([a, b, other]);

    expect(rows).toHaveLength(2);
    // First occurrence fronts the row — newest first — and stays copies[0].
    expect(rows[0]?.article).toBe(a);
    expect(rows[0]?.copies).toEqual([a, b]);
    expect(rows[1]?.copies).toEqual([other]);
  });

  it("keeps two different pieces that share a headline apart", () => {
    // The residue of the title-only fold, one level below the rail's cut. A
    // bucket holds every group whose anchor landed in the same part of the day,
    // so two unrelated pieces can collide on a low-token headline — and a single
    // row would claim they were one piece. `groupId` is on the wire now, so this
    // is answerable rather than a known weakness of the signal.
    const rows = collapseCopies([
      article("1", { title: "Live updates", groupId: "10" }),
      article("2", { title: "Live updates", groupId: "20" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.copies.length)).toEqual([1, 1]);
  });

  it("keeps near-identical wire variants as separate rows", () => {
    const rows = collapseCopies([
      article("1", { title: "Storm hits coast" }),
      article("2", { title: "Storm hits coast." }),
    ]);

    expect(rows).toHaveLength(2);
  });

  it("tallies copies back to the article count, whatever the fold", () => {
    const articles = [
      article("1", { title: "A" }),
      article("2", { title: "A" }),
      article("3", { title: "B" }),
      article("4", { title: "A" }),
    ];

    const total = collapseCopies(articles).reduce((sum, row) => sum + row.copies.length, 0);

    expect(total).toBe(articles.length);
  });
});

describe("outletLinks", () => {
  it("links one copy per source, each to that outlet's own URL", () => {
    const links = outletLinks([
      article("1", { sourceDomain: "kjrh.com", url: "https://kjrh.com/story" }),
      article("2", { sourceDomain: "katc.com", url: "https://katc.com/story" }),
    ]);

    expect(links).toEqual([
      { label: "kjrh.com", article: expect.objectContaining({ url: "https://kjrh.com/story" }) },
      { label: "katc.com", article: expect.objectContaining({ url: "https://katc.com/story" }) },
    ]);
  });

  it("keeps the newest copy for a source that printed the story twice", () => {
    const newest = article("1", { sourceDomain: "kjrh.com" });
    const older = article("2", { sourceDomain: "kjrh.com" });

    const links = outletLinks([newest, older]);

    expect(links).toHaveLength(1);
    expect(links[0]?.article).toBe(newest);
  });

  it("falls back to the URL's host when upstream sent no source domain", () => {
    const links = outletLinks([
      article("1", { sourceDomain: null, url: "https://news.example.org/story" }),
    ]);

    expect(links[0]?.label).toBe("news.example.org");
  });
});
