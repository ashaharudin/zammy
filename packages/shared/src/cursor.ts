/**
 * Keyset pagination cursor: the `(published, articleId)` tuple of the last article seen.
 *
 * Keyset rather than OFFSET because articles arrive continuously — with OFFSET,
 * rows shift between requests and readers get duplicates or silent gaps. The
 * article id breaks ties among the many articles sharing a timestamp, giving a
 * total order that upstream does not provide. See ARCHITECTURE 7.3.
 *
 * The id half is the article's surrogate key, not its URL hash. That is what keeps
 * a cursor valid when URL canonicalization rules widen (ADR-0002).
 */
export interface Cursor {
  published: string;
  articleId: string;
}

const SEPARATOR = "|";

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    `${cursor.published}${SEPARATOR}${cursor.articleId}`,
    "utf8",
  ).toString("base64url");
}

/** Returns null for anything malformed — a bad cursor is a bad request, not a crash. */
export function decodeCursor(encoded: string): Cursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separatorAt = decoded.indexOf(SEPARATOR);
  if (separatorAt === -1) return null;

  const published = decoded.slice(0, separatorAt);
  const articleId = decoded.slice(separatorAt + 1);

  if (!/^\d+$/.test(articleId)) return null;
  if (Number.isNaN(Date.parse(published))) return null;

  return { published, articleId };
}
