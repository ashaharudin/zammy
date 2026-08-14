/**
 * Keyset pagination cursor: the `(published, id)` tuple of the last timeline
 * slot seen — a GROUP's position and identity (§14.3).
 *
 * Keyset rather than OFFSET because articles arrive continuously — with OFFSET,
 * rows shift between requests and readers get duplicates or silent gaps. The
 * id breaks ties among the many slots sharing a timestamp, giving a total order
 * that upstream does not provide. See ARCHITECTURE 7.3.
 *
 * The id half is an article's surrogate key — the group's seed — never a URL
 * hash. That is what keeps a cursor valid when URL canonicalization rules widen
 * (ADR-0002). An ungrouped article is a group of one whose seed is itself, so
 * cursors minted before grouping existed still resolve.
 */
export interface Cursor {
  published: string;
  /**
   * The seed article's id, which is the group's id. Named for the article
   * because that is what it is and what makes it stable; the field predates
   * grouping and renaming it would break every cursor in flight.
   *
   * Under STORYLINES_V2 it holds a storyline UUID instead: the keyset axis
   * becomes `(day_slot_published, storyline_id)` and the id half is whatever
   * identifies a slot in the generation that minted the cursor (ADR-0011). The
   * name stays wrong in the same useful way it already was.
   */
  articleId: string;
}

/**
 * A bigint id (v1 slots) or a UUID (v2 storylines). Anything else is a
 * malformed cursor: both halves reach SQL as a typed comparison, so a value
 * that is neither would be a 500 rather than an empty page.
 */
const SLOT_ID = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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

  if (!SLOT_ID.test(articleId)) return null;
  if (Number.isNaN(Date.parse(published))) return null;

  return { published, articleId };
}
