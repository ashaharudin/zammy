import { contentTokens } from "./term-scoring.js";
import { singular } from "./grouping.js";

/**
 * `story_tokens`: the distinct, singularized content tokens of an article's
 * title AND description together.
 *
 * Title and description both, because the storyline layer exists precisely to
 * catch coverage whose HEADLINES diverge — the angle piece that names the story
 * only in its description. Through the same tokenizer and stemmer as grouping,
 * so the two layers cannot disagree about what a word is.
 *
 * All that is left of this file. It once also held the day-bounded storyline's
 * decision — day-relative df, hub-and-spoke clustering, the anchor and mass
 * over a single day's corpus — which ADR-0011 replaced and migration 0012
 * removed. The tokens outlived it: they are the LINKER's input now, and
 * `story_tokens` in storage is a materialized derivation of exactly this.
 */
export function storyTokens(title: string, description: string | null): string[] {
  return [...new Set(contentTokens(`${title} ${description ?? ""}`).map(singular))];
}
