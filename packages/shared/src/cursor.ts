/**
 * Keyset pagination cursor: the (published, dedupKey) tuple of the last row seen.
 *
 * Keyset rather than OFFSET because articles arrive continuously — with OFFSET,
 * rows shift between requests and readers get duplicates or silent gaps. The
 * dedupKey breaks ties among the many articles sharing a timestamp, giving a
 * total order that upstream does not provide. See ARCHITECTURE 7.3.
 */
export interface Cursor {
  published: string;
  dedupKey: string;
}

const SEPARATOR = "|";

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    `${cursor.published}${SEPARATOR}${cursor.dedupKey}`,
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
  const dedupKey = decoded.slice(separatorAt + 1);

  if (!/^[0-9a-f]{64}$/.test(dedupKey)) return null;
  if (Number.isNaN(Date.parse(published))) return null;

  return { published, dedupKey };
}
