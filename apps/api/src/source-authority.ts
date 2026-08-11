/**
 * Which member of a group holds the headline (ARCHITECTURE 14.3).
 *
 * **This list is an editorial stance living in the codebase.** It says whose
 * headline a reader sees first when several outlets carry one story, and no
 * amount of engineering makes that a neutral decision. It is checked in and
 * reviewed for exactly that reason, following `stopwords.ts`.
 *
 * It is also **Anglophone**. On a Spanish, Arabic or Vietnamese timeline no
 * member is tier 1 and selection silently falls back to earliest published —
 * which is a sane rule, but it means this feature does more for English
 * readers than for anyone else. Adding a tier-1 outlet for another language is
 * a deliberate editorial act, not a bug fix.
 *
 * **Two tiers, not a ranking.** A total ordering of outlets would mean
 * adjudicating Reuters against AFP — unmaintainable and indefensible. Tier 1
 * is "a wire service, a major public broadcaster, or a newspaper of record";
 * everything else is tier 2, and within a tier nothing distinguishes one outlet
 * from another. The membership test is the only thing that has to be
 * defensible, so keep it that coarse — an outlet you would have to argue for
 * is an outlet that belongs in tier 2.
 */

/**
 * Registrable domains, as `sourceDomain()` in the normalizer produces them
 * (lowercase, `www.` stripped, second-level ccTLD suffixes kept whole).
 *
 * Entries must be registrable domains that belong to ONE outlet. That rules
 * out otherwise-obvious names: `abcnews.go.com` reduces to `go.com`, which
 * would tier every site Disney hosts, so ABC News is absent rather than
 * approximated.
 */
export const TIER_1_SOURCES: ReadonlySet<string> = new Set([
  // Wire services.
  "apnews.com",
  "reuters.com",
  "afp.com",
  "pa.media",
  // Public broadcasters.
  "bbc.com",
  "bbc.co.uk",
  "cbc.ca",
  "npr.org",
  "pbs.org",
  "abc.net.au",
  "rte.ie",
  "dw.com",
  "france24.com",
  "aljazeera.com",
  // Newspapers of record.
  "nytimes.com",
  "washingtonpost.com",
  "wsj.com",
  "ft.com",
  "theguardian.com",
  "economist.com",
  "thetimes.co.uk",
  "telegraph.co.uk",
  "globeandmail.com",
  "scmp.com",
  "bloomberg.com",
]);

export function isTier1(sourceDomain: string | null): boolean {
  return sourceDomain !== null && TIER_1_SOURCES.has(sourceDomain);
}

/** The fields selection needs. Deliberately not `sightingCount` — see below. */
export interface Attributable {
  id: string;
  sourceDomain: string | null;
  /** ISO-8601, the article's earliest sighting (ADR-0002). */
  published: string;
}

/**
 * The group's headline: **any** tier-1 member, tie-broken by earliest
 * published then `id`; with no tier-1 member, earliest published wins.
 *
 * Two things this must never consider:
 *
 *  - **`sighting_count`.** It measures upstream re-emission, not importance —
 *    one link-roundup page arrived 50 times (PROBE-FINDINGS 4) — so ranking by
 *    it would promote exactly what the §7.4 collapse exists to neutralise. It
 *    is not in `Attributable` so that reaching for it is a type error, not a
 *    judgement call.
 *  - **The group's position.** Authority is a property of the domain and time
 *    is not, so a later tier-1 article changes the headline IN PLACE; the
 *    group stays where its earliest member put it (§14.3, §7.3 keyset).
 *
 * `id` is a decimal string over a bigint column, so the tie-break compares
 * BigInt — `"10" < "9"` as strings would invert it.
 */
export function chooseRepresentative<T extends Attributable>(members: readonly T[]): T {
  const first = members[0];
  if (first === undefined) {
    throw new Error("a group always has at least one member");
  }

  let best = first;
  for (const member of members.slice(1)) {
    if (outranks(member, best)) best = member;
  }
  return best;
}

function outranks(candidate: Attributable, incumbent: Attributable): boolean {
  const tiered = isTier1(candidate.sourceDomain);
  if (tiered !== isTier1(incumbent.sourceDomain)) return tiered;

  const byTime = Date.parse(candidate.published) - Date.parse(incumbent.published);
  if (byTime !== 0) return byTime < 0;

  return BigInt(candidate.id) < BigInt(incumbent.id);
}
