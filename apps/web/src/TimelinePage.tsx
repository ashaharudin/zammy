import { useEffect, useRef, useState } from "react";
import type { Article } from "@zammy/shared";
import { isTerminalPage } from "@zammy/shared";
import { ApiError, type TopicQuery } from "./api.js";
import { groupByDay, relativeTime, timeLabel } from "./format.js";
import { MONO } from "./theme.js";
import { CommandBar } from "./CommandBar.js";
import { useReference, useTimeline } from "./useTimeline.js";

/**
 * The open-topic screen: the time rail from the prototype verdict
 * (branch prototype/timeline-ui) wired to GET /api/v1/timeline.
 *
 * State model (§6.1, §8.2): page.hasMore and meta.ingest.state answer
 * different questions and both gate the rail's tail —
 *   more rows in store            → sentinel + "Load older" fallback
 *   ingest still running upstream → shimmer rows + pulsing rail entry
 *   neither (isTerminalPage)      → the ■ "start of coverage" terminus
 */
export function TimelinePage({
  topic,
  onSearch,
  onClear,
}: {
  topic: TopicQuery;
  onSearch: (topic: TopicQuery) => void;
  onClear: () => void;
}) {
  const timeline = useTimeline(topic);
  const reference = useReference();

  const pages = timeline.data?.pages ?? [];
  const latest = pages.at(-1);
  const items = pages.flatMap((page) => page.items);
  const ingesting = latest?.meta.ingest.state === "in_progress";
  const terminal = latest !== undefined && !timeline.hasNextPage && isTerminalPage(latest);

  return (
    <>
      <CommandBar
        topic={topic}
        page={latest}
        articleCount={items.length}
        ingesting={ingesting ?? false}
        reference={reference.data}
        onSearch={onSearch}
        onClear={onClear}
      />
      <main style={{ maxWidth: "760px", margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>
        {timeline.isPending && <SkeletonRail />}

        {timeline.isError && (
          <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
        )}

        {latest && (
          <Rail
            items={items}
            ingesting={ingesting ?? false}
            pendingJobs={latest.meta.ingest.pendingJobs}
            terminal={terminal}
            emptyLabel={`No articles yet for “${topic.q}”.`}
            hasNextPage={timeline.hasNextPage}
            isFetchingNextPage={timeline.isFetchingNextPage}
            onLoadOlder={() => void timeline.fetchNextPage()}
          />
        )}
      </main>
    </>
  );
}

function Rail({
  items,
  ingesting,
  pendingJobs,
  terminal,
  emptyLabel,
  hasNextPage,
  isFetchingNextPage,
  onLoadOlder,
}: {
  items: Article[];
  ingesting: boolean;
  pendingJobs: number;
  terminal: boolean;
  emptyLabel: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadOlder: () => void;
}) {
  if (items.length === 0 && !ingesting) {
    return (
      <p style={{ color: "var(--fg-faint)", textAlign: "center", marginTop: "3rem" }}>
        {terminal ? emptyLabel : "Nothing here yet."}
      </p>
    );
  }

  return (
    <div style={{ position: "relative", paddingLeft: "2.5rem" }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "0.55rem",
          top: 0,
          bottom: 0,
          width: "3px",
          background: `linear-gradient(var(--rail), ${ingesting ? "var(--bg)" : "var(--rail)"})`,
          borderRadius: "2px",
        }}
      />
      {ingesting && (
        <RailEntry marker="◌" pulse>
          <em style={{ color: "var(--amber)", fontSize: "0.9rem" }}>
            fetching from upstream — {pendingJobs} jobs pending…
          </em>
        </RailEntry>
      )}
      {groupByDay(items).map((group) => (
        <section key={group.day} aria-label={group.day}>
          <RailEntry marker="●" big>
            <h2
              style={{
                fontSize: "0.9rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                margin: 0,
              }}
            >
              {group.day}
            </h2>
          </RailEntry>
          {group.items.map((article) => (
            <RailEntry key={article.id} marker="○">
              <ArticleCard article={article} />
            </RailEntry>
          ))}
        </section>
      ))}
      {ingesting && <ShimmerRows count={3} />}
      {!ingesting && hasNextPage && (
        <RailEntry marker="↓">
          <LoadOlder loading={isFetchingNextPage} onLoadOlder={onLoadOlder} />
        </RailEntry>
      )}
      {terminal && items.length > 0 && (
        <RailEntry marker="■">
          <span style={{ color: "var(--fg-faint)", fontSize: "0.9rem" }}>start of coverage</span>
        </RailEntry>
      )}
    </div>
  );
}

/**
 * Infinite scroll via IntersectionObserver, with the explicit fallback button
 * §8.2 requires (it also covers environments where IO callbacks never fire,
 * which the prototype ran into).
 */
function LoadOlder({ loading, onLoadOlder }: { loading: boolean; onLoadOlder: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) onLoadOlder();
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  });

  return (
    <div>
      <div ref={sentinel} style={{ height: "1px" }} aria-hidden="true" />
      <button
        onClick={onLoadOlder}
        disabled={loading}
        style={{
          border: "none",
          background: "none",
          color: "var(--fg)",
          cursor: "pointer",
          fontSize: "0.9rem",
          padding: 0,
        }}
      >
        {loading ? "loading older…" : "load older"}
      </button>
    </div>
  );
}

function ArticleCard({ article }: { article: Article }) {
  const [open, setOpen] = useState(false);
  const expandable = article.description !== null;

  return (
    <article
      style={{
        background: "var(--surface)",
        borderRadius: "8px",
        border: "1px solid var(--border)",
        padding: "0.6rem 0.9rem",
        maxWidth: "640px",
        display: "flex",
        gap: "0.75rem",
      }}
    >
      {article.imageUrl && (
        // Fixed aspect box so late-loading images never shift the rail (§8.3).
        <div
          style={{
            width: "72px",
            aspectRatio: "3 / 2",
            flexShrink: 0,
            alignSelf: "center",
            background: "var(--chip-bg)",
            borderRadius: "6px",
            overflow: "hidden",
          }}
        >
          <img
            src={article.imageUrl}
            alt=""
            loading="lazy"
            // Hotlink-blocked or dead upstream images collapse to the neutral
            // box rather than the browser's broken-image glyph.
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: "0.95rem", lineHeight: 1.35, textDecoration: "none", display: "block" }}
      >
        {article.title}
      </a>
      <div style={{ marginTop: "0.25rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <small style={{ fontSize: "0.7rem", color: "var(--fg-faint)", fontVariantNumeric: "tabular-nums" }}>
          <time dateTime={article.published}>{timeLabel(article.published)}</time>
        </small>
        {article.sourceDomain && (
          <span
            style={{
              fontSize: "0.7rem",
              background: "var(--chip-bg)",
              borderRadius: "4px",
              padding: "0.1rem 0.4rem",
            }}
          >
            {article.sourceDomain}
          </span>
        )}
        {article.sightingCount > 1 && (
          <span style={{ fontSize: "0.7rem", color: "var(--fg-faint)" }}>
            seen ×{article.sightingCount}, updated {relativeTime(article.latestSeen)}
          </span>
        )}
        {expandable && (
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "none",
              color: "var(--fg-faint)",
              cursor: "pointer",
              fontSize: "0.7rem",
              padding: "0 0.2rem",
            }}
          >
            {open ? "less ▲" : "more ▼"}
          </button>
        )}
      </div>
      {open && article.description && (
        <p style={{ marginTop: "0.5rem", marginBottom: 0, fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          {article.description}
        </p>
      )}
      </div>
    </article>
  );
}

function RailEntry({
  marker,
  big,
  pulse,
  children,
}: {
  marker: string;
  big?: boolean;
  pulse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: "relative", padding: big ? "1.5rem 0 0.5rem" : "0.35rem 0" }}>
      <span
        aria-hidden="true"
        className={pulse ? "shimmer" : undefined}
        style={{
          position: "absolute",
          left: "-2.5rem",
          width: "1.4rem",
          textAlign: "center",
          color: pulse ? "var(--amber)" : "var(--fg)",
          background: "var(--bg)",
          fontSize: big ? "0.9rem" : "0.75rem",
          top: big ? "1.55rem" : "0.45rem",
        }}
      >
        {marker}
      </span>
      {children}
    </div>
  );
}

/** Progressive-fill shimmer: a short first paint reads as "more coming" (§8.2). */
function ShimmerRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <RailEntry key={i} marker="○" pulse>
          <div className="shimmer" style={{ height: "3.4rem", maxWidth: "640px" }} />
        </RailEntry>
      ))}
    </>
  );
}

function SkeletonRail() {
  return (
    <div style={{ position: "relative", paddingLeft: "2.5rem" }} aria-label="Loading timeline">
      <ShimmerRows count={6} />
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? [error.message, ...Object.entries(error.fields).map(([f, m]) => `${f}: ${m}`)].join(" — ")
      : error instanceof Error
        ? error.message
        : "something went wrong";
  return (
    <div style={{ textAlign: "center", marginTop: "3rem", fontFamily: MONO }}>
      <p style={{ color: "var(--amber)", fontSize: "0.9rem" }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
          borderRadius: "6px",
          padding: "0.4rem 1.2rem",
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        retry
      </button>
    </div>
  );
}
