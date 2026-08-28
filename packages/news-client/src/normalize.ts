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
 * into one article — and the cost is bounded and measured: 33 articles of
 * 31,308 on the dev archive carry sightings that straddle a UTC midnight at all.
 * Changing `APP_TIMEZONE` would silently re-key every article minted afterwards
 * while leaving history keyed the old way, so the zone is fixed here rather than
 * threaded in as a parameter.
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
 * optional because outlets name themselves both ways. It is deliberately NOT
 * fuzzy beyond that: a segment that merely resembles the domain is left alone,
 * because a suffix left on costs one uncollapsed duplicate and a suffix wrongly
 * taken off costs a merge.
 *
 * ## What that refuses to strip, and when it will start to matter
 *
 * The display name has to BE the domain stem.
 *
 * **Every name below was observed in a real `<source>` element.** That property
 * is what makes the table mean anything, and an earlier version of it did not
 * have it: names were reasoned from the outlet rather than read off the wire, and
 * four of them were wrong in the same direction. Google *abbreviates* mastheads —
 * it sends "BBC", not "BBC News"; "WSJ", not "The Wall Street Journal" — so those
 * outlets fold, where the invented names said they could not. A table of names no
 * provider emits tests nothing.
 *
 * Measured on names actually observed, at two independent scales:
 *
 *     34.6% of outlets fail to fold   (194 / 561, and 56 / 162 in a second sample)
 *     30.7% of items fail to fold     (62 / 202, general-news queries)
 *
 * Item-weighted sits below outlet-weighted because high-volume outlets
 * disproportionately self-name. Which number matters depends on whether the
 * caller is counting articles or newsrooms. **The failure population is the long
 * tail, not the mastheads** — `apa.org` "American Psychological Association
 * (APA)", `biv.com` "Business in Vancouver", `asia.nikkei.com` "Nikkei Asia" —
 * which is the reverse of what the invented table implied. 13 observed outlets,
 * 9 strip and 4 do not:
 *
 *     stripped       theguardian.com  " - The Guardian"
 *     stripped       reuters.com      " - Reuters"
 *     stripped       bbc.co.uk        " - BBC"          Google abbreviates it
 *     stripped       cbc.ca           " - CBC"                  ''
 *     stripped       wsj.com          " - WSJ"                  ''
 *     NOT stripped   nytimes.com      " - The New York Times"   expands the stem
 *     NOT stripped   ft.com           " - Financial Times"      initialism domain
 *     NOT stripped   ecfr.eu          " - European Council on Foreign Relations"
 *
 * Inert while one provider supplies every title: an outlet that always appends
 * " - BBC News" folds to a stable key whether or not the tail comes off, and the
 * production measurement `deriveAltKey` cites already reflects exactly this
 * behaviour. It stops being inert as soon as TWO providers describe one article
 * and spell the outlet differently — a provider that writes the outlet's DISPLAY
 * name, where Currents ships the outlet's own `<title>` tag, would fold to a
 * different key and mint a second row, which is the failure this whole key
 * exists to prevent. The fix is a display-name-to-domain map, which needs a
 * corpus of such titles to be built against and measured on; ADR-0018 records it
 * as an accepted cost, and the plan puts it in the phase that first has one.
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
    if (!outletSpellings.has(compareForm(split[2]!))) break;
    headline = split[1]!.trim();
  }
  return headline;
}

const MAX_OUTLET_SEGMENTS = 2;

/** Lowercase letters and digits only, with a leading "the" dropped. */
function compareForm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .replaceAll(/[^\p{L}\p{N}]+/gu, "")
    .replace(/^the/, "");
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
