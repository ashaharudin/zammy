import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveAltKey, sourceDomain } from "./normalize.js";

/**
 * The outlet-suffix fold, scored against the corpus it was built on.
 *
 * `stripOutletSuffix`'s header carries the experiment; this is the part of it
 * that has to keep passing. It reads `fixtures/google-news-source-names.tsv` —
 * every distinct `<source url>` / display-name pair Google News emitted across
 * 70 real storyline labels, weighted by how many of the 6,008 items carried it
 * — and asserts the fold's ITEM-WEIGHTED coverage.
 *
 * **Why a threshold rather than a golden number.** The corpus is a snapshot of
 * what one provider emitted on one day, and outlets rename themselves; an exact
 * assertion would fail for reasons that say nothing about this code. What must
 * not silently move is the direction. Scored exactly as this test scores it —
 * every pair against a synthetic headline, so the number here is the FOLD's and
 * not the corpus's own title shapes:
 *
 *     exact match alone (the old rule)   74.1% of items, 69.2% of pairs
 *     the four rules                     92.1% of items, 88.2% of pairs
 *
 * The floor sits between them with room for drift. A regression that put the
 * exact rule back reads 74.1% and fails loudly.
 *
 * (Against the corpus's REAL titles rather than a synthetic one the fold does a
 * little better — 93.3% of items — because a title whose tail Google split
 * across two segments gets two peels. `stripOutletSuffix` quotes that figure;
 * this file quotes its own.)
 *
 * Item-weighted rather than pair-weighted deliberately, and the two differ a
 * long way, because high-volume outlets disproportionately self-name. What a
 * duplicate costs is a row, and rows come from items.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/google-news-source-names.tsv",
);

interface Pair {
  domain: string;
  name: string;
  items: number;
}

function readCorpus(): Pair[] {
  const pairs: Pair[] = [];
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [url, name, items] = line.split("\t");
    if (!url || !name || !items) continue;
    const domain = sourceDomain(url);
    // `sourceDomain` refuses nothing in this corpus today. Skipped rather than
    // asserted so a future public-suffix change to that function cannot fail
    // this test for a reason that has nothing to do with the fold.
    if (!domain) continue;
    pairs.push({ domain, name, items: Number(items) });
  }
  return pairs;
}

/**
 * The floor, item-weighted. Shipped coverage is 92.1% under this test's own
 * scoring, and 0.9 sits close enough beneath it to catch a lost rule: the affix
 * rule alone accounts for 317 of the 756 held-out failures the four rules fix,
 * which is eleven points of items. Far enough above the exact rule's 74.1% that
 * no partial regression squeaks through either.
 */
const MIN_ITEM_COVERAGE = 0.9;

describe("the outlet-suffix fold, against the harvested Google News corpus", () => {
  const DAY = "2026-08-28T09:00:00.000Z";
  const HEADLINE = "Ferry service suspended after storm damage";

  const folds = (pair: Pair): boolean =>
    deriveAltKey(pair.domain, `${HEADLINE} - ${pair.name}`, DAY) ===
    deriveAltKey(pair.domain, HEADLINE, DAY);

  it("folds at least nine in ten items' worth of display names", () => {
    const corpus = readCorpus();
    // A sanity floor on the corpus itself: a truncated or mis-parsed fixture
    // would otherwise pass the real assertion vacuously.
    expect(corpus.length).toBeGreaterThan(1_500);

    let folded = 0;
    let total = 0;
    for (const pair of corpus) {
      total += pair.items;
      if (folds(pair)) folded += pair.items;
    }
    expect(total).toBeGreaterThan(5_000);
    expect(folded / total).toBeGreaterThan(MIN_ITEM_COVERAGE);
  });

  it("does not fold a display name onto the WRONG domain", () => {
    // The cost side, over the same corpus: every pair's display name tried
    // against a domain that is not its own. A rule that had drifted into a
    // similarity score would light this up, and no per-case assertion could.
    //
    // Zero is not the expectation and would be the wrong bar — outlets share
    // stems, and `bbc.co.uk` legitimately answers to a name `bbc.com` also
    // answers to. What this pins is that a name matches a HANDFUL of domains
    // rather than a broad slice of them.
    const corpus = readCorpus().slice(0, 300);
    const domains = [...new Set(corpus.map((pair) => pair.domain))];
    let crossMatches = 0;
    for (const pair of corpus) {
      for (const domain of domains) {
        if (domain === pair.domain) continue;
        if (folds({ ...pair, domain })) crossMatches += 1;
      }
    }
    // Measured at 88 of 87,600 pairings — 0.100% — on the shipped rules. The
    // bar is five times that, so this fails on a change of kind rather than on
    // corpus drift.
    expect(crossMatches / (corpus.length * (domains.length - 1))).toBeLessThan(0.005);
  });
});
