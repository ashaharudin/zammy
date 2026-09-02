import { describe, expect, it } from "vitest";
import {
  altKeyProbe,
  altKeyProbeIsConsistent,
  canonicalizeUrl,
  collapseWhitespace,
  deriveAltKey,
  deriveDedupKey,
  sourceDomain,
  type DropReason,
} from "@zammy/news-client";
import { GnewsFixtureStore } from "./fixture-store.js";
import { normalizeSighting, parsePublished } from "./normalize.js";
import type { RawGnewsArticle } from "./raw.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * The differential guard on GNews' article identity — the sibling of
 * `@zammy/currents-client`'s, and see that file's header for why a fold's
 * consolidation needs one at all.
 *
 * One honest caveat this corpus carries and Currents' does not: no GNews key was
 * available, so `fixtures/gnews-search-sample.json` is the documented v4 SHAPE
 * around real recorded Currents content (`GnewsFixtureStore`). That is enough
 * for what this file asks — whether two spellings of one derivation agree over
 * real URLs, titles and timestamps — and it is not a claim about GNews' own
 * misbehaviour.
 */

const WHOLE_CORPUS = { maxPageSize: 10_000 };

async function corpus(): Promise<RawGnewsArticle[]> {
  const store = new GnewsFixtureStore(FIXTURES_DIR);
  await store.load();
  return store.search({}, WHOLE_CORPUS);
}

interface Identity {
  url: string;
  dedupKey: string;
  altKey: string | null;
  sourceDomain: string | null;
}

type OldOutcome = { ok: true; identity: Identity } | { ok: false; reason: DropReason };

/**
 * GNews' identity protocol as `normalize.ts` open-coded it before
 * `deriveArticleIdentity` — the same steps in the same order, drops included.
 *
 * Transcribed rather than imported: a harness that called the new module on both
 * sides would compare it against itself.
 */
function identityTheOldWay(raw: RawGnewsArticle): OldOutcome {
  const title = collapseWhitespace(raw.title);
  if (!title) return { ok: false, reason: "no_title" };

  const rawUrl = collapseWhitespace(raw.url);
  if (!rawUrl) return { ok: false, reason: "no_url" };

  const url = canonicalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: "bad_url" };

  const publishedMs = parsePublished(raw.publishedAt);
  if (Number.isNaN(publishedMs)) return { ok: false, reason: "bad_published" };

  const domain = sourceDomain(url);
  const published = new Date(publishedMs).toISOString();

  return {
    ok: true,
    identity: {
      url,
      dedupKey: deriveDedupKey(url),
      altKey: deriveAltKey(domain, title, published),
      sourceDomain: domain,
    },
  };
}

describe("article identity, old way against the module", () => {
  it("derives byte-identical fields for every recorded article", async () => {
    const raw = await corpus();
    // Asserted so a corpus that stopped loading cannot silently weaken this.
    expect(raw).toHaveLength(122);

    let compared = 0;
    let keyed = 0;
    for (const item of raw) {
      const old = identityTheOldWay(item);
      const fresh = normalizeSighting(item);

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
      if (fresh.sighting.altKey !== null) keyed += 1;
    }

    expect(compared).toBe(122);
    // The comparison has to actually reach the fallback key rather than agree
    // on a field of nulls. 121 of 122 carry one; the exception is the same
    // source-truncated `facebook.com` title the Currents corpus holds, this
    // fixture being that content reshaped — ADR-0018's truncation refusal, and
    // both sides refuse it identically.
    expect(keyed).toBe(121);
  });

  /**
   * The invariant `altKeyProbe`'s widened lookup rests on (ADR-0022), asserted
   * here for the second of the two adapters whose fixture tests `altKeyProbe`'s
   * comment claimed it lived in and where it did not.
   */
  it("re-derives every sighting's alt key from the fields that sighting stored", async () => {
    const raw = await corpus();
    let checked = 0;
    for (const item of raw) {
      const outcome = normalizeSighting(item);
      if (!outcome.ok) continue;
      expect(altKeyProbeIsConsistent(outcome.sighting)).toBe(true);
      // And the lookup never widens for this provider. GNews sends a real
      // ISO-8601 clock reading, so it never sets `publishedIsDateOnly` and
      // ADR-0022's neighbours are not its to claim — a sighting with a null key
      // probes nothing at all, which is the pre-ADR-0018 path in full.
      expect(altKeyProbe(outcome.sighting)).toHaveLength(
        outcome.sighting.altKey === null ? 0 : 1,
      );
      checked += 1;
    }
    expect(checked).toBe(122);
  });
});
