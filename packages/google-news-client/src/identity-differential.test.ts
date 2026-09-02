import { describe, expect, it } from "vitest";
import {
  altKeyProbeIsConsistent,
  canonicalizeUrl,
  collapseWhitespace,
  deriveAltKey,
  deriveDedupKey,
  sourceDomain,
  type DropReason,
} from "@zammy/news-client";
import { GoogleNewsFixtureStore } from "./fixture-store.js";
import { normalizeSighting, publisherDomain } from "./normalize.js";
import { parsePublished, type RawGoogleNewsItem } from "./raw.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * The differential guard on Google News' article identity — and the one of the
 * three that is not a formality.
 *
 * The other two adapters read the source domain out of the article's own link.
 * This one reads it out of `<source url="…">`, so the fold it applies is a
 * DIFFERENT fold over a DIFFERENT input, and its rows are keyed on it. When the
 * eight open-coded steps moved into `deriveArticleIdentity`, the temptation on
 * offer was to "unify" that away; the departure is instead a named parameter,
 * `publisherLink`, and this file is what proves the parameter reproduces the
 * substitution byte for byte over real captured feeds.
 *
 * See `@zammy/currents-client`'s sibling for why a fold's consolidation needs a
 * differential harness rather than a diff.
 */

/**
 * The real cap and an unreachable horizon: the store truncates at
 * `ITEMS_PER_QUERY`, so the two captures are read through their own windows
 * rather than in one call that would silently drop 20 of the 120.
 */
const CAPPED_WINDOW = {
  startDate: new Date("2026-08-19T00:00:00.000Z"),
  endDate: new Date("2026-08-23T00:00:00.000Z"),
};
const DEEP_WINDOW = {
  startDate: new Date("2025-01-31T00:00:00.000Z"),
  endDate: new Date("2025-02-04T00:00:00.000Z"),
};

async function corpus(): Promise<{ items: RawGoogleNewsItem[]; language: string | null }> {
  const store = new GoogleNewsFixtureStore(FIXTURES_DIR);
  await store.load();
  return {
    items: [...store.search(CAPPED_WINDOW), ...store.search(DEEP_WINDOW)],
    language: store.feedLanguage,
  };
}

interface Identity {
  url: string;
  dedupKey: string;
  altKey: string | null;
  sourceDomain: string | null;
}

type OldOutcome = { ok: true; identity: Identity } | { ok: false; reason: DropReason };

/**
 * Google News' identity protocol as `normalize.ts` open-coded it before
 * `deriveArticleIdentity`, departure included: `publisherDomain(raw.sourceUrl)`
 * where the other two adapters wrote `sourceDomain(url)`.
 *
 * Transcribed rather than imported. `publisherDomain` is still called by name
 * here because it is the pre-module spelling of the substitution; the point of
 * the comparison is that the module's `publisherLink` parameter lands on the
 * same value.
 */
function identityTheOldWay(raw: RawGoogleNewsItem): OldOutcome {
  const title = collapseWhitespace(raw.title);
  if (!title) return { ok: false, reason: "no_title" };

  const rawUrl = collapseWhitespace(raw.link);
  if (!rawUrl) return { ok: false, reason: "no_url" };

  const url = canonicalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: "bad_url" };

  const publishedMs = parsePublished(raw.pubDate);
  if (Number.isNaN(publishedMs)) return { ok: false, reason: "bad_published" };

  const domain = publisherDomain(raw.sourceUrl);
  const published = new Date(publishedMs).toISOString();
  const altKey = deriveAltKey(domain, title, published);
  if (!altKey) return { ok: false, reason: "no_identity" };

  return {
    ok: true,
    identity: { url, dedupKey: deriveDedupKey(url), altKey, sourceDomain: domain },
  };
}

describe("article identity, old way against the module", () => {
  it("derives byte-identical fields for every recorded item", async () => {
    const { items, language } = await corpus();
    // 100 from the capped capture and 20 from the deep one.
    expect(items).toHaveLength(120);

    let compared = 0;
    let overridden = 0;
    for (const item of items) {
      const old = identityTheOldWay(item);
      const fresh = normalizeSighting(item, { language });

      expect(fresh.ok).toBe(old.ok);
      if (!fresh.ok || !old.ok) {
        if (!fresh.ok && !old.ok) expect(fresh.reason).toBe(old.reason);
        continue;
      }

      // Named per field rather than compared as an object, so a failure says
      // WHICH derivation moved.
      expect(fresh.sighting.url).toBe(old.identity.url);
      expect(fresh.sighting.dedupKey).toBe(old.identity.dedupKey);
      expect(fresh.sighting.altKey).toBe(old.identity.altKey);
      expect(fresh.sighting.sourceDomain).toBe(old.identity.sourceDomain);
      compared += 1;

      // The comparison is only a test of the OVERRIDE where the override
      // actually changes the answer. Counted rather than assumed: if a future
      // capture ever arrived with `<source url>` on `news.google.com`, this
      // whole file would quietly become a test of `sourceDomain(url)`.
      if (fresh.sighting.sourceDomain !== sourceDomain(fresh.sighting.url)) {
        overridden += 1;
      }
    }

    expect(compared).toBe(120);
    // Every one of the 120: the redirect's host is `news.google.com` on all of
    // them, and not one publisher is Google.
    expect(overridden).toBe(120);
  });

  /**
   * The invariant `altKeyProbe`'s widened lookup rests on (ADR-0022), asserted
   * over the same corpus `fixture-client.test.ts` asserts it over.
   *
   * Duplicated deliberately. That file asserts it as a claim about the FIXTURES;
   * here it is the second half of the differential — "the module reproduced the
   * old key" is only half an answer if the sighting no longer stores the domain
   * that key was scoped to.
   */
  it("re-derives every item's alt key from the fields the item stored", async () => {
    const { items, language } = await corpus();
    let checked = 0;
    for (const item of items) {
      const outcome = normalizeSighting(item, { language });
      if (!outcome.ok) continue;
      expect(altKeyProbeIsConsistent(outcome.sighting)).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(120);
  });
});
