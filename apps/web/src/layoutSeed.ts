/**
 * The d3-cloud placement seed (ARCHITECTURE 10.5).
 *
 * Language alone. The seed used to be `(day, language)`, which was stable
 * because a day was; a rolling window ends at `now` and so changes on every
 * response (ADR-0008). Anything derived from the window — `windowEnd`,
 * `meta.asOf` — would re-seed the layout on each poll and throw the whole
 * board around while the reader is looking at it. The words that move should
 * move because the news moved.
 */
export function layoutSeed(response: { language: string }): string {
  return `cloud:${response.language}`;
}
