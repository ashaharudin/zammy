import { z } from "zod";
import { isStorylineView, TimelinePage, TrendingResponse } from "@zammy/shared";

/**
 * The browser's half of the wire contract (ARCHITECTURE 6.1). Responses are
 * parsed with the shared Zod schemas rather than cast, so a contract drift
 * fails loudly here instead of rendering garbage.
 */

/**
 * What narrows a search. Codes, never names (§2). Held apart from the keywords
 * because filters outlive them: the hero carries them before there is a topic,
 * and clearing a topic keeps them (see route.ts).
 */
export interface TopicFilters {
  language?: string;
  country?: string;
}

/**
 * What the user is searching for. `q` is empty in the STORYLINE VIEW, which is
 * opened by clicking a label rather than by typing (ADR-0011).
 */
export interface TopicQuery extends TopicFilters {
  q: string;
  /**
   * The STORYLINE VIEW's subject (ADR-0011). Not a filter, and deliberately
   * not in `TopicFilters`: a filter OUTLIVES the topic, and this is the one
   * piece of query state that must not — it names what the reader is looking
   * at, and typing replaces it.
   */
  storyline?: string;
}

export const Reference = z.object({
  /** Display name → code, e.g. { English: "en" }. Always send the code. */
  languages: z.record(z.string(), z.string()),
  regions: z.record(z.string(), z.string()),
  // No `categories`: the API stopped serving the taxonomy with the chip that
  // read it (ADR-0020). This object is not `.strict()`, so a response from an
  // instance that still sends one parses fine — the field is simply dropped.
});
export type Reference = z.infer<typeof Reference>;

const ErrorBody = z.object({
  error: z.object({
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export class ApiError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
  }
}

async function throwApiError(response: Response): Promise<never> {
  let message = `request failed (${response.status})`;
  let fields: Record<string, string> = {};
  try {
    const parsed = ErrorBody.parse(await response.json());
    message = parsed.error.message;
    fields = parsed.error.fields ?? {};
  } catch {
    // Non-JSON error body (proxy failure, crash page): keep the status message.
  }
  throw new ApiError(response.status, message, fields);
}

export async function fetchTimeline(
  topic: TopicQuery,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<TimelinePage> {
  // The storyline view sends the UUID and nothing else: it is not a search, so
  // it carries no keywords and no filters to narrow them with.
  if (isStorylineView(topic)) {
    const viewParams = new URLSearchParams({ storyline: topic.storyline! });
    if (cursor) viewParams.set("cursor", cursor);
    const viewResponse = await fetch(`/api/v1/timeline?${viewParams}`, { signal });
    if (!viewResponse.ok) await throwApiError(viewResponse);
    return TimelinePage.parse(await viewResponse.json());
  }

  const params = new URLSearchParams({ q: topic.q });
  if (topic.language) params.set("language", topic.language);
  if (topic.country) params.set("country", topic.country);
  if (cursor) params.set("cursor", cursor);

  const response = await fetch(`/api/v1/timeline?${params}`, { signal });
  if (!response.ok) await throwApiError(response);
  return TimelinePage.parse(await response.json());
}

/**
 * Where a storyline's background refresh is asked for (ADR-0017).
 *
 * A UUID and nothing else, and that absence is the point worth pinning: no
 * keywords and no filter chips travel. Both are facts about the ARC that only
 * the server holds — the headline vocabulary its label has to be grounded
 * against (the reason `TrendingStoryline.query` is on the wire at all), and the
 * language its articles are actually written in. The reader's own chips would be
 * the wrong ask: the cloud is English-only, so a Malay chip clicking an English
 * word would aim the refresh at a language the arc is not in.
 */
export function storylineRefreshPath(storylineId: string): string {
  return `/api/v1/storylines/${encodeURIComponent(storylineId)}/refresh`;
}

/**
 * Ask for one background top-up of what this storyline's coverage says, and do
 * not wait for it (§9.1, ADR-0017).
 *
 * **Fire-and-forget, deliberately, in both directions.** Nothing on the page
 * reads the response: opening a storyline renders stored day slots by UUID, and
 * whatever this fetches lands in the archive for the NEXT read rather than in
 * the view the reader is about to see. So there is no await here, no state, no
 * spinner, and — the part that matters — no failure that a reader should ever
 * be shown. A 404 on a stale UUID, a 429 from the per-IP ceiling, an offline
 * tab: all of them mean the arc goes un-refreshed, which is exactly what
 * happened before this existed.
 *
 * `keepalive` because the click that triggers this is also a route transition,
 * and a reader who closes the tab in the same breath should still have asked.
 *
 * Not memoized per storyline, on purpose. The freshness decision belongs to the
 * server, which is the only side that knows the topic's coverage: it answers
 * `queued: false` inside the staleness tier (60 s on a live window), and the
 * queue deduplicates by job identity behind that. A client-side "already asked"
 * set would have to guess that TTL, and would guess it wrong the moment a
 * reader comes back to a storyline an hour later.
 */
export function refreshStoryline(storylineId: string): void {
  void fetch(storylineRefreshPath(storylineId), {
    method: "POST",
    keepalive: true,
  }).catch(() => {
    // See above: an un-refreshed arc is the status quo, never a reader's problem.
  });
}

export async function fetchTrending(
  language: string,
  signal: AbortSignal,
): Promise<TrendingResponse> {
  const response = await fetch(`/api/v1/trending?language=${encodeURIComponent(language)}`, {
    signal,
  });
  if (!response.ok) await throwApiError(response);
  return TrendingResponse.parse(await response.json());
}

export async function fetchReference(signal: AbortSignal): Promise<Reference> {
  const response = await fetch("/api/v1/reference", { signal });
  if (!response.ok) await throwApiError(response);
  return Reference.parse(await response.json());
}
