import type { CallOpts, NewsClient, SearchResult } from "@zammy/news-client";
import type { TopHeadlinesParams } from "./raw.js";

/**
 * What GNews can do that every provider cannot (ARCHITECTURE 5.1).
 *
 * The shared contract — `search`, `limits`, `quota`, `close` — is `NewsClient`.
 * This adds `/top-headlines`, GNews's answer to the §10.1 breadth sample, whose
 * category taxonomy is its own and shares no values with the Currents v2 list.
 */
export interface GnewsClient extends NewsClient {
  /** `/top-headlines` — trending articles by Google News ranking. */
  topHeadlines(params?: TopHeadlinesParams, opts?: CallOpts): Promise<SearchResult>;
}
