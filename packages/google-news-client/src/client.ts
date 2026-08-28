import type { NewsClient } from "@zammy/news-client";

/**
 * Google News RSS adds nothing to the shared contract.
 *
 * The GNews adapter widens `NewsClient` with `/top-headlines`; this one has
 * nothing to widen it with — the endpoint has exactly one operation. The alias
 * exists so the package still names the thing its factory returns, and so the
 * layout matches the adapter next door file for file.
 *
 * That it is a bare `NewsClient` is the point ARCHITECTURE 5.6 makes: nothing
 * above this package learns there is a new provider.
 */
export type GoogleNewsClient = NewsClient;
