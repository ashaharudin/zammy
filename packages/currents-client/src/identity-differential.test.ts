import { describe, expect, it } from "vitest";
import {
  altKeyProbe,
  altKeyProbeIsConsistent,
  canonicalizeUrl,
  collapseWhitespace,
  deriveAltKey,
  deriveDedupKey,
  firstNonEmpty,
  sourceDomain,
  type DropReason,
} from "@zammy/news-client";
import { FixtureStore } from "./fixture-store.js";
import { normalizeSighting, parsePublished } from "./normalize.js";
import type { RawSighting } from "./raw.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * The differential guard on Currents' article identity.
 *
 * `deriveArticleIdentity` consolidated eight open-coded steps into one call, and
 * a consolidation of a fold is not a code move: `dedup_key` and `alt_key` are
 * STORED columns under unique indexes on a live archive, so a re-expression that
 * changed one byte would stop matching rows we already hold and start minting
 * duplicates of them — silently, with no error and no metric. ADR-0018 calls
 * that a migration rather than a refactor.
 *
 * A diff cannot prove a re-expression equivalent, so this replays the whole
 * recorded corpus through BOTH: `identityTheOldWay` below is a verbatim
 * transcription of what `normalizeSighting` open-coded before the module
 * existed, and every one of the four fields is compared per sighting.
 *
 * **Keep this after the refactor lands.** Its job then is the next change to a
 * derivation: it is the only thing in the tree that will say "you re-keyed the
 * archive" before production does.
 */

/** Every recorded Currents sighting — three captures, deduplicated by nothing. */
const WHOLE_CORPUS = { maxPageSize: 10_000 };

async function corpus(): Promise<RawSighting[]> {
  const store = new FixtureStore(FIXTURES_DIR);
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
 * Currents' identity protocol as `normalize.ts` open-coded it before
 * `deriveArticleIdentity` — the eight steps in the order they ran, drops
 * included, because which counter a drop lands in is a metric too.
 *
 * Transcribed rather than imported on purpose. A harness that called the new
 * module on both sides would compare it against itself.
 */
function identityTheOldWay(raw: RawSighting): OldOutcome {
  const title = collapseWhitespace(raw.title);
  if (!title) return { ok: false, reason: "no_title" };

  const rawUrl = firstNonEmpty(raw.url, raw.urls);
  if (!rawUrl) return { ok: false, reason: "no_url" };

  const url = canonicalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: "bad_url" };

  const publishedMs = parsePublished(raw.published);
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
  it("derives byte-identical fields for every recorded sighting", async () => {
    const raw = await corpus();
    // Asserted so the harness cannot be quietly weakened by a corpus that
    // stopped loading: 260 recorded sightings across the three captures.
    expect(raw).toHaveLength(260);

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

    expect(compared).toBe(260);
    // The fallback key is the derivation most easily broken invisibly, so the
    // comparison above has to actually reach it on the corpus rather than agree
    // on a field of nulls. 259 of 260 carry one; the exception is a `facebook.com`
    // item whose title the SOURCE cut short ("…fossil fuel companies have ..."),
    // which is ADR-0018's truncation refusal firing on real recorded input, and
    // both sides refuse it identically.
    expect(keyed).toBe(259);
  });

  /**
   * The invariant `altKeyProbe`'s widened lookup rests on (ADR-0022): the
   * sighting's own stored fields re-derive the key it carries.
   *
   * Google News' fixture test has asserted this since ADR-0022 landed, on the
   * grounds that its adapter is the one whose key is not derived from its own
   * `url`. `altKeyProbe`'s comment says the loud version lives in "the adapters'
   * own fixture tests" — plural — and it did not. This is one of the two that
   * were missing.
   */
  it("re-derives every sighting's alt key from the fields that sighting stored", async () => {
    const raw = await corpus();
    let checked = 0;
    for (const item of raw) {
      const outcome = normalizeSighting(item);
      if (!outcome.ok) continue;
      expect(altKeyProbeIsConsistent(outcome.sighting)).toBe(true);
      // And the lookup never widens for this provider. Currents sends a real
      // clock reading, so it never sets `publishedIsDateOnly` and ADR-0022's
      // neighbours are not its to claim — a sighting with a null key probes
      // nothing at all, which is the pre-ADR-0018 path in full.
      expect(altKeyProbe(outcome.sighting)).toHaveLength(
        outcome.sighting.altKey === null ? 0 : 1,
      );
      checked += 1;
    }
    expect(checked).toBe(260);
  });
});
