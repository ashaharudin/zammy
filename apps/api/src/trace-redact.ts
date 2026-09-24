import type { Config } from "@zammy/config";
import { isNewsError } from "@zammy/news-client";
import { MAX_VIEW_STORYLINES } from "@zammy/shared";
import {
  PgTable,
  PlaneStatuses,
  TraceMeta,
  TraceQueryKey,
  UpstreamFailure,
  type JobKind,
  type JobPlane,
  type PgOperation,
  type RateLimitOutcome,
  type RedisCommand,
  type RedisKeyClass,
  type RedisOutcome,
  type RedisStatus,
  type TraceEnvironment,
  type TraceRoute,
} from "@zammy/shared/request-trace";
import type { Database } from "@zammy/storage";
import type { IngestJob } from "./ingest-queue.js";
import { isFailOpen } from "./rate-limit-fail-open.js";

/**
 * The classifiers (ADR-0029): every function that turns something a request
 * touched into a word the trace is allowed to hold.
 *
 * **This module is the redaction boundary's first half, and the schema is its
 * second.** The wrappers in `trace-deps.ts` see raw Redis keys and arguments,
 * Kysely operation trees, upstream errors and route queries; what they hand the
 * recorder is only ever the output of a function here — an enum member, a
 * number, a boolean. Each classifier reads what it must (a key's PREFIX, a
 * reply's nullness, a table node's name) and returns a class, and the raw input
 * never leaves the function: nothing here stores, logs or echoes an argument,
 * and nothing here returns a string that did not come from a closed list.
 *
 * Then the schema (`@zammy/shared/request-trace`) refuses anything that is not
 * an enum member or a patterned string, and the server persists the PARSE
 * OUTPUT. So a classifier with a bug can mis-label a touch, and it cannot leak
 * a key — which is the order of failure this feature is willing to have.
 *
 * What it deliberately does NOT do: read a value. `redisOutcomeOf` reads a
 * reply's nullness (an `MGET` element's included), integer 0/1, and whether an
 * NX `SET` answered `"OK"`, and nothing else; `pgTablesOf` walks into any node
 * of code — a `RawNode`'s nested fragments, an operator's operands — but never
 * enters a VALUE node (`ValueNode`, `ValueListNode`, `PrimitiveValueListNode`),
 * which is where a bound parameter's value sits; `upstreamFailureOf` reads an
 * error's `kind`, never its message (a Currents error message carries the
 * request URL, and the URL carries the reader's search text).
 */

// ── Postgres ────────────────────────────────────────────────────────────────

/**
 * Every table `Database` names, as a membership test.
 *
 * `satisfies Record<keyof Database, true>` is the compile-time half of the pin:
 * a migration that adds a table fails to compile here until it is listed. The
 * other half is `trace-redact.test.ts`, which pins these keys equal to the wire
 * enum `PgTable` — so a table cannot be traced before the schema can carry it.
 */
export const TRACEABLE_TABLES = {
  sightings: true,
  articles: true,
  topics: true,
  topic_articles: true,
  topic_coverage: true,
  storyline_coverage: true,
  fetch_log: true,
  storylines: true,
  storyline_groups: true,
  storyline_days: true,
  story_token_days: true,
  story_corpus_days: true,
  storyline_bridges: true,
  storyline_formation_refusals: true,
  storyline_day_summaries: true,
  chore_runs: true,
} as const satisfies Record<keyof Database, true>;

/** How many operation nodes `pgTablesOf` visits before it stops looking. */
export const PG_WALK_NODE_LIMIT = 400;
/** How much of a raw statement's text the table scan reads. */
export const PG_RAW_SCAN_BYTES = 8 * 1024;
/** Tables one touch may name (`MAX_TOUCH_TABLES`). */
const PG_TABLE_LIMIT = 6;

/**
 * Node kinds that carry a bound VALUE. The walk never enters them, so a
 * parameter reading `"from storyline_days"` — a reader's search text, say —
 * can never contribute a table name, not even one the allow-list would accept.
 */
const VALUE_NODE_KINDS: ReadonlySet<string> = new Set([
  "ValueNode",
  "ValueListNode",
  "PrimitiveValueListNode",
]);

/** `\bfrom|join|into|update <name>`, optionally quoted — table names in raw SQL fragments. */
const RAW_TABLE_PATTERN = /\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi;

/** The statement kind of a Kysely root node. Anything that is not DML reads `raw`. */
export function pgOperationOf(node: { kind: string }): PgOperation {
  switch (node?.kind) {
    case "SelectQueryNode":
      return "select";
    case "InsertQueryNode":
      return "insert";
    case "UpdateQueryNode":
      return "update";
    case "DeleteQueryNode":
      return "delete";
    default:
      return "raw";
  }
}

function isNode(value: unknown): value is { kind: string } & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

function isTraceableTable(name: string): name is PgTable {
  return Object.hasOwn(TRACEABLE_TABLES, name);
}

/**
 * The tables a statement names, from its operation tree.
 *
 * Iterative, and bounded at `PG_WALK_NODE_LIMIT` visits, because this runs
 * synchronously inside `transformQuery` on the request path and a pathological
 * tree must cost a truncated list rather than a stall.
 *
 * Two sources: a `TableNode`'s identifier, and — for a `RawNode` — a regex over
 * the first `PG_RAW_SCAN_BYTES` of its SQL FRAGMENTS, which are the template's
 * literal text and therefore code, never input. A raw node's parameters are
 * walked only where they are themselves nodes of code (a nested `sql` fragment,
 * a `sql.join` of fragments); a parameter that is a value is a `ValueNode` and
 * is never entered, which is the rule that matters (see `VALUE_NODE_KINDS`).
 *
 * Every name then goes through `TRACEABLE_TABLES`, which is what drops a CTE
 * alias (`matched`, `chain`) and a column alias the regex caught by accident;
 * the survivors are deduplicated in first-seen order and capped at six.
 */
export function pgTablesOf(node: unknown): PgTable[] {
  const found: PgTable[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const name = raw.toLowerCase();
    if (found.length >= PG_TABLE_LIMIT || seen.has(name) || !isTraceableTable(name)) return;
    seen.add(name);
    found.push(name);
  };

  const stack: unknown[] = [node];
  let visited = 0;
  while (stack.length > 0 && visited < PG_WALK_NODE_LIMIT && found.length < PG_TABLE_LIMIT) {
    const current = stack.pop();
    if (!isNode(current) || VALUE_NODE_KINDS.has(current.kind)) continue;
    visited += 1;

    if (current.kind === "TableNode") {
      const table = current.table as { identifier?: { name?: unknown } } | undefined;
      const name = table?.identifier?.name;
      if (typeof name === "string") add(name);
      continue;
    }

    if (current.kind === "RawNode") {
      const fragments = current.sqlFragments;
      if (Array.isArray(fragments)) {
        const text = fragments
          .filter((fragment): fragment is string => typeof fragment === "string")
          .join(" ")
          .slice(0, PG_RAW_SCAN_BYTES);
        for (const match of text.matchAll(RAW_TABLE_PATTERN)) {
          if (match[1] !== undefined) add(match[1]);
        }
      }
    }

    // Children in reverse so the stack pops them in source order, which is what
    // makes "first seen" mean first in the statement.
    const children: unknown[] = [];
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push(item);
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return found;
}

// ── Redis ───────────────────────────────────────────────────────────────────

/**
 * What a Redis key is FOR, by prefix, first match wins. The key never leaves.
 *
 * Every row cites the one place that builds the key, because a prefix that
 * drifts at its builder silently reclassifies as `other` here — which is the
 * safe direction (a mis-drawn bin, never a leaked key), and the reason the test
 * classifies through the REAL builders where they are exported.
 *
 *   ref:                              reference       routes.ts (cachedReference, fetchReference)
 *   page:                             page_cache      page-cache.ts (pageCacheKey)
 *   <queue>:trending:                 trending_cache  trending-service.ts (cacheKeyFor)
 *   <queue>:lock:sample:              sample_lock     trending-service.ts (sampleLockFor)
 *   lock:refresh:storyline:           deepen_lock     storyline-deepening.ts — BEFORE the next row
 *   lock:refresh:                     fill_lock       single-flight.ts (refreshLockKey)
 *   lock:summarize:                   summarize_lock  storyline-summary-job.ts
 *   budget:topic:                     topic_budget    topic-budget.ts
 *   budget:fallback:                  topic_budget    topic-budget.ts (reserveFallbackCall)
 *   ingest:pending:                   pending_ledger  ingest-queue.ts (PendingSet.key)
 *   fallback:published:               pending_ledger  search-fallback.ts (queueSearchFallback)
 *   deepening:served:                 other           storyline-deepening.ts — deliberately unbinned:
 *                                                     a new bin redraws the rack, and "other" is the
 *                                                     safe direction this table already names
 */
export function classifyRedisKey(key: unknown, queueName: string): RedisKeyClass {
  if (typeof key !== "string") return "other";
  if (key.startsWith("ref:")) return "reference";
  if (key.startsWith("page:")) return "page_cache";
  if (key.startsWith(`${queueName}:trending:`)) return "trending_cache";
  if (key.startsWith(`${queueName}:lock:sample:`)) return "sample_lock";
  // The deepening lock is `refreshLockKey("storyline:<id>", span)`, so it shares
  // the fill lock's prefix and must be tested first.
  if (key.startsWith("lock:refresh:storyline:")) return "deepen_lock";
  if (key.startsWith("lock:refresh:")) return "fill_lock";
  if (key.startsWith("lock:summarize:")) return "summarize_lock";
  if (key.startsWith("budget:topic:")) return "topic_budget";
  // The search fallback's daily share (ADR-0030) is a budget counter of the same
  // shape, taken beside the per-topic one; one bin for "a call was counted".
  if (key.startsWith("budget:fallback:")) return "topic_budget";
  if (key.startsWith("ingest:pending:")) return "pending_ledger";
  // The search fallback's publish-once guard (ADR-0030): it exists to keep the
  // ledger honest, so it is drawn in the ledger's bin.
  if (key.startsWith("fallback:published:")) return "pending_ledger";
  return "other";
}

const REDIS_COMMANDS: Readonly<Record<string, RedisCommand>> = {
  get: "GET",
  mget: "MGET",
  set: "SET",
  del: "DEL",
  incr: "INCR",
  expire: "EXPIRE",
  pexpire: "EXPIRE",
  eval: "EVAL",
  evalsha: "EVAL",
  zcard: "ZCARD",
};

/** ioredis' lowercase command name → the wire vocabulary; anything unlisted is `other`. */
export function redisCommandOf(ioredisName: string): RedisCommand {
  const name = typeof ioredisName === "string" ? ioredisName.toLowerCase() : "";
  return Object.hasOwn(REDIS_COMMANDS, name) ? REDIS_COMMANDS[name]! : "other";
}

/**
 * Where a command's key sits in its arguments. `EVAL script numkeys key…` puts
 * the first key third, and only when `numkeys ≥ 1`; everything this codebase
 * sends otherwise leads with its key.
 */
export function redisKeyArg(ioredisName: string, args: readonly unknown[]): unknown {
  const name = typeof ioredisName === "string" ? ioredisName.toLowerCase() : "";
  if (name === "eval" || name === "evalsha") {
    return Number(args[1]) >= 1 ? args[2] : undefined;
  }
  return args[0];
}

/** `SET key value … NX`: a lock acquisition, whose `"OK"` means ours and `null` means held. */
export function hasNxFlag(args: readonly unknown[]): boolean {
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg === "string" && arg.toUpperCase() === "NX") return true;
  }
  return false;
}

const CACHE_KEYS: ReadonlySet<RedisKeyClass> = new Set([
  "page_cache",
  "reference",
  "trending_cache",
]);
const LOCK_KEYS: ReadonlySet<RedisKeyClass> = new Set([
  "fill_lock",
  "deepen_lock",
  "summarize_lock",
]);

/**
 * What a successful reply MEANT, read off its shape alone.
 *
 * Nullness, integer 0/1 and an NX `SET`'s `"OK"` are the whole of what is
 * inspected: a cache read is a `miss` when the value (or any `MGET` element) is
 * null, an NX `SET` is `acquired` on `"OK"` and `held` otherwise, and the
 * compare-and-delete `EVAL` that releases a lock (`single-flight.ts`) says
 * `released` on 1 and `lost` on 0 — the lock expired mid-call and someone else
 * may hold it now. The value is never kept.
 */
export function redisOutcomeOf(
  command: RedisCommand,
  key: RedisKeyClass,
  args: readonly unknown[],
  value: unknown,
): RedisOutcome {
  if ((command === "GET" || command === "MGET") && CACHE_KEYS.has(key)) {
    if (value === null || value === undefined) return "miss";
    if (Array.isArray(value) && value.some((item) => item === null || item === undefined)) {
      return "miss";
    }
    return "hit";
  }
  if (command === "SET" && hasNxFlag(args)) return value === "OK" ? "acquired" : "held";
  if (command === "EVAL" && LOCK_KEYS.has(key)) {
    if (value === 1) return "released";
    if (value === 0) return "lost";
  }
  return "ok";
}

/**
 * A rejected command, as `not_ready` (the client was not connected — ioredis'
 * "Stream isn't writeable and enableOfflineQueue options is false", a cold
 * instance's Upstash handshake) or `failed`. The message is read and dropped.
 */
export function redisFailureOf(error: unknown): "not_ready" | "failed" {
  const message = error instanceof Error ? error.message : "";
  return /isn't writeable/.test(message) ? "not_ready" : "failed";
}

/** ioredis `status`, folded: wait/connecting/connect → connecting; end/close → down. */
export function redisStatusOf(ioredisStatus: string): RedisStatus {
  switch (ioredisStatus) {
    case "ready":
      return "ready";
    case "wait":
    case "connecting":
    case "connect":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    default:
      // `end`, `close`, and anything a future ioredis adds: not usable now.
      return "down";
  }
}

// ── upstream ────────────────────────────────────────────────────────────────

/**
 * A thrown upstream error, as its `NewsError` kind — or `unknown`.
 *
 * The kind and nothing else. An error's message is exactly where a URL would be
 * (the Currents transport's errors name the request), so an error that is not a
 * recognised `NewsError`, or whose kind the wire does not list, is `unknown`
 * rather than described.
 */
export function upstreamFailureOf(error: unknown): UpstreamFailure {
  if (!isNewsError(error)) return "unknown";
  const parsed = UpstreamFailure.safeParse(error.kind);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * `refused` is the upstream (or our own governor) declining to be asked —
 * quota, an open circuit, a model that answered with nothing usable; `failed`
 * is everything that went wrong on the way.
 */
export function upstreamOutcomeOf(failure: UpstreamFailure): "refused" | "failed" {
  return failure === "quota" || failure === "circuit_open" || failure === "answered"
    ? "refused"
    : "failed";
}

// ── jobs ────────────────────────────────────────────────────────────────────

/** What a job is, from its discriminant: `kind` for the tagged ones, a top-up by its flag. */
export function jobKindOf(job: IngestJob): JobKind {
  if (
    job.kind === "sample" ||
    job.kind === "deepen" ||
    job.kind === "summarize" ||
    job.kind === "fallback"
  ) {
    return job.kind;
  }
  return job.kind === "topup" ? "topup" : "segment";
}

/** A segment's (or top-up's) ADR-0019 plane. The arc-subject jobs carry none by design. */
export function jobPlaneOf(job: IngestJob): JobPlane | undefined {
  if (job.kind === "sample" || job.kind === "deepen" || job.kind === "summarize") return undefined;
  // A fallback exists only on the search plane, so it carries no field to read.
  if (job.kind === "fallback") return "search";
  return job.plane;
}

// ── routes and responses ────────────────────────────────────────────────────

function queryRecord(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
}

/**
 * Which traceable route a request is, from its method, its ROUTE PATTERN
 * (`routeOptions.url`, never `request.url` — the pattern holds no id and no
 * query text) and whether its query names a `storyline`. `null` for everything
 * the tracer must leave alone: HEAD, OPTIONS, `/topics`, the health checks, the
 * trace route itself, and any 404.
 */
export function traceRouteOf(
  method: string,
  routeUrl: string | undefined,
  query: unknown,
): TraceRoute | null {
  if (method === "GET") {
    switch (routeUrl) {
      case "/api/v1/timeline":
        return typeof queryRecord(query).storyline === "string"
          ? "timeline_view"
          : "timeline_search";
      case "/api/v1/storylines":
        return "storylines_search";
      case "/api/v1/trending":
        return "trending";
      case "/api/v1/reference":
        return "reference";
      default:
        return null;
    }
  }
  if (method === "POST" && routeUrl === "/api/v1/storylines/:id/refresh") return "storyline_open";
  return null;
}

/** The NAMES of the query parameters present, in the enum's order. Never a value. */
export function queryKeysOf(query: unknown): TraceQueryKey[] {
  const record = queryRecord(query);
  return TraceQueryKey.options.filter(
    (key) => Object.hasOwn(record, key) && record[key] !== undefined,
  );
}

/** A storyline view's width — how many ids `storyline=` named — or `undefined`. */
export function viewStorylinesOf(query: unknown): number | undefined {
  const storyline = queryRecord(query).storyline;
  if (typeof storyline !== "string") return undefined;
  const count = storyline.split(",").length;
  return count >= 1 && count <= MAX_VIEW_STORYLINES ? count : undefined;
}

/**
 * An `x-ratelimit-*` header as a count, or `null`.
 *
 * Integers only, because that is what the limiter writes and all the schema
 * takes; anything else (absent, garbled) is `null` rather than a guess.
 */
export function headerCount(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The inferred rate-limit touch's outcome, from the reply alone.
 *
 * No limit header means the limiter never ran for this reply, so there is no
 * touch at all (`null`). A 429 is `limited`. `remaining === limit` is the one
 * arithmetic a counted request cannot produce, so it is `fail_open` — read
 * through `isFailOpen`, the same reading `rate-limit-fail-open.ts` logs from.
 */
export function rateLimitOutcome(
  status: number,
  limit: unknown,
  remaining: unknown,
): RateLimitOutcome | null {
  if (limit === undefined || limit === null) return null;
  if (status === 429) return "limited";
  if (isFailOpen(limit, remaining)) return "fail_open";
  return "counted";
}

/** The response's own `meta`, if it has one the schema recognises. */
export function metaFromBody(body: unknown): TraceMeta | null {
  const meta = queryRecord(body).meta;
  const parsed = TraceMeta.safeParse(meta);
  return parsed.success ? parsed.data : null;
}

/**
 * What a storyline open's three plane gates decided, read off its 202 body
 * (`routes.ts`, the refresh route's reply). `null` for every other route, and
 * for a body that is not that shape — a 404 or a 400.
 */
export function planesFromBody(route: TraceRoute, body: unknown): PlaneStatuses | null {
  if (route !== "storyline_open") return null;
  const record = queryRecord(body);
  // The refresh reports under its own key now, like the other two planes, and
  // has to: `deferred` (ADR-0017, amended) is a 202 with `queued: false` and
  // keywords, which the inference below would read as `fresh`. The inference
  // stays for a body without the key, so a trace from before it still parses.
  const stated = queryRecord(record.refresh).status;
  const refresh =
    typeof stated === "string"
      ? stated
      : record.queued === true
        ? "queued"
        : Array.isArray(record.keywords) && record.keywords.length === 0
          ? "no_keywords"
          : "fresh";
  const parsed = PlaneStatuses.safeParse({
    refresh,
    deepening: queryRecord(record.deepening).status,
    summaries: queryRecord(record.summaries).status,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The live configuration a trace records, so the page draws what RAN rather
 * than what it assumes (Google News and summaries both ship off, and a page
 * that drew them anyway would be teaching a path the deployment never takes).
 */
export function traceEnvironment(config: Config, facts: { labeler: boolean }): TraceEnvironment {
  return {
    queue: config.INGEST_QUEUE_DRIVER,
    currents: config.CURRENTS_MODE,
    gnews: config.GNEWS_ENABLED,
    googleNews: config.GOOGLE_NEWS_ENABLED ? config.GOOGLE_NEWS_MODE : "off",
    summaries: config.SUMMARIES_ENABLED,
    labeler: facts.labeler,
  };
}
