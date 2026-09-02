import { createHash } from "node:crypto";
import { Sighting } from "./sighting.js";

/**
 * Normalization — the client's most important job (ARCHITECTURE 5.2).
 *
 * Every upstream quirk is absorbed at the boundary, once, so nothing downstream
 * ever sees a raw provider payload. What lives *here* is the part that is the
 * same whoever sent the article: URL canonicalization, the dedup key, the
 * registrable domain, image placeholders, and the drop accounting.
 *
 * What does NOT live here is the mapping from a provider's wire shape onto
 * `Sighting`. That is per-provider by nature — Currents sends
 * `"2026-08-04 20:45:56 +0000"` and GNews sends ISO-8601 — so each adapter owns
 * its own `normalizeSighting` and hands the result to `finalizeSighting` below.
 *
 * Nor does the ORDER those steps run in. `canonicalizeUrl`, `deriveDedupKey`,
 * `deriveAltKey` and `sourceDomain` are the steps of an article's identity, and
 * an adapter that called them itself had to know an unwritten protocol about
 * which feeds which and what must then be stored beside what.
 * `article-identity.ts` states it as one call; these four stay exported because
 * they are what that call is made of.
 *
 * Normalization is deliberately fallible: a malformed sighting is dropped and
 * counted rather than repaired with a guess (ARCHITECTURE 11). The one case that
 * matters most is a bad timestamp — the timeline axis is the product's core
 * promise, so defaulting it to "now" would silently corrupt the thing users came
 * for.
 */

/** Why a sighting was dropped. Each is a counter, so a rising rate is visible. */
export type DropReason =
  | "no_title"
  | "no_url"
  | "bad_url"
  | "bad_published"
  /**
   * Nothing dependable identifies the article.
   *
   * NOT the same as "`deriveAltKey` returned null", which is a normal, safe
   * outcome for a provider whose `url` is the article: null there means
   * "identified by URL alone", exactly as every row was before ADR-0018. Only
   * an adapter whose URL is *not* an identity — Google News, whose `<link>` is
   * an opaque redirect — has nothing left when the fallback refuses, and only
   * such an adapter may raise this.
   *
   * Kept out of `schema` deliberately. A schema drop means a provider sent
   * something the contract does not describe, which is an upstream change worth
   * investigating; this means the provider behaved perfectly and the article
   * still cannot be filed. Folding the two together would make a rise in either
   * unreadable.
   */
  | "no_identity"
  | "schema";

export interface NormalizationStats {
  received: number;
  kept: number;
  dropped: Record<DropReason, number>;
}

export type NormalizeOutcome =
  | { ok: true; sighting: Sighting }
  | { ok: false; reason: DropReason; detail: string };

export function emptyStats(): NormalizationStats {
  return {
    received: 0,
    kept: 0,
    dropped: {
      no_title: 0,
      no_url: 0,
      bad_url: 0,
      bad_published: 0,
      no_identity: 0,
      schema: 0,
    },
  };
}

/** Fold one batch's stats into a running total, e.g. across pages or providers. */
export function accumulateStats(
  target: NormalizationStats,
  source: NormalizationStats,
): NormalizationStats {
  target.received += source.received;
  target.kept += source.kept;
  for (const [reason, count] of Object.entries(source.dropped)) {
    target.dropped[reason as DropReason] += count;
  }
  return target;
}

/**
 * Run a provider's per-item mapper over a batch, keeping what is usable and
 * counting what is not.
 *
 * The caller must NOT use `sightings.length` as an end-of-results signal: drops
 * change the count, and `sightings.length < pageSize` would then read as "last
 * page" when it only means "one sighting was malformed". The raw count is the
 * only valid page-boundary signal — see `SearchResult.isLastPage`.
 */
export function normalizeBatch<T>(
  raw: readonly T[],
  normalizeOne: (item: T) => NormalizeOutcome,
): { sightings: Sighting[]; stats: NormalizationStats } {
  const stats = emptyStats();
  const sightings: Sighting[] = [];

  for (const item of raw) {
    stats.received += 1;
    const outcome = normalizeOne(item);
    if (outcome.ok) {
      sightings.push(outcome.sighting);
      stats.kept += 1;
    } else {
      stats.dropped[outcome.reason] += 1;
    }
  }

  return { sightings, stats };
}

/**
 * Validate an adapter's mapping against the shared contract rather than trusting
 * it. This is the last gate before a sighting reaches the rest of the system, and
 * it is cheap; a `schema` drop means a provider sent something the contract does
 * not describe, which is a fact worth a metric rather than a crash.
 */
export function finalizeSighting(candidate: unknown): NormalizeOutcome {
  const parsed = Sighting.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, sighting: parsed.data };
}

/**
 * The UUIDv5 namespace sightings are derived in (RFC 4122 §4.3), generated once
 * and fixed forever: changing it would re-key every derived sighting and
 * re-ingest history as new.
 */
const SIGHTING_NAMESPACE = "6f0d1c62-2f14-5a3f-9b3a-4a0f6a2d1e77";

/**
 * A stable UUID for a provider whose own ids are not UUIDs (GNews sends opaque
 * strings).
 *
 * Deterministic, so re-fetching the same emission collides on
 * `sightings.id` and `ON CONFLICT DO NOTHING` keeps the ingest idempotent —
 * the property the whole fold depends on. Namespaced by provider, so two
 * providers cannot collide on a shared id, and so this can never collide with
 * the random v4 UUIDs Currents supplies and uses verbatim.
 *
 * A UUIDv5 rather than a raw hash because `sightings.id` is a `uuid` column:
 * deriving one avoids widening the primary key of a table that already holds
 * every emission we have ever seen.
 */
export function deriveSightingId(provider: string, providerSightingId: string): string {
  const namespace = Buffer.from(SIGHTING_NAMESPACE.replace(/-/g, ""), "hex");
  const name = Buffer.from(`${provider}:${providerSightingId}`, "utf8");
  const hash = createHash("sha1").update(namespace).update(name).digest();

  // Version 5 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Query parameters that identify a referral, never a document.
 *
 * From here on, a parameter earns a place only on evidence from outside our own
 * guesswork that it does not select content — a name that merely *looks* like a
 * tracker is not enough, because over-collapsing is the worse error (see
 * `canonicalizeUrl` below). The standard is the publisher's own
 * `<link rel="canonical">`: fetch a real article with and without the
 * parameter, and add it only if the page declares the bare URL canonical both
 * times. The four click ids above predate that rule and were never held to it;
 * they were safe on a weaker one, being vendor-namespaced (Facebook, Google,
 * Microsoft, Instagram) plus Mailchimp's `mc_eid`, so no publisher will ever
 * reuse those names to mean something of its own.
 *
 * `share_id`: verified 2026-08-27. Production held two `articles` rows for one
 * Common Dreams story differing only by `?share_id=983848`; fetched both ways,
 * the page declares `rel="canonical"` as the bare
 * `commondreams.org/news/trump-belgium-ring-bribe` and serves the same article
 * (the id survives only in a client bootstrap payload, as a field beside
 * `post_id` and `override_device` — those are payload fields, not query
 * parameters we see or strip). Confirmed on honest-broker.com, deliberately a
 * different stack — Substack, where Common Dreams is WordPress-based — so the
 * two are independent implementations rather than one CMS checked twice.
 *
 * It is nonetheless the first generic, non-namespaced name in this set, and the
 * risk that buys is real: a host routing `/share?share_id=<id>`, where the id
 * IS the resource and the path carries no slug, would collapse every such link
 * onto one dedup key. No publisher of that shape turned up, and every share
 * convention found keeps full identity in the path, so this is residual risk
 * rather than a known one — but it is the first entry where the name alone no
 * longer bounds it, and a host-scoped strip is the only real fix if one appears.
 *
 * `cmp`: verified 2026-08-27, to the same standard. CBC spells it `?cmp=rss` and
 * the Guardian spells it `?CMP=share_btn_url`; both outlets' pages were fetched
 * with and without it, and each declared the bare URL canonical either way, so
 * stripping it agrees with what the publisher says the document is rather than
 * with a guess from the name looking like "campaign".
 *
 * What `cmp` buys is mostly ahead of us. The CBC feeds append it to *every*
 * link, so once feed ingestion lands, the same story reaching us from a feed and
 * from Currents would otherwise canonicalize two ways and become two `articles`
 * rows — on 100% of one outlet's articles. Today only the Guardian's `?CMP=`
 * share links reach us at all, via Currents and GNews.
 *
 * `cmp` is the second generic name here, so `share_id`'s caveat above applies to
 * it unchanged, and more sharply: three letters carry less meaning than eleven,
 * and "cmp" could as easily abbreviate compare, component or consent. What
 * bounds it is that the set is exact-match, so the compound forms a content
 * selector would plausibly take — `cmpid`, `cmp_id`, `camp` — all survive
 * untouched. A bare `?cmp=` naming a document, rather than the campaign that
 * referred to it, is the shape that would break this, and none was found.
 *
 * Case-insensitivity is a property of the strip loop, not of any one entry: it
 * lowercases each key before the lookup, so every lowercase member here already
 * covers `SHARE_ID` and `Share_Id` as it does `FBCLID` — and covers the
 * Guardian's `CMP` with the same `cmp` entry that covers CBC's. Members must
 * therefore be spelled lowercase; a `"CMP"` entry could never match.
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "igshid",
  "mc_eid",
  "share_id",
  "cmp",
]);

/**
 * Canonical form of a sighting's link, used BOTH as the stored `url` and as the
 * input to `dedupKey` (ARCHITECTURE 7.4). One function, so the link a user
 * clicks and the key that collapses duplicates can never disagree — and one
 * function across providers, so the same story from two upstreams collapses onto
 * one article instead of two.
 *
 * Lowercases scheme and host (`new URL` does this), strips the fragment, removes
 * tracking parameters, and trims the trailing slash. Verified against probe data:
 * 42 unique raw URLs → 42 unique canonical URLs, so it neither over- nor
 * under-collapses on real input.
 *
 * Parameter order is deliberately NOT normalized. Sorting would collapse a
 * slightly wider set of duplicates, but the probe found no evidence upstream
 * reorders parameters, and over-collapsing merges genuinely distinct stories —
 * a worse failure than leaving one duplicate uncollapsed.
 */
export function canonicalizeUrl(raw: string): string | null {
  const withScheme = raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw.trim();

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }

  let href = url.toString();
  if (href.endsWith("?")) href = href.slice(0, -1);
  if (href.endsWith("/") && !href.endsWith("//")) href = href.slice(0, -1);
  return href;
}

/**
 * sha256 of the canonical URL, hex. Sightings sharing this are the same article
 * — re-emitted under a new id by one provider (upstream sent one link-roundup
 * page 50 times in 100 results, PROBE-FINDINGS 4) or reported by two.
 */
export function deriveDedupKey(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex");
}

/**
 * The FALLBACK article identity: sha256 of `(source domain, folded title, UTC
 * day)`, hex — or `null` when the inputs cannot carry an identity (ADR-0018).
 *
 * Here, beside `canonicalizeUrl`/`deriveDedupKey`, for the reason this module
 * already gives about those two: one function, so the identity and the thing it
 * identifies cannot disagree. An adapter that mapped a provider's wire shape to
 * a title and then derived the key somewhere else would eventually derive it
 * from a different title than the one it stored.
 *
 * ## Why a second key exists at all
 *
 * ADR-0002 made the canonical URL the whole of an article's identity, on
 * evidence that a `(title, source)` secondary key would have merged exactly one
 * pair in the probe. On the archive we now have, that is no longer true.
 * Measured read-only against production 2026-08-27, 37,077 articles collapse to
 * 36,666 of these keys: **411 rows (1.1%) are duplicates URL identity is
 * already failing to catch** — one `space.com` eclipse liveblog under six slug
 * variants, one `standard.co.uk` story under five slugs with the keywords
 * reordered, `rte.ie` and `haaretz.com` section and paywall variants of one
 * article id.
 *
 * ## Fallback, never replacement
 *
 * Ingest resolves URL key → alt key → insert (`ingestSightings`). Titles drift
 * and URLs do not, so making this the PRIMARY key would split an article whose
 * headline was edited between two emissions — a regression URL identity does not
 * have. Keeping the URL first means the URL-keyed majority behaves exactly as it
 * did, and only a URL never seen before consults this.
 *
 * ## The three ways this refuses to mint a key
 *
 * A refusal is a `null`, and a `null` alt key means the article is identified by
 * its URL alone — exactly today's behaviour. Refusing is therefore always the
 * safe direction, which is why each of these is a refusal rather than a guess:
 *
 *  - **No source domain.** The domain is what scopes the key to one newsroom;
 *    without it, two outlets running the same wire headline on the same day
 *    would collapse into one article, destroying the distinct-source signal
 *    ADR-0002 protects.
 *  - **A title the SOURCE already truncated** — one ending `...` or `…`.
 *    `hkexnews.hk` filed three distinct regulatory disclosures on 2026-08-06
 *    under titles it had itself cut to `[00232.HK] Disclosure of...`, so three
 *    filings fold to one key. Measured: 4 of the 411 rows above. Excluding them
 *    costs a handful of genuine collapses and is the right trade, because
 *    `canonicalizeUrl` above establishes over-collapsing as the worse error.
 *  - **A title that folds to nothing.** A headline of pure punctuation folds to
 *    the empty string, and every such title on one domain and day would share
 *    one key. The same reasoning as the truncation guard, for a case nobody has
 *    seen; it costs one comparison.
 *
 * ## The day bucket is UTC, and that is load-bearing
 *
 * The day comes from `published` in UTC, matching `APP_TIMEZONE=UTC`
 * (`.env.example`). **This key is therefore timezone-sensitive**: two emissions
 * of one story that straddle a UTC midnight land in different buckets and do NOT
 * fold. That is deliberate — a day bucket is what stops a domain's recurring
 * column headline ("Morning Briefing") from collapsing a month of instalments
 * into one article — and the cost is bounded and measured: 22 of the dev
 * archive's 31,752 distinct (domain, folded title) pairs recur on adjacent UTC
 * days, 18 of them one story filed twice across a midnight and 4 a genuine daily
 * desk column. Changing `APP_TIMEZONE` would silently re-key every article
 * minted afterwards while leaving history keyed the old way, so the zone is
 * fixed here rather than threaded in as a parameter.
 *
 * **UTC is not merely the configured zone, it is the measured optimum.** A
 * provider that sends a bare DATE rather than a time puts that date on a clock
 * of its own, and the obvious repair is to move this bucket to match it. It was
 * tried: over the 150 Google News sightings on the dev archive whose story
 * Currents also holds, a Pacific-day bucket takes the same-bucket share from
 * 84.7% DOWN to 78.7%, because the disagreement is two-sided — 12 pairs a day
 * early and 11 a day late — and no fixed offset can be. All 24 hourly boundaries
 * were scored and the best (03:00Z) reaches 86.0%, two pairs better than this
 * one. So the residual is repaired by widening the LOOKUP rather than the
 * bucket: see `altKeyProbe` and ADR-0022.
 *
 * ## Changing the fold is a migration, not an edit
 *
 * Keys are STORED (`articles.alt_key`) under a unique index and are never
 * recomputed. Any change to the fold below therefore splits the archive into
 * rows keyed the old way and rows keyed the new one, and the repair is a
 * migration that re-keys — the same standing cost `TOKENIZER_VERSION` carries
 * for `story_tokens`, and the reason this fold is duplicated here rather than
 * borrowed from the tokenizer's (see `foldTitleForIdentity`).
 */
export function deriveAltKey(
  domain: string | null,
  title: string,
  publishedIso: string,
): string | null {
  if (!domain) return null;

  const headline = stripOutletSuffix(collapseWhitespace(title), domain);
  // After the strip, not before: the source's own truncation sits at the end of
  // the HEADLINE, and `[00232.HK] Disclosure of... - HKEXnews` would sail past a
  // check made on the raw title.
  if (TRUNCATED_TITLE.test(headline)) return null;

  const folded = foldTitleForIdentity(headline);
  if (!folded) return null;

  const day = new Date(publishedIso);
  if (Number.isNaN(day.getTime())) return null;

  // `\n` separates the three parts, and cannot appear in any of them: a hostname
  // may not contain one, the fold below emits only letters, digits and single
  // spaces, and the day is eight digits and two dashes. So no pair of distinct
  // triples can concatenate to the same string.
  return createHash("sha256")
    .update(`${domain}\n${folded}\n${day.toISOString().slice(0, 10)}`)
    .digest("hex");
}

/**
 * The alt keys a sighting may be RESOLVED against — its own, plus the two
 * adjacent days when the provider sent a bare date instead of a time (ADR-0022).
 *
 * Only the lookup widens. `sighting.altKey` is still the one key that gets
 * STORED, and it is passed through verbatim rather than recomputed, so nothing
 * here can make an article's identity disagree with the sighting that minted it
 * — ADR-0018's rule, unchanged. The neighbours are probe-only: they are never
 * written, never indexed, and vanish the moment the lookup returns.
 *
 * ## Why the neighbours, and why exactly one day either side
 *
 * A `publishedIsDateOnly` stamp asserts a DATE (ADR-0021). The archive's own
 * timestamp for the same story is a real clock reading, usually from a different
 * newsroom's clock, and the two disagree about which calendar day the story
 * belongs to — in BOTH directions. Measured over the 150 bare-date Google News
 * sightings in the dev archive that have a same-domain, same-folded-title
 * Currents twin (plan §G6):
 *
 * ```
 * google day minus twin day     -1: 12    0: 127    +1: 11
 * ```
 *
 * So 127 of 150 fold today and 23 do not, and the 23 sit one day out on either
 * side. Widening to D-1/D/D+1 resolves **all 150**, and none of the 1,749
 * bare-date sightings measured matched articles on more than one day, so the
 * widening was never ambiguous on the archive it was measured against.
 *
 * ## Why this is not a wider day bucket
 *
 * The obvious alternative is to MOVE the fold's day boundary — key on the
 * provider's own Pacific day rather than UTC. That was measured and it is
 * WORSE: it fixes the 12 and breaks 20 more, taking the same-bucket share from
 * 84.7% to 78.7%, and it costs a whole-archive re-key of 7,232 rows to do it.
 * All 24 hourly boundaries were scored and the best of them (03:00Z) reaches
 * 86.0% — a two-pair improvement on doing nothing. ADR-0022 carries the sweep.
 * The residual is a genuine disagreement between two clocks, not a fixed offset,
 * and no boundary can remove it.
 *
 * ## What it costs, and why it is bounded
 *
 * A day bucket is what stops a domain's recurring headline ("Morning Briefing")
 * from collapsing a month of instalments into one article, so relaxing it is
 * exactly the risk this trades on. It is relaxed for bare-date sightings ONLY,
 * which is a population one provider produces, and the archive's exposure was
 * counted rather than assumed: of 31,752 distinct (domain, folded title) pairs
 * on the dev archive, **22 recur on adjacent UTC days and 4 of those are a
 * recurring desk headline** — `ft.com` "Company Announcements",
 * `winnipegfreepress.com` "AP News in Brief at 12:04 a.m. EDT", `upi.com`
 * "Directors Corner - Korea Regional Review" and a `cbc.ca` daily fire-hazard
 * bulletin. The other 18 are duplicates the day bucket is currently splitting.
 * No bare-date sighting matched any of the four.
 *
 * That exposure is ACCEPTED, not closed. `findArticle` refuses the fallback when
 * the own day matches nothing and both neighbours match different articles, but
 * that is a tie-break's replacement rather than a defence: a daily column's
 * damaging shape is ONE neighbour matching, which is also the shape all 23
 * recovered folds have, so it cannot be refused without giving the widening
 * back. Over the four desk columns above, of the 40 days where a bare-dated
 * instalment would find no own-day article, the refusal catches 2.
 */
export function altKeyProbe(sighting: Sighting): readonly string[] {
  if (sighting.altKey === null) return [];
  if (sighting.publishedIsDateOnly !== true) return [sighting.altKey];

  const at = Date.parse(sighting.published);
  if (Number.isNaN(at)) return [sighting.altKey];

  // Derived from the sighting's OWN stored fields, which is safe only because
  // every adapter derives `altKey` from exactly these three. That used to be a
  // convention held by three open-coded copies of one ordered protocol; it is
  // now `deriveArticleIdentity`, which returns `altKey` and `sourceDomain` in
  // one value the adapters spread whole. Google News' departure — it keys on
  // the PUBLISHER's domain from `<source url>`, not on its redirect's host —
  // is a named `publisherLink` parameter rather than a substituted derivation,
  // so the case this check was written to catch is now visible in the type.
  //
  // **The check stays live anyway, and the reason is what it covers that the
  // module does not.** `deriveArticleIdentity` closes the DOMAIN axis: an
  // adapter cannot key on a domain it did not store, because it never names
  // either one. It does not close the other two. `title` and `published` still
  // travel into `finalizeSighting` beside the spread rather than inside it, so
  // an adapter that stripped a headline's outlet suffix before storing it while
  // keying on the raw one would break this the same way — and that is a live
  // temptation on exactly one adapter, whose header spends a paragraph arguing
  // against stripping its titles. `altKeyProbe` also takes a `Sighting`, a
  // published cross-package type any caller can construct, rather than an
  // adapter's return value.
  //
  // So this is no longer the ONLY thing standing between a derivation departure
  // and a silent cross-newsroom fold — all three adapters now assert it over
  // their own recorded corpora, and `identity-differential.test.ts` in each
  // pins the derivations byte for byte — but it is still the last one, at one
  // sha256 in front of a lookup that costs a round trip. Failing back to the
  // single stored key is exactly the behaviour before this function existed, so
  // the degradation is a return to the old path rather than a guess.
  if (!altKeyProbeIsConsistent(sighting)) return [sighting.altKey];

  const neighbour = (offsetMs: number): string | null =>
    deriveAltKey(
      sighting.sourceDomain,
      sighting.title,
      new Date(at + offsetMs).toISOString(),
    );

  return [
    sighting.altKey,
    ...[neighbour(-ONE_DAY_MS), neighbour(ONE_DAY_MS)].filter(
      (key): key is string => key !== null && key !== sighting.altKey,
    ),
  ];
}

/**
 * Does re-deriving this sighting's alt key from its own stored fields reproduce
 * the key it carries?
 *
 * `altKeyProbe` derives the two neighbours that way, so a provider that ever
 * keyed on something it did not store would silently probe the wrong days. It
 * is called BY `altKeyProbe` on every widened lookup — three sha256s where the
 * lookup already costs a round trip — and exported so the adapters' own fixture
 * tests can assert it over real payloads, which is where a violation should be
 * caught rather than degraded around.
 *
 * That last sentence was aspirational when it was written: only Google News'
 * fixture test actually asserted it. All three do now
 * (`identity-differential.test.ts` in each adapter package, plus
 * `fixture-client.test.ts` for Google News), over 502 recorded sightings, which
 * is what makes this a test helper first and a production guard second. See
 * `altKeyProbe` for why second is not zero.
 */
export function altKeyProbeIsConsistent(sighting: Sighting): boolean {
  return (
    deriveAltKey(sighting.sourceDomain, sighting.title, sighting.published) ===
    sighting.altKey
  );
}

/** One UTC day. The unit `deriveAltKey`'s day bucket is expressed in. */
const ONE_DAY_MS = 86_400_000;

/** A title the SOURCE cut short, in either of the two spellings seen. */
const TRUNCATED_TITLE = /(\.\.\.|…)$/u;

/**
 * The title, reduced to what two spellings of one headline have in common:
 * lowercase, Latin diacritics folded onto their base letter, and every run of
 * non-alphanumerics collapsed to one space.
 *
 * Unicode-aware on purpose. An ASCII-only `[^a-z0-9]+` would fold every Arabic,
 * Chinese, Greek or Cyrillic headline to the EMPTY string, and the guard above
 * would then refuse a key for every non-Latin article — quietly turning this
 * feature off for a large part of the archive. `\p{L}\p{N}` keeps those scripts
 * whole.
 *
 * ## Why this duplicates `foldDiacritics` rather than sharing it
 *
 * `apps/api/src/headline-tokens.ts` holds the same three-line NFD fold, and
 * ADR-0004 bars parking a shared copy in `@zammy/shared`, which carries only
 * what ships to the browser. Moving it down here and importing it there would
 * work — `apps/api` already depends on this package — and it is still the wrong
 * trade, because the two folds must be free to DIVERGE. That one serves the
 * VOCABULARY: it decides what counts as the same word, it is versioned by
 * `TOKENIZER_VERSION`, and it is expected to change as the tokenizer learns.
 * This one serves IDENTITY: its output is hashed into a stored, unique-indexed
 * column, so a change to it re-keys the archive. Sharing the function would make
 * a tokenizer improvement silently re-key every article minted after it, and the
 * failure would surface as articles quietly failing to fold rather than as
 * anything that raises. Three lines is a cheap price for that independence.
 */
export function foldTitleForIdentity(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .normalize("NFC")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Peel a trailing ` - Outlet` / ` | Outlet` segment, but ONLY when the segment
 * spells the article's own `source_domain`.
 *
 * Currents ships a title as the outlet wrote its own `<title>` tag, attribution
 * and all — "Manitoba beekeepers feeling sting of potential 50 per cent tariff -
 * Winnipeg | Globalnews.ca" — and Google News appends ` - Outlet` to 100 of 101
 * items (design doc §4). Two spellings of one headline that differ only in that
 * tail must fold to one key.
 *
 * `headline-tokens.ts` faces the same problem and solves it with a SHAPE rule —
 * short, verbless, no interior function word — because, as its comment says,
 * matching the segment against `source_domain` "would be the precise rule" but
 * would have to be threaded through five call sites to get there. **Here the
 * domain is already in hand**, so this takes the precise rule at no plumbing
 * cost, and the shape rule's known blind spot ("the Globe and Mail", refused for
 * its interior `and`) does not exist.
 *
 * That matters more here than it does there. A shape rule peels a short verbless
 * tail that reads like a name, which costs two tokens on one article in the
 * tokenizer — but here it would peel "Manitoba floods - live updates" and
 * "Manitoba floods - what we know" onto ONE key, merging two genuinely different
 * same-day stories from one domain. The domain match cannot: the tail has to
 * spell the outlet.
 *
 * The comparison is loose on both sides — case, spaces and punctuation dropped,
 * a leading "the" ignored — so "The Guardian" matches `theguardian.com` and
 * "Globalnews.ca" matches `globalnews.ca`, while the domain's public suffix is
 * optional because outlets name themselves both ways. Every widening below is
 * still a claim that the segment NAMES THE DOMAIN: none of them is a similarity
 * score and none of them looks at the segment alone, because a suffix left on
 * costs one uncollapsed duplicate and a suffix wrongly taken off costs a merge.
 *
 * ## The display name does not have to SPELL the domain — four ways it can
 * ## name it instead
 *
 * The original rule was exact: `compareForm(segment)` had to be one of
 * `domainSpellings(domain)`. That is right for an outlet whose masthead IS its
 * domain stem, and it is why "The Guardian" comes off `theguardian.com`. It is
 * also why a quarter of Google News' items would not fold.
 *
 * **Measured on a corpus harvested for this** (`fixtures/google-news-source-names.tsv`,
 * 2026-08-28): 70 real storyline labels off the dev archive — the deepening
 * plane's actual work list, not invented queries — run against Google News RSS,
 * 6,008 items over 1,837 outlets. Every single one of those items ends with the
 * outlet Google named, so the whole population is attribution and there is no
 * "is this tail a headline?" question to get wrong on this provider's side.
 * 5,885 of them carry a trailing ` - Outlet` segment the delimiter split
 * reaches, and under the exact rule **26.2% of items fail to fold** (756 of
 * 2,889 on the held-out half below).
 *
 * The four rules below were chosen by splitting those 70 queries in half,
 * building against one half and measuring on the other, so nothing here is
 * fitted to the corpus it is scored on:
 *
 *     rule set                     residual   fixes
 *     exact only (the old rule)      26.2%       —
 *     + affix                        14.6%    44.2% of failures
 *     + initialism                   10.8%    58.9%
 *     + initialsPlusTail              8.0%    69.3%
 *     + affixReverse                  6.9%    73.7%
 *
 * Two further rules were built and REJECTED on the same held-out set, which is
 * the half of the experiment worth keeping: a word-permutation match (the
 * domain spelling the name's words in another order, `indiatimes.com` for "The
 * Times of India") earned **6 items**, and a hostname match (a display name that
 * is literally a host under the domain, "news.cgtn.com") earned **0** — `affix`
 * already catches every one of them. A factorial permutation search for six
 * items is not a trade.
 *
 * ## Why rules rather than the map the plan asked for
 *
 * The plan and ADR-0018 both name the fix as "a display-name-to-domain map".
 * One was built — harvested from the same build half, 301 domains and 319 names
 * — and it LOSES on held-out data: 12.1% residual against the rules' 6.9%,
 * because the failure population is a long tail. Ranked by item volume, the top
 * 100 failing outlets account for only 61% of failing items and there are 529
 * distinct failing (domain, name) pairs in 70 queries.
 *
 * The decisive argument is not the 5 points, though. **A map is a fold that
 * changes every time an outlet is added**, and this comment's last section says
 * what changing the fold costs: every stored key minted under the old map stops
 * matching, so a map is a standing commitment to re-key the archive on a
 * schedule set by whoever edits a data file. A rule that generalises is a fold
 * that can stay fixed. The map is therefore declined rather than deferred; the
 * corpus is committed so the next person can re-run the comparison rather than
 * take this paragraph's word for it.
 *
 * ## What it costs — the over-collapse side, which is the one that matters
 *
 * `canonicalizeUrl` above establishes over-collapsing as the worse error, and
 * every rule here widens what counts as an outlet name, so the cost was
 * measured the way ADR-0018 measured the positional strip: replay the whole fold
 * over the dev archive (32,279 real articles, 2026-08-28) and count how many
 * MORE rows collapse.
 *
 *     fold                       collision groups   rows absorbed
 *     exact only                        291              311
 *     all four rules                    292              312
 *     a positional strip                362              658
 *
 * **One additional merge in 32,279 articles**, and it is a real duplicate:
 * `cbc.ca` filed "How will the new tariffs hit Canada's economy? | CBC Radio"
 * and the same headline without the suffix. Against the positional strip's 347
 * extra merges — the rule ADR-0018 rejected, re-measured here at the same order
 * as the 348 it recorded.
 *
 * The Google side contributes no risk at all on the harvested corpus: 6,008 of
 * 6,008 items end with the outlet Google named, so there is no non-attribution
 * tail for a widened rule to eat.
 *
 * ## What is left, and why no rule reaches it
 *
 * 6.9% of items, 130 outlets on the held-out half. Two populations, and neither
 * is a rule's job:
 *
 *  - **Transliteration.** `chosun.com` "조선일보", `asahi.com` "朝日新聞",
 *    `sana.sy` "سانا", `mezha.net` "Межа. Новини України." — the display name
 *    and the domain are the same masthead in two scripts, and nothing short of a
 *    romanisation table connects them. A map COULD hold these, which is the one
 *    thing it does better; it holds them only for outlets already seen.
 *  - **Names with no lexical relation at all**: `wave3.com` "WAVE News",
 *    `umn.edu` "CIDRAP", `channelnewsasia.com` "CNA".
 *
 * A third population is not a fold problem and is recorded here because it looks
 * like one: 39 of 6,008 items resolve to a PUBLIC SUFFIX rather than a
 * newsroom — `org.in`, `net.ph`, `gov.ph` — because `SECOND_LEVEL_SUFFIXES`
 * below lists `co.in` and not its siblings. Those items are mis-attributed at
 * the `sourceDomain` level, before this function sees them, and fixing it moves
 * `source_domain` on existing rows. Left alone deliberately.
 *
 * ## Changing this is still a migration
 *
 * Re-measured for this change: 524 of the dev archive's 32,279 articles (1.62%)
 * compute a different key under the four rules, 1 stops being keyable, and 0
 * become keyable that were not. Those rows keep the key they were minted with
 * unless a migration re-keys them — see migration 0023, which does.
 */
function stripOutletSuffix(title: string, domain: string): string {
  const outletSpellings = domainSpellings(domain);
  let headline = title;
  // Editions nest ("- National | Globalnews.ca"), and only the site half will
  // ever match the domain — but peeling twice costs one failed comparison and
  // covers an outlet that spells itself twice.
  for (let peeled = 0; peeled < MAX_OUTLET_SEGMENTS; peeled += 1) {
    // Greedy head, so this splits on the LAST delimiter: attribution is peeled
    // from the right, one segment at a time.
    const split = /^(.*\S)\s+[|\-\u2013\u2014]\s+(\S.*)$/u.exec(headline);
    if (split === null) break;
    if (!namesTheOutlet(split[2]!, outletSpellings)) break;
    headline = split[1]!.trim();
  }
  return headline;
}

const MAX_OUTLET_SEGMENTS = 2;

/**
 * Does this trailing segment NAME the outlet whose domain these spellings are?
 *
 * Five ways, in the order they were measured (see `stripOutletSuffix`'s header
 * for the corpus and the held-out numbers). Each is a separate claim about how
 * an outlet may write itself, and each is refusable on its own if a later
 * measurement turns against it.
 */
function namesTheOutlet(segment: string, spellings: ReadonlySet<string>): boolean {
  const forms = compareForms(segment);

  // 1. EXACT — the display name IS the domain stem. "The Guardian" for
  //    `theguardian.com`, "CBC" for `cbc.ca`. The original rule, and still the
  //    one that fires most often: 73.8% of the corpus's items fold on it alone.
  for (const form of forms) if (spellings.has(form)) return true;

  const segmentWords = outletWords(segment);
  const named = segmentWords.filter((word) => !NAME_FUNCTION_WORDS.has(word));

  // 2. AFFIX — the domain stem is one END of the display name. "Toronto Star"
  //    for `thestar.com`, "Yahoo Sports" for `yahoo.com`, "Time Magazine" for
  //    `time.com`. Anchored at a boundary rather than a substring search, which
  //    is what keeps it from matching a domain stem buried mid-phrase.
  //
  //    The workhorse: 317 of the 756 held-out failures, more than the other
  //    three rules combined.
  for (const form of forms) {
    for (const spelling of spellings) {
      if (spelling.length < MIN_AFFIX) continue;
      if (form !== spelling && (form.startsWith(spelling) || form.endsWith(spelling))) return true;
    }
  }

  // 3. INITIALISM — the name's content words spell the domain. "South China
  //    Morning Post" for `scmp.com`, "Council on Foreign Relations" for
  //    `cfr.org`, "World Socialist Web Site" for `wsws.org`. Function words are
  //    dropped because a domain does not spell them: `cfr.org` is C-F-R, not
  //    C-O-F-R.
  if (named.length >= 2 && spellings.has(named.map((word) => word[0]!).join(""))) return true;

  // 4. INITIALS PLUS TAIL — the leading words abbreviate and the rest do not.
  //    "Los Angeles Times" for `latimes.com`, "New York Post" for `nypost.com`,
  //    "San Francisco Chronicle" for `sfchronicle.com`. A place name in front of
  //    a common noun, which is most of the North American local press.
  for (let cut = 1; cut < named.length; cut += 1) {
    const abbreviated =
      named.slice(0, cut).map((word) => word[0]!).join("") + named.slice(cut).join("");
    if (spellings.has(abbreviated)) return true;
  }

  // 5. AFFIX, REVERSED — the display name is one END of the domain stem, rather
  //    than the other way round. "WION" for `wionews.com`, "Globe" for
  //    `theglobeandmail.com`. Held to `MIN_REVERSE_AFFIX` characters, which is
  //    the whole of its safety: a two- or three-letter segment is a word as
  //    often as it is a masthead, and a domain stem beginning with "sun" or
  //    "post" would then eat a headline's last word. Worth 27 of 756 held-out
  //    failures — the smallest rule kept, and the first one to drop if its
  //    over-collapse cost ever stops being zero.
  for (const form of forms) {
    if (form.length < MIN_REVERSE_AFFIX) continue;
    for (const spelling of spellings) {
      if (spelling !== form && (spelling.startsWith(form) || spelling.endsWith(form))) return true;
    }
  }

  return false;
}

/** A domain stem shorter than this is a word before it is a masthead. */
const MIN_AFFIX = 3;
const MIN_REVERSE_AFFIX = 4;

/**
 * Words a domain would not spell out. Not a stopword list — it is specifically
 * the words an INITIALISM drops, and it is short on purpose: every entry is a
 * word observed inside a display name in the corpus.
 */
const NAME_FUNCTION_WORDS = new Set([
  "of", "on", "the", "and", "for", "in", "a", "an", "at", "to",
  "de", "du", "la", "le", "el",
]);

/**
 * The two spellings a segment can have, because a domain cannot carry "&" and
 * an outlet's display name can. "Sky & Telescope" is `skyandtelescope.org`, so
 * the ampersand has to be tried both as nothing and as the word.
 *
 * Two forms rather than one because the other direction exists too: an outlet
 * writing "AT&T" against `att.com` needs the ampersand DROPPED. Measured cost of
 * carrying both: zero additional merges on the dev archive.
 */
function compareForms(value: string): string[] {
  const dropped = compareForm(value);
  const spelled = compareForm(value.replaceAll("&", " and "));
  return dropped === spelled ? [dropped] : [dropped, spelled];
}

/** Lowercase letters and digits only, with a leading "the" dropped. */
function compareForm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .replaceAll(/[^\p{L}\p{N}]+/gu, "")
    .replace(/^the/, "");
}

/** A display name as words, ampersand spelled, diacritics folded. */
function outletWords(value: string): string[] {
  return value
    .replaceAll("&", " and ")
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * How an outlet might spell itself in its own headline, given its registrable
 * domain: with the public suffix ("globalnews.ca" → `globalnewsca`), without it
 * (`globalnews`), and for a third-level ccTLD, without both labels
 * ("bbc.co.uk" → `bbc`). Every form goes through `compareForm`, so a leading
 * "the" is already gone on both sides.
 */
function domainSpellings(domain: string): Set<string> {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  const spellings = new Set<string>();
  for (let drop = 0; drop < 3 && drop < labels.length; drop += 1) {
    const form = compareForm(labels.slice(0, labels.length - drop).join(""));
    if (form) spellings.add(form);
  }
  return spellings;
}

/**
 * ccTLD registries that sell at the third level, so `example.co.uk` is one
 * registrable domain rather than two labels of `co.uk`.
 *
 * Not the full Public Suffix List: pulling in a PSL dependency (and its periodic
 * data updates) buys accuracy we do not need, because this value is used for a
 * source chip in the UI and for the wordcloud's distinct-domain gate
 * (ARCHITECTURE 10.3). An error here slightly mis-groups one outlet; it cannot
 * corrupt stored data. Covers the suffixes present in probe data plus the common
 * remainder.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "net.uk", "org.uk",
  "com.au", "edu.au", "gov.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "co.nz", "co.za", "co.in", "co.il", "co.kr", "co.id", "co.th", "co.ke",
  "com.ar", "com.bd", "com.br", "com.cn", "com.co", "com.eg", "com.hk",
  "com.mx", "com.my", "com.ng", "com.pe", "com.ph", "com.pk", "com.sa",
  "com.sg", "com.tr", "com.tw", "com.ua", "com.vn",
]);

/**
 * Registrable domain of a sighting's link, for display as a source chip and as
 * the grouping key behind `df_domains` (ARCHITECTURE 10.3).
 *
 * Derived from the URL even when a provider names the outlet itself (GNews sends
 * `source.name` and `source.url`): the URL is the one field every provider
 * agrees on, and deriving from it is what lets the same story from two upstreams
 * present as one source rather than two spellings of one.
 *
 * Strips a leading `www.`, which the dedup key deliberately does not —
 * mis-grouping a source is cosmetic, whereas over-collapsing dedup keys merges
 * distinct articles.
 */
export function sourceDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  const labels = host.replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".") || null;

  const lastTwo = labels.slice(-2).join(".");
  const take = SECOND_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * `image` → `string | null`. Currents sends the literal string "None" rather
 * than null or an omitted field in roughly a quarter of sightings, and a UI that
 * renders that as a src attribute shows a broken-image icon on every fourth card.
 */
export function normalizeImage(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") return null;
  return canonicalizeUrl(trimmed);
}

export function collapseWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
