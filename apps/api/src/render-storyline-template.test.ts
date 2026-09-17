import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEAD_CLOSE_TAG, HEAD_FIELDS, ROOT_DIV, WEBSITE_ID } from "./render-storyline.js";

/**
 * The half of the storyline page that is not TypeScript.
 *
 * `render-storyline.ts` rewrites a template by matching tags in it, and
 * `render-storyline.test.ts` drives that rewriting through a synthetic template
 * declared in that file. That is the right way to test the rewriting and it
 * proves nothing whatsoever about the template actually shipped: the synthetic
 * one matches every pattern because it was written to, so it would keep passing
 * on the day the real one stopped.
 *
 * And "stopped" is silent. `setAttr` leaves a tag it cannot find untouched and
 * `injectBody` leaves a `#root` it cannot find empty — deliberately, since a
 * 500 on every storyline is a worse way to notice drift — so the failure mode
 * is a page that is served, looks structurally fine, and carries the site-wide
 * title with an empty body. Which is exactly the thing this whole feature
 * exists to stop a crawler receiving.
 *
 * Read off `apps/web/index.html`, the SOURCE, not `dist`: the tags live in the
 * source, Vite only ADDS its own script and link tags to the head, and this
 * suite has no business requiring `apps/web` to have been built first.
 *
 * `HEAD_FIELDS` and `ROOT_DIV` are IMPORTED, never retyped. A copy here would
 * make this a check of the copy — the same trap `railAnnouncer.test.ts` names
 * in its own comment about `RAIL_STATUS_ID`.
 */
const html = readFileSync(
  fileURLToPath(new URL("../../web/index.html", import.meta.url)),
  "utf8",
);

/**
 * Comments stripped before matching, for `railAnnouncer.test.ts`'s reason: the
 * head of that file carries a long comment ABOUT the canonical tag, and a
 * comment containing a lookalike tag would satisfy every assertion below while
 * the real tag sat missing underneath it.
 */
const markup = html.replace(/<!--[\s\S]*?-->/g, "");

function occurrences(pattern: RegExp): string[] {
  return [...markup.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((m) => m[0]);
}

describe("apps/web/index.html, as render-storyline.ts expects to find it", () => {
  it.each(HEAD_FIELDS.map((field) => [field.name, field] as const))(
    "carries exactly one tag for %s",
    (_name, field) => {
      // Exactly one rather than at least one: `String.replace` with a
      // non-global pattern rewrites the FIRST match, so a second copy is a tag
      // that looks maintained and is not.
      expect(occurrences(field.tag)).toHaveLength(1);
    },
  );

  it.each(
    HEAD_FIELDS.filter((field) => field.attr !== null).map((field) => [field.name, field] as const),
  )("gives %s the attribute setAttr rewrites", (_name, field) => {
    // The subtle half. `setAttr` finds the tag, then looks for `attr="..."`
    // INSIDE it and returns the tag untouched when it is absent — so a tag
    // that matches with its attribute renamed passes the check above and still
    // never updates.
    // Same leading `\s` as `setAttr` uses, and for the same reason: without it
    // this passes on a `data-href="…"` that `setAttr` would then rewrite in
    // place, which is a check that reports the opposite of the truth.
    const [tag] = occurrences(field.tag);
    expect(tag).toMatch(new RegExp(`(?<=\\s)${field.attr}="[^"]*"`));
  });

  it("carries the empty #root injectBody writes into, spelled exactly", () => {
    // An exact string, not a pattern: `injectBody` matches this literal. A
    // class, an attribute, or a space added to the real tag would leave every
    // storyline page with an empty body and every other test green.
    expect(markup).toContain(ROOT_DIV);
  });

  it("carries the same WebSite @id the storyline pages reference", () => {
    // The pairing that makes two ld+json blocks describe ONE site. This file
    // is the template `render-storyline.ts` renders from, so a storyline page
    // carries the static `WebSite` below AND a `CollectionPage` whose
    // `isPartOf` points at `WEBSITE_ID`. A mismatch leaves both scripts valid,
    // both parsing, and the site described twice as two different things —
    // which is why it is asserted here, against the REAL constant, rather
    // than trusted to two hand-typed strings staying equal.
    expect(markup).toContain(`"@id": "${WEBSITE_ID}"`);
  });

  it("closes its head exactly once, where injectJsonLd writes the structured data", () => {
    // Exactly once for the same reason every `HEAD_FIELDS` check above is
    // exact rather than "at least": `String.replace` with a non-global
    // pattern rewrites the FIRST match, so a second `</head>` earlier in the
    // document — inside a conditional comment, say — would catch the JSON-LD
    // script and leave the real head without it.
    expect(occurrences(new RegExp(HEAD_CLOSE_TAG))).toHaveLength(1);
  });
});
