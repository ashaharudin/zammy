import type { Article } from "@zammy/shared";

/**
 * Rows for the related-articles disclosure (§14.3): word-identical syndication
 * copies fold into one row, and the row names every outlet that printed it.
 */

/**
 * Fold word-identical titles into one row carrying every copy. First
 * occurrence fronts the row (`article`, also `copies[0]`) — articles arrive
 * newest first, so the row shows the latest copy — and the fold is by exact
 * title: near-identical wire variants stay separate rows, which is honest
 * about what the outlets actually printed.
 *
 * Every folded article stays in `copies`: the row renders each outlet as a
 * link to that outlet's own copy, and the disclosure's "+N more" tally counts
 * articles, not rows.
 */
export function collapseCopies(articles: Article[]): { article: Article; copies: Article[] }[] {
  const rows: { article: Article; copies: Article[] }[] = [];
  const byTitle = new Map<string, number>();
  for (const article of articles) {
    const index = byTitle.get(article.title);
    if (index === undefined) {
      byTitle.set(article.title, rows.length);
      rows.push({ article, copies: [article] });
    } else {
      rows[index]!.copies.push(article);
    }
  }
  return rows;
}

/**
 * A row's outlets, one link per source rather than a "×N outlets" count that
 * hides them: fold the copies by source domain — falling back to the URL's
 * host for the odd article upstream sent without one — each labelled source
 * linking to that outlet's own copy. First occurrence wins, so a source that
 * printed the story twice links to its newest copy.
 */
export function outletLinks(copies: Article[]): { label: string; article: Article }[] {
  const links: { label: string; article: Article }[] = [];
  const seen = new Set<string>();
  for (const article of copies) {
    const label = article.sourceDomain ?? new URL(article.url).hostname;
    if (seen.has(label)) continue;
    seen.add(label);
    links.push({ label, article });
  }
  return links;
}
