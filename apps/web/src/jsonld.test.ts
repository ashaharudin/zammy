import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The landing page's `WebSite` + `SearchAction` JSON-LD (`docs/SEO.md`, "What
 * comes next" 1) — the other half of the tier this repo shipped alongside
 * `render-storyline.ts`'s per-storyline `CollectionPage` + `ItemList`.
 *
 * Static, hand-written markup in `apps/web/index.html` rather than anything
 * built by code: every value in it is a constant this file already owns (the
 * site's own name and origin), so unlike the storyline page there is no
 * upstream text to escape and nothing here that could regress the way
 * `render-storyline.test.ts`'s `</script>` regression test worries about.
 * What CAN regress is the shape silently drifting out of sync with what
 * `route.ts` actually reads — this file is the check for that, in the same
 * spirit `llms-txt.test.ts` and `cron-routes.test.ts` already established:
 * assert the claim, don't just read the prose next to it.
 */
const html = readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  "utf8",
);

/** Comments stripped first, for the reason `railAnnouncer.test.ts` already
 * gives: a comment describing this block sits directly above it, and an HTML
 * comment containing a lookalike tag would satisfy every assertion below
 * while the real script sat broken underneath it. */
const markup = html.replace(/<!--[\s\S]*?-->/g, "");

function readJsonLdBlocks(): unknown[] {
  return [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!),
  );
}

describe("apps/web/index.html's WebSite + SearchAction JSON-LD", () => {
  it("carries exactly one JSON-LD block", () => {
    // At least one rather than none would leave this whole file testing
    // nothing; more than one is a duplicate nobody meant to add.
    expect(readJsonLdBlocks()).toHaveLength(1);
  });

  it("declares a WebSite at the canonical origin", () => {
    const [jsonLd] = readJsonLdBlocks() as [{ "@context": string; "@type": string; url: string }];
    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("WebSite");
    // The same origin the canonical, OG tags and `render-storyline.ts`'s
    // `SITE_ORIGIN` already agree on — see that file's own comment on why
    // this string is not a knob any one of them gets to invent alone.
    expect(jsonLd.url).toBe("https://www.zammy.info/");
  });

  it("gives the WebSite the @id the storyline pages point their isPartOf at", () => {
    // This file is the TEMPLATE `render-storyline.ts` renders storyline pages
    // from, so every storyline page carries this block AND its own
    // `CollectionPage` whose `isPartOf` names this id. Two nodes for one site
    // is what a mismatch here silently produces — both scripts still valid,
    // both still parsing, describing a site that appears to be two.
    //
    // The expected value is retyped rather than imported: `@zammy/api` is not
    // a dependency of `@zammy/web` and must not become one for a test. The
    // pairing is asserted from the API side too, where `WEBSITE_ID` IS the
    // real constant — see `render-storyline.test.ts`.
    const [jsonLd] = readJsonLdBlocks() as [{ "@id": string }];
    expect(jsonLd["@id"]).toBe("https://www.zammy.info/#website");
  });

  it("targets a SearchAction at the query parameter route.ts actually reads", () => {
    const [jsonLd] = readJsonLdBlocks() as [
      { potentialAction: { "@type": string; target: string; "query-input": string } },
    ];
    const action = jsonLd.potentialAction;
    expect(action["@type"]).toBe("SearchAction");
    // `route.ts`'s `parseRoute` reads the search term from `q` — the search
    // is a query parameter on `/`, not a route of its own (`docs/SEO.md`), so
    // the target names that parameter with the `{search_term_string}`
    // placeholder Google's SearchAction spec requires rather than a path.
    expect(action.target).toBe("https://www.zammy.info/?q={search_term_string}");
    // `query-input` names the SAME placeholder used in `target`; a search
    // engine matches the two by name, and a rename in one place without the
    // other silently breaks the box while every other assertion still passes.
    const placeholder = /\{([a-zA-Z0-9_]+)\}/.exec(action.target)?.[1];
    expect(placeholder).toBeDefined();
    expect(action["query-input"]).toBe(`required name=${placeholder}`);
  });
});
