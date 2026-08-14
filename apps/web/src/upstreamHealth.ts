import type { TimelinePage } from "@zammy/shared";

/**
 * Where a response's degraded/stale state goes now that it has left the
 * command bar (§8.1, §11).
 *
 * It was a banner: "degraded: quota" beside the servedFrom stamp. That is an
 * operational fact about the fetch, not something a reader can act on, and it
 * sat where the topic's own filters belong. The state is still worth knowing,
 * so it is logged in a shape a web-logging transport can ship as-is.
 */

type Meta = Pick<TimelinePage["meta"], "degraded" | "stale" | "servedFrom" | "asOf">;

export interface UpstreamHealthRecord extends Meta {
  event: "upstream_degraded";
}

/** The record a response deserves, or null when there is nothing to report. */
export function upstreamHealthRecord(meta: Meta): UpstreamHealthRecord | null {
  if (!meta.degraded && !meta.stale) return null;
  return {
    event: "upstream_degraded",
    degraded: meta.degraded,
    stale: meta.stale,
    servedFrom: meta.servedFrom,
    asOf: meta.asOf,
  };
}
