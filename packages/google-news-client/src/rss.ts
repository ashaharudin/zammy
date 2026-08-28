import { NewsSchemaError } from "@zammy/news-client";

/**
 * A reader for the one RSS dialect this adapter consumes.
 *
 * It exists because Google News is the first upstream here that does not answer
 * in JSON, and it is deliberately *not* a general XML parser. A dependency was
 * considered and declined on the same grounds `sourceDomain` declines the Public
 * Suffix List: the accuracy a real parser buys is accuracy over documents we
 * never receive. Every byte this reads comes from one generator — `NFE/5.0`,
 * named in the feed's own `<generator>` — emitting a fixed element set with no
 * namespaces on the elements we want, no attributes beyond `<source url>` and
 * `<guid isPermaLink>`, and every `<` and `&` in text escaped as an entity.
 *
 * What that buys, and what it costs, stated so the next person can judge it:
 *
 *   - It cannot be confused by markup inside text, because a conformant
 *     producer cannot emit an unescaped `<` there — and `<description>` proves
 *     the point, arriving as an entity-escaped `<a href>` blob rather than as
 *     child elements.
 *   - CDATA is handled even though Google does not use it, because it is the
 *     one common RSS construct that would otherwise be read as literal text.
 *   - It has no opinion about anything else: comments, processing instructions
 *     and nested elements inside an item are simply not looked for.
 *
 * **If a second RSS provider is ever added, replace this with a real parser
 * rather than widening it.** The moment the producer stops being a single known
 * one, every simplification above turns from a stated limit into a latent bug.
 *
 * Partial input degrades rather than throwing: a truncated feed yields the
 * items that were complete, and the caller drops the rest through
 * `normalizeBatch` where the loss is counted (ARCHITECTURE 11). Only a body
 * that is not a feed at all throws, mirroring what the transport's JSON default
 * does with a block page.
 */

export interface RssItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  pubDate: string | null;
  description: string | null;
  /** `<source url="…">Name</source>` — the publisher, which `<link>` hides. */
  sourceUrl: string | null;
  sourceName: string | null;
}

export interface RssFeed {
  /** Channel-level `<language>`, e.g. `en-CA`. Items carry none of their own. */
  language: string | null;
  title: string | null;
  /**
   * Channel-level `<copyright>`, kept verbatim. Google's names this feed as
   * being for "personal, non-commercial use" — a restriction that lives in the
   * payload rather than in a terms page, exactly as CBC's "FOR PERSONAL USE
   * ONLY" does (RESEARCH-FREE-NEWS-SOURCES §5). Parsed so it is visible in
   * `sightings.raw` rather than discarded at the boundary.
   */
  copyright: string | null;
  items: RssItem[];
}

/** Enough of a feed to be worth reading. Anything else is a block page. */
const FEED_MARKER = /<rss[\s>]|<feed[\s>]|<channel[\s>]/i;

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

export function parseRssFeed(xml: string): RssFeed {
  if (!FEED_MARKER.test(xml)) {
    throw new NewsSchemaError(
      "upstream returned a 200 with a body that is not an RSS feed; " +
        "this is usually an intercepting proxy or a block page",
    );
  }

  // Channel-level fields are read from the head of the document, before the
  // first `<item>`. Every one of them has a same-named element inside items or
  // inside `<image>`, so reading them document-wide would pick up the wrong one.
  const firstItem = xml.search(/<item\b/i);
  const head = firstItem === -1 ? xml : xml.slice(0, firstItem);

  const items: RssItem[] = [];
  for (const match of xml.matchAll(ITEM_RE)) {
    items.push(parseItem(match[1] ?? ""));
  }

  return {
    language: element(head, "language"),
    title: element(head, "title"),
    copyright: element(head, "copyright"),
    items,
  };
}

function parseItem(inner: string): RssItem {
  const source = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(inner);
  return {
    title: element(inner, "title"),
    link: element(inner, "link"),
    guid: element(inner, "guid"),
    pubDate: element(inner, "pubDate"),
    description: element(inner, "description"),
    sourceUrl: source ? attribute(source[1] ?? "", "url") : null,
    sourceName: source ? text(source[2] ?? "") : null,
  };
}

/** First `<name>…</name>` in `scope`, decoded. Null when absent or empty. */
function element(scope: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(scope);
  return match ? text(match[1] ?? "") : null;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const raw = match?.[2] ?? match?.[3];
  return raw === undefined ? null : decodeEntities(raw).trim() || null;
}

function text(raw: string): string | null {
  // CDATA first: its contents are literal, so entity decoding must not touch
  // them. Google does not emit CDATA, but reading it as text would silently
  // prepend `<![CDATA[` to a title if it ever started.
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decoded = decodeEntities(unwrapped).trim();
  return decoded || null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Escaped, not typed: a literal U+00A0 in source is invisible and one stray
  // editor pass from becoming an ordinary space.
  nbsp: "\u00a0",
};

/**
 * XML's five predefined entities plus `&nbsp;` and numeric references.
 *
 * `&nbsp;` is not XML — it is HTML — but Google emits it inside `<description>`
 * and inside the occasional title, so leaving it undecoded would put the
 * literal text `&nbsp;` into a headline. Anything else unrecognised is left
 * exactly as it arrived: a stray `&` in a headline is a cosmetic flaw, whereas
 * guessing at an entity we do not know is a silent edit to a title that
 * `alt_key` (G1) will later fold on.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const codePoint = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return whole;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
