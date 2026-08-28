import { describe, expect, it } from "vitest";
import { NewsSchemaError } from "@zammy/news-client";
import { parseRssFeed } from "./rss.js";
import { feed, item } from "./test-support.js";

/**
 * The reader for the one RSS dialect this adapter consumes.
 *
 * What is asserted here is the boundary between "a feed we can read partially"
 * and "not a feed at all", because those two must degrade differently: the
 * first drops items and counts them, the second throws and trips nothing
 * (ARCHITECTURE 11).
 */

/** A feed whose one item carries `raw` as its title, unescaped by the helper. */
function titled(raw: string): string {
  return feed().replace("<title>A headline - Example News</title>", `<title>${raw}</title>`);
}

describe("reading a well-formed feed", () => {
  it("pulls every field an item carries", () => {
    const parsed = parseRssFeed(feed());

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      title: "A headline - Example News",
      link: "https://news.google.com/rss/articles/CBMiK2V4YW1wbGU?oc=5",
      guid: "CBMiK2V4YW1wbGU",
      pubDate: "Thu, 20 Aug 2026 17:09:53 GMT",
      sourceUrl: "https://www.example.com",
      sourceName: "Example News",
    });
  });

  it("reads the channel language, which items do not carry", () => {
    expect(parseRssFeed(feed()).language).toBe("en-CA");
  });

  it("takes the channel title, not the one nested inside <image>", () => {
    // <image><title>Google News</title></image> sits in the same head section.
    // Reading document-wide would pick whichever came first by accident.
    expect(parseRssFeed(feed()).title).toBe('"test" - Google News');
  });

  it("keeps the copyright element, which is where the licence restriction lives", () => {
    expect(parseRssFeed(feed()).copyright).toContain("Google");
  });

  it("decodes entities, including the &nbsp; Google puts in descriptions", () => {
    // Written as raw XML rather than through `item()`, which escapes what it is
    // given — the point here is what arrives on the wire already escaped.
    const parsed = parseRssFeed(
      titled("Ben &amp; Jerry&#39;s &lt;q&gt;&nbsp;split"),
    );

    // A real U+00A0, not an ordinary space — `collapseWhitespace` folds it
    // downstream, and turning it into a space here would be this reader
    // quietly editing the headline.
    expect(parsed.items[0]!.title).toBe("Ben & Jerry's <q>\u00a0split");
  });

  it("leaves an entity it does not know exactly as it arrived", () => {
    // Guessing at an unknown entity is a silent edit to a title that G1's
    // alt_key will later fold on. A stray ampersand is only cosmetic.
    expect(parseRssFeed(titled("AT&hellip;T deal")).items[0]!.title).toBe(
      "AT&hellip;T deal",
    );
  });

  it("unwraps CDATA without decoding what is inside it", () => {
    // Google does not emit CDATA. Handled anyway because reading it as text
    // would prepend the literal "<![CDATA[" to a headline.
    const xml = feed().replace(
      "<title>A headline - Example News</title>",
      "<title><![CDATA[Raw & <b>bold</b>]]></title>",
    );

    expect(parseRssFeed(xml).items[0]!.title).toBe("Raw & <b>bold</b>");
  });

  it("does not mistake markup inside an escaped description for elements", () => {
    // <description> is an entity-escaped <a href> blob. If the reader treated
    // it as markup, the anchor's own text would leak into neighbouring fields.
    const parsed = parseRssFeed(feed());

    expect(parsed.items[0]!.description).toContain("<a href=");
    expect(parsed.items[0]!.title).toBe("A headline - Example News");
  });
});

describe("degrading on partial input", () => {
  it("keeps the items that are complete and reports the rest as missing fields", () => {
    // A truncated feed is the realistic failure, and it must not throw: the
    // items that did arrive are real observations, and the loss belongs in the
    // drop accounting rather than in an exception.
    const truncated = feed([item(), item({ title: "Second - Example News" })]).replace(
      "</channel></rss>",
      "",
    );
    const parsed = parseRssFeed(truncated);

    expect(parsed.items).toHaveLength(2);
  });

  it("drops an item cut off mid-element rather than inventing its fields", () => {
    const cut = feed([item()]).replace("</item></channel></rss>", "");
    const parsed = parseRssFeed(cut);

    // No closing </item>, so there is no complete item to read. The caller sees
    // an empty window, which is honest; a partial item would not be.
    expect(parsed.items).toHaveLength(0);
  });

  it("returns nulls, not empty strings, for elements an item omits", () => {
    const parsed = parseRssFeed(feed([item({ pubDate: null, sourceUrl: null })]));

    expect(parsed.items[0]!.pubDate).toBeNull();
    expect(parsed.items[0]!.sourceUrl).toBeNull();
  });

  it("reads a feed with no items at all as an empty window", () => {
    expect(parseRssFeed(feed([])).items).toEqual([]);
  });
});

describe("a body that is not a feed", () => {
  it("throws a schema error, the way the transport's JSON default does", () => {
    // A 200 carrying an HTML block page is an intercepting proxy, not a fault
    // to retry — the same reading `safeJson` gives a 200 that is not JSON.
    expect(() => parseRssFeed("<!doctype html><html><body>Sorry…</body></html>")).toThrow(
      NewsSchemaError,
    );
  });

  it("throws on an empty body", () => {
    expect(() => parseRssFeed("")).toThrow(NewsSchemaError);
  });
});
