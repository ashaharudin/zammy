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
 *
 * By title WITHIN a piece, which is the narrower of the two folds `Article.groupId`
 * now makes possible. The cut asks "is this one piece" and a group id is the whole
 * truth of it (`format.ts`, `railSlots`); a row asks "did these outlets print the
 * same words", which a group id is NOT the truth of — one group is one piece under
 * several outlets' own headlines, so folding a whole group into one row would hide
 * every variant but the first behind a title none of the others ran.
 *
 * Neither signal alone is right, and title alone was wrong in the direction this
 * whole change exists to fix: a bucket holds every group whose anchor landed in the
 * same part of the day, so two genuinely different pieces colliding on a low-token
 * headline ("The Latest", "Live updates") folded into one row that claimed they were
 * one piece. Group first, then title, keeps variants visible and distinct pieces
 * apart.
 */
export function collapseCopies(articles: Article[]): { article: Article; copies: Article[] }[] {
  const rows: { article: Article; copies: Article[] }[] = [];
  // `groupId` is a decimal string, so the first colon is unambiguously the
  // separator however the title is punctuated.
  const byPiece = new Map<string, number>();
  for (const article of articles) {
    const key = `${article.groupId}:${article.title}`;
    const index = byPiece.get(key);
    if (index === undefined) {
      byPiece.set(key, rows.length);
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
