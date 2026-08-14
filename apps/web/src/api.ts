import { z } from "zod";
import { TimelinePage, TrendingResponse } from "@zammy/shared";

/**
 * The browser's half of the wire contract (ARCHITECTURE 6.1). Responses are
 * parsed with the shared Zod schemas rather than cast, so a contract drift
 * fails loudly here instead of rendering garbage.
 */

/** What the user is searching for. Filters use upstream codes, never names (§2). */
export interface TopicQuery {
  q: string;
  language?: string;
  country?: string;
  category?: string;
  /**
   * The storyline a `storylinePhrase` chip was clicked on (ADR-0010). Not part
   * of what is being searched — it seeds the topic with the slot the reader
   * came from, and the API refuses anything in it that lacks every keyword.
   */
  storyline?: string;
}

export const Reference = z.object({
  /** Display name → code, e.g. { English: "en" }. Always send the code. */
  languages: z.record(z.string(), z.string()),
  regions: z.record(z.string(), z.string()),
  categories: z.array(z.string()),
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
  const params = new URLSearchParams({ q: topic.q });
  if (topic.language) params.set("language", topic.language);
  if (topic.country) params.set("country", topic.country);
  if (topic.category) params.set("category", topic.category);
  // Sent on every page of the topic, not only the first: the attach is
  // idempotent, and a reader who lands deep in a shared link still expects
  // the storyline that link names to be in the results.
  if (topic.storyline) params.set("storyline", topic.storyline);
  if (cursor) params.set("cursor", cursor);

  const response = await fetch(`/api/v1/timeline?${params}`, { signal });
  if (!response.ok) await throwApiError(response);
  return TimelinePage.parse(await response.json());
}

export async function fetchTrending(signal: AbortSignal): Promise<TrendingResponse> {
  const response = await fetch("/api/v1/trending", { signal });
  if (!response.ok) await throwApiError(response);
  return TrendingResponse.parse(await response.json());
}

export async function fetchReference(signal: AbortSignal): Promise<Reference> {
  const response = await fetch("/api/v1/reference", { signal });
  if (!response.ok) await throwApiError(response);
  return Reference.parse(await response.json());
}
