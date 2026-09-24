import { z } from "zod";

/**
 * @zammy/config — server-only configuration, validated at boot.
 *
 * The process refuses to start on bad config rather than failing mysteriously
 * later (ARCHITECTURE 12). This package holds the Currents API key and must
 * NEVER be imported by @zammy/web — the browser only ever talks to our API.
 */

const NonEmpty = z.string().trim().min(1);

/**
 * A Postgres connection URL that does NOT decide TLS for itself.
 *
 * node-postgres silently ignores the `ssl` options object whenever the
 * connection string carries `sslmode` (brianc/node-postgres#3355), and the same
 * goes for `sslnegotiation`. So a URL ending `?sslmode=require` cannot be
 * hardened later by adding a CA and `rejectUnauthorized: true` — the object is
 * dropped, nothing logs that it was, and the connection is encrypted-but-
 * unverified while the code says otherwise.
 *
 * Rather than let the URL and `DATABASE_SSL` disagree in favour of whichever the
 * driver happens to read, the URL is refused and TLS has exactly one home
 * (RESEARCH-VERCEL-SUPABASE §4.2).
 */
const PostgresUrl = NonEmpty.refine(
  (value) => !/ssl(mode|negotiation)=/i.test(value),
  "must not set sslmode/sslnegotiation — node-postgres silently ignores the ssl " +
    "options object when the URL carries either, so TLS would be libpq's default " +
    "rather than what DATABASE_SSL asks for. Drop it and set DATABASE_SSL.",
);

/**
 * A PEM certificate chain, pasted whole. Empty means unset — the same shape
 * every optional secret here has, so `DATABASE_CA_CERT=` in a template is not a
 * boot failure.
 */
const CaCert = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .refine(
    (value) => value === undefined || value.includes("-----BEGIN CERTIFICATE-----"),
    "must be a PEM chain containing -----BEGIN CERTIFICATE-----; escaped \\n " +
      "newlines are accepted, so a one-line dashboard value is fine",
  )
  .optional();

/**
 * A `redis://` or `rediss://` URL — not merely a non-empty string.
 *
 * Redis being *unreachable* is survivable on purpose: `/readyz` reports
 * `degraded` and keeps serving, because cache and queue both heal on reconnect
 * (health.ts, ARCHITECTURE 11). A *malformed* URL is a different animal. It can
 * never heal, and nothing downstream surfaces it: the boot failure is a warning
 * the app deliberately swallows (server.ts), and whatever watches `/readyz`
 * sees HTTP 200 and routes traffic to an instance whose ingest queue silently
 * does nothing. (Deployment moved to Vercel + Supabase + Upstash, ADR-0015 —
 * the failure mode belongs to whoever watches `/readyz`, not to any one
 * platform.)
 *
 * Three things are checked, because each fails silently in its own way:
 * `http://cache:6379` parses fine and is just as dead, `redis//cache:6379`
 * parses as a relative path, and `redis:6379` — a colon short of a URL — carries
 * the right protocol with *no host*, which ioredis resolves to localhost. The
 * last is the worst of the three: it connects, to the wrong Redis.
 *
 * So a typo is a boot refusal, like every other piece of config the process
 * cannot work without. What stays survivable is the case that deserves to be:
 * a well-formed URL pointing at something that is not answering yet.
 */
const RedisUrl = NonEmpty.refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") return false;
    // `redis:6379` has the protocol but no host; ioredis would quietly use
    // localhost, so it is a wrong-target bug rather than a connection failure.
    return url.hostname !== "";
  },
  "must be a redis:// or rediss:// URL with a host",
);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    DATABASE_URL: PostgresUrl,

    /**
     * The SESSION-scoped connection, for the two processes that hold
     * session-scoped advisory locks: the migrator
     * (`pg_advisory_lock`, migrator.ts) and the chore runner
     * (`pg_try_advisory_lock`, chores-cli.ts). Unset means "same as
     * DATABASE_URL", which is correct wherever one server answers both.
     *
     * It exists for pooled Postgres. A transaction-mode pooler hands each
     * statement whatever backend is free, so a session lock is taken on one
     * backend and looked for on another: `pg_try_advisory_lock` returns true
     * every time and the exactly-once it is there to buy is gone — silently,
     * because a chore pass that ran twice logs two ordinary successes. The
     * coverage lock is safe by contrast (`pg_advisory_xact_lock` is
     * transaction-scoped, and a transaction is pinned to one backend), which is
     * why this is a second URL rather than a different pooling mode for
     * everything.
     */
    DATABASE_SESSION_URL: PostgresUrl.optional(),

    /**
     * Request-path pool size, per process. 10 suits a long-lived server with a
     * known replica count. Serverless instances are elastic and each holds its
     * own pool, so a deployment there wants 1–2 — hence config rather than the
     * literal this used to be (server.ts).
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /**
     * TLS to Postgres, in libpq's vocabulary because it is the vocabulary the
     * operator already has:
     *
     *   disable      no TLS. Correct for the Compose Postgres, which offers none.
     *   require      encrypt, do not verify. Honest about being unverified.
     *   verify-full  encrypt and verify against DATABASE_CA_CERT.
     *
     * Never expressed in the URL — see `PostgresUrl` for why that silently
     * loses.
     */
    DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
    DATABASE_CA_CERT: CaCert,

    REDIS_URL: RedisUrl,

    /**
     * Which transport carries the §9.1 ingest queue.
     *
     *   bullmq  jobs in Redis, drained by a worker inside this process. What a
     *           persistent process wants, and what `docker compose up` and the
     *           integration tests run.
     *   vercel  a hosted Vercel Queues topic in push mode, drained by a separate
     *           function with no public URL (VERCEL-ALL-IN-SCOPE §3.2).
     *
     * A deployment property, not a code one, which is why it is a knob rather
     * than a build flag: the same image serves both shapes and the read path
     * cannot tell the difference. What it MUST match is `vercel.json` — the
     * trigger names the topic, and this driver publishes to it.
     *
     * The default is `bullmq` because getting it wrong in that direction is
     * loud (nothing drains locally, and the boot line says the consumer is off)
     * while the other direction is silent: a `vercel` driver in a process that
     * also asked for an in-process consumer throws at boot on purpose, and one
     * publishing to a topic no trigger points at looks exactly like a working
     * queue until `meta.ingest` never drains.
     */
    INGEST_QUEUE_DRIVER: z.enum(["bullmq", "vercel"]).default("bullmq"),

    /**
     * The bearer token the manual ingest drain requires (`api/drain.ts`,
     * VERCEL-ALL-IN-SCOPE §3.2). Named for Vercel's own convention — its cron
     * invoker sends `Authorization: Bearer $CRON_SECRET` — so the same route
     * answers to either scheduler without a second secret; Supabase Cron is the
     * intended driver here because it has the minute precision the drain wants
     * and Hobby's Vercel cron does not.
     *
     * Optional here and MANDATORY at the route, which is deliberate: the drain
     * is the one surface that can spend upstream quota without a user asking,
     * so it refuses to run rather than run unauthenticated, and leaving this
     * unset disables the route instead of opening it. Every other deployment
     * shape — Compose, tests, local dev — has no drain and needs no token, and
     * requiring it in the schema would break all three to protect a route they
     * do not serve.
     */
    CRON_SECRET: z.string().trim().optional(),

    // --- upstream ---
    CURRENTS_MODE: z.enum(["live", "fixture"]).default("fixture"),
    CURRENTS_API_KEY: z.string().trim().optional(),
    CURRENTS_BASE_URL: z.url().default("https://api.currentsapi.services/v1"),
    /**
     * Required and non-empty. Cloudflare fronting the API returns 403 (error 1010)
     * to default library User-Agents — the probe lost its first 11 calls to this.
     * A default would let the mistake reach production silently.
     */
    CURRENTS_USER_AGENT: NonEmpty,

    // --- upstream limits, verified against the Free tier (PROBE-FINDINGS 1) ---
    // Observed from x-ratelimit-* headers at runtime but bounded by these, so a
    // missing header never reads as "unlimited".
    CURRENTS_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(20),
    CURRENTS_MAX_RETRIEVABLE_RESULTS: z.coerce.number().int().min(20).default(100),
    CURRENTS_MAX_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * Per-call date-range ceiling on /search. Observed live 2026-08-11:
     * "date_range: Max range is 7 days" — the 2026-08-04 probe's single
     * 30-day call no longer works. The planner slices gaps to this.
     */
    CURRENTS_MAX_RANGE_DAYS: z.coerce.number().int().min(1).default(7),
    CURRENTS_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(1000),
    CURRENTS_BURST_CALL_LIMIT: z.coerce.number().int().min(1).default(60),

    // --- second provider: GNews (ARCHITECTURE 5.6) ---
    /**
     * Off by default. A second provider changes what gets ingested and how the
     * budget is spent, so it is an explicit decision — and with it off, the
     * factory returns the Currents client bare and nothing about the system's
     * behaviour changes.
     */
    GNEWS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    GNEWS_MODE: z.enum(["live", "fixture"]).default("fixture"),
    GNEWS_API_KEY: z.string().trim().optional(),
    GNEWS_BASE_URL: z.url().default("https://gnews.io/api/v4"),
    /** Optional: falls back to CURRENTS_USER_AGENT, which is already required. */
    GNEWS_USER_AGENT: z.string().trim().optional(),

    // --- GNews limits, from the published Free plan (gnews.io/pricing) ---
    // 100 requests/day, 10 articles/request, 30 days of history.
    GNEWS_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * GNews allows 1000 articles of paging, but on 100 calls a day that ceiling
     * is theoretical: ten pages is already a tenth of the daily budget spent on
     * one window. Kept at 100 so a single segment cannot drain the day, and
     * raised by config on a paid plan.
     */
    GNEWS_MAX_RETRIEVABLE_RESULTS: z.coerce.number().int().min(10).default(100),
    GNEWS_MAX_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * GNews documents no per-call range ceiling, unlike the Currents 7 days, so
     * this is set to the lookback: no artificial slicing. The composite narrows
     * to whichever provider is stricter anyway.
     */
    GNEWS_MAX_RANGE_DAYS: z.coerce.number().int().min(1).default(30),
    GNEWS_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(100),
    /**
     * The Free plan documents 1 request per second — a different *shape* of
     * window from the Currents 60-per-60s, hence the separate window setting.
     * A burst refusal makes GNews sit a call out rather than failing it, so this
     * paces the supplement instead of stalling the fan-out.
     */
    GNEWS_BURST_CALL_LIMIT: z.coerce.number().int().min(1).default(1),
    GNEWS_BURST_WINDOW_MS: z.coerce.number().int().min(1).default(1000),
    /**
     * Proportionally the same quarter of the budget CURRENTS_INTERACTIVE_RESERVE
     * holds back, sized for 100 calls rather than 1000. Reusing the Currents
     * value of 250 here would exceed the whole daily limit and silently make
     * GNews interactive-only.
     */
    GNEWS_INTERACTIVE_RESERVE: z.coerce.number().int().min(0).default(25),

    // --- third provider: Google News RSS ---
    // Built for DESIGN-DISCOVERY-AND-DEEPENING's deepening plane — reaching ~18
    // months back over arcs Currents already found, against Currents' 30 days —
    // and intended to serve search and breadth as well, which is why ADR-0019
    // replaced ADR-0012's provider ranking with per-fetch coverage and a
    // per-fetch `plane`. No provider is privileged; what a fetch may feed is
    // decided by why it was made.
    /**
     * Off by default, like GNEWS_ENABLED and for its reason — adding a provider
     * changes what gets ingested and how budget is spent. The two guards it
     * waited on have landed: G1's `alt_key` (migration 0020), without which a
     * Google News item cannot be collapsed onto the same story from Currents,
     * and G2's ranker isolation, without which the cloud would rank on its own
     * fetching. G3's `storyline_coverage` and G5's wiring have landed too, so
     * this is a real switch: on, a storyline open deepens its arc from Google
     * News (and, with SEARCH_FALLBACK_ENABLED, a refused search can fall back to
     * it — ADR-0030). `createGoogleNewsClient` refuses to build a client while
     * this is false, so the adapter is unreachable rather than merely unwired.
     */
    GOOGLE_NEWS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    GOOGLE_NEWS_MODE: z.enum(["live", "fixture"]).default("fixture"),
    GOOGLE_NEWS_BASE_URL: z.url().default("https://news.google.com/rss"),
    /**
     * Optional: falls back to CURRENTS_USER_AGENT, which is already required.
     *
     * There is no API key here, so the User-Agent is the ONLY thing identifying
     * this client — and PROBE-FINDINGS 2 cost eleven calls to learn that a
     * default library UA earns a 403. A blocked keyless endpoint and a
     * misconfigured one look identical from the outside.
     */
    GOOGLE_NEWS_USER_AGENT: z.string().trim().optional(),
    /**
     * The default EDITION, not a filter — the distinction the parameter names
     * invite you to miss. Measured 2026-08-27: one query across CA/US/GB/IN
     * shared 30–50% of its titles and `axios.com` came back in all four, so an
     * edition biases selection rather than restricting it. Language is a much
     * stronger effect (`hl=en-CA` vs `hl=fr-CA` shared 1 guid of 100) and still
     * not a guarantee. Nothing downstream may treat a fetch made under these as
     * having been filtered upstream.
     *
     * The `hl`/`gl`/`ceid` triple is derived from this pair rather than
     * configured as three values, because the three are not independent: `hl` is
     * `<lang>-<COUNTRY>`, `gl` is the country and `ceid` is `<COUNTRY>:<lang>`.
     * A set that disagrees with itself returns a different, quieter result set.
     */
    GOOGLE_NEWS_LANGUAGE: z.string().trim().min(2).default("en"),
    GOOGLE_NEWS_COUNTRY: z.string().trim().length(2).default("CA"),
    /**
     * Two years — deliberately PAST what has been measured, which is 573 days.
     *
     * Nothing about this endpoint is documented, so the only fact available is
     * a probed floor: `"bank of canada" after:2025-02-01 before:2025-02-03`
     * answered with 20 items from 17 publisher domains on 2026-08-28, 573 days
     * later. No upper bound was found because none was looked for.
     *
     * Set above the floor rather than on it because this clamp is not the same
     * kind of clamp as CURRENTS_MAX_LOOKBACK_DAYS. That one exists so a
     * documented 400 stays unreachable; there is no 400 here — an over-old
     * window answers 200 with few or no items. So the only cost of asking too
     * deep is a wasted call, whereas the cost of clamping too shallow is a
     * window silently pulled forward and then recorded as covered
     * (ARCHITECTURE 11). Between a wasted call and a permanent gap, this takes
     * the wasted call.
     *
     * For scale: Currents' verified lookback is 30 days, and reaching past it
     * is the entire reason this provider is worth having.
     */
    GOOGLE_NEWS_MAX_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(7300).default(730),
    /**
     * A budget WE INVENTED. This is the uncomfortable part of this provider and
     * it should not be smoothed over: there is no key, no published ceiling and
     * no rate-limit header, so `quota()` returns null forever and the governor
     * will never once be corrected by upstream. Every other number in this file
     * was transcribed from something a provider told us; these two were not.
     *
     * Hence low. What an unhappy keyless endpoint looks like is on record —
     * GDELT answered 1 of 6 probe calls, the five failures arriving as silent
     * connection timeouts at 30–75s rather than as a 429
     * (RESEARCH-FREE-NEWS-SOURCES §1). There is no warning shot to wait for, so
     * the budget is the only thing pacing us and the breaker is the only thing
     * that notices afterwards.
     *
     * Raise either only on measurement (G6), never on optimism.
     */
    GOOGLE_NEWS_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(200),
    GOOGLE_NEWS_BURST_CALL_LIMIT: z.coerce.number().int().min(1).default(5),
    /** A minute, like Currents — there is no observed window shape to match. */
    GOOGLE_NEWS_BURST_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
    /**
     * A quarter of the daily budget held back for interactive use, the same
     * proportion CURRENTS_INTERACTIVE_RESERVE and GNEWS_INTERACTIVE_RESERVE hold.
     */
    GOOGLE_NEWS_INTERACTIVE_RESERVE: z.coerce.number().int().min(0).default(50),
    /**
     * A reader's search that Currents refused on quota is retried against Google
     * News, for the part of it that is at most `SEARCH_FALLBACK_REACH_MS` old
     * (ADR-0030, `search-fallback.ts`).
     *
     * Off by default, and turning it on is a decision about the archive rather
     * than a tuning change: its articles are SEARCH-plane, so unlike the
     * deepening plane's they are counted by the cloud and they form storylines
     * of their own — which means labels. The ADR prices each. Needs
     * GOOGLE_NEWS_ENABLED, because the provider it falls back to is that one.
     */
    SEARCH_FALLBACK_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Google News calls the fallback may spend per UTC day, across every topic.
     *
     * A share of GOOGLE_NEWS_DAILY_CALL_LIMIT rather than a budget of its own,
     * because there is no second budget to draw on: the deepening plane spends
     * the same 200 (a figure WE invented — see the limit). The governor holds
     * back GOOGLE_NEWS_INTERACTIVE_RESERVE from both planes' background work
     * alike, so 150 is what they share, and this keeps at least 100 of it for
     * the plane that was there first.
     */
    SEARCH_FALLBACK_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(50),
    /**
     * Opening a storyline stops spending a Currents call on the arc when the
     * deepening plane has just planned it — queued a Google News fetch, or found
     * the arc fresh (ADR-0017, amended).
     *
     * Every open used to buy BOTH: ADR-0017's top-up of the topic the arc's two
     * grounded words name, and G5's deepening fetch of the arc itself. The two
     * refresh one arc, and the first draws on the Currents budget readers'
     * searches need — the background half of which a reader's deferred pages
     * were refused on (trace 4e3a28c2…, 2026-09-24). Off by default; with no
     * deepening provider it changes nothing, since the deepening plane then
     * answers `unavailable` and the Currents refresh runs as it always has.
     */
    STORYLINE_REFRESH_DEFERS_TO_DEEPENING: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    // --- ingestion budget (ARCHITECTURE 6.3, 9.4) ---
    SYNC_FILL_DEADLINE_MS: z.coerce.number().int().min(100).max(10_000).default(1200),
    MAX_SYNC_UPSTREAM_CALLS: z.coerce.number().int().min(1).max(5).default(5),
    INTERACTIVE_RESERVE: z.coerce.number().int().min(0).default(250),
    /**
     * §9.4's per-topic budget. 2% of the pool: moderate keywords complete a
     * 30-day backfill inside it, and since truncation records a coverage
     * frontier (§6.3), a capped dense topic still banks ~400 articles of
     * durable history per day and resumes exactly where it stopped. (Briefly
     * 50 while halve-and-refetch truncation wasted the budget — the frontier
     * removed the waste, so the tighter cap costs nothing.)
     */
    PER_TOPIC_DAILY_CALL_CAP: z.coerce.number().int().min(1).default(20),
    /** §9.4: per-IP ceiling on /api/v1/*, so novel-fingerprint spam can't mint topics. */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
    /**
     * How many reverse proxies sit in front of this process. 0 means none.
     *
     * This is the *count* and not a boolean because `trustProxy: true` trusts the
     * entire `X-Forwarded-For` chain, and trusting the whole chain means the
     * **leftmost** entry wins — which is whatever the client sent. A client can
     * then forge a header, rotate the value, and walk straight through the per-IP
     * ceiling RATE_LIMIT_PER_MINUTE exists to impose (ARCHITECTURE 12). A hop
     * count trusts only the hops we actually operate, so `req.ip` is the address
     * our own proxy observed rather than one the caller chose.
     *
     * Set it to the number of proxies between the internet and this process:
     * **1** behind a single load balancer that terminates TLS, **2** if another
     * proxy is ever put in front of that. Local dev talks to the port directly,
     * so the default is 0. (Deployment moved to Vercel + Supabase + Upstash,
     * ADR-0015; the arithmetic is the same for any proxy topology.)
     *
     * **Over-counting is as bad as `true`, so do not round up "to be safe".**
     * Measured against Fastify with `X-Forwarded-For: 9.9.9.9, 5.5.5.5`: a count
     * of 1 yields `5.5.5.5` (what the one real hop reported), while a count of 2
     * yields `9.9.9.9` — both entries become trusted and the caller's forgery wins
     * again, exactly as `true` does. The number must match the topology, not
     * exceed it.
     *
     * Forgetting it in production degrades toward *availability*, not exposure:
     * every request keys on the load balancer's address, so one shared bucket
     * rate-limits everybody instead of one forged header exempting anybody. That
     * is the safer direction to fail in, and it is the reason this defaults to 0
     * rather than to something convenient.
     */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

    // --- article grouping (ARCHITECTURE 14.3, ADR-0005) ---
    /**
     * Whether the same story from several outlets is shown as one timeline
     * slot with the rest as "related". Off restores one card per article;
     * groups already recorded stay recorded and simply page as groups of one,
     * so this is reversible without a migration.
     */
    // An enum, not a truthiness test: `GROUPING_ENABLED=flase` must refuse to
    // boot, not silently mean "true" (§12 — the process refuses to start on
    // bad config rather than failing mysteriously later).
    GROUPING_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * Jaccard floor on headline tokens for two articles to be one story.
     *
     * **Unmeasured** — the same gap that ended term-variant merging (§14.7),
     * named here rather than buried. Raise it if related-but-distinct stories
     * start collapsing; a false merge hides an article behind a toggle, and
     * ADR-0002's principle says that is worse than a visible duplicate.
     */
    GROUPING_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),

    /**
     * How many days of articles the storyline linker measures rarity against
     * (ADR-0011). A storyline is unbounded in time, so day-relative rarity
     * cannot serve it: the same token would be rare on Monday and common on
     * Wednesday, and whether Monday's group joins would depend on which day
     * it is asked. Fourteen is the starting knob ADR-0011 names, not a
     * commitment — S3's sweep is what pins it.
     *
     * Also what the nightly prune keeps, plus a day of slack — and since the
     * term cloud's `term_snapshots` went (ADR-0013), the only thing that prune
     * still deletes.
     */
    STORYLINE_DF_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(14),

    // --- storyline labels (ADR-0011, "Labels") ---
    /**
     * The repo's first external model dependency, and deliberately optional:
     * with no key the labeler falls back to the bigram extractor and, failing
     * that, leaves the storyline label-less — which renders. Nothing upstream of
     * the label blocks on it, so an unconfigured or down Gemini costs label
     * quality and nothing else.
     */
    GEMINI_API_KEY: z.string().trim().optional(),
    GEMINI_BASE_URL: z.url().default("https://generativelanguage.googleapis.com/v1beta"),
    /**
     * FLASH TIER, per ADR-0011 — the model id is a knob because the tier is what
     * the decision rests on, not this version string. Labels run at storyline
     * volume (births, merges and drifts, not articles), and every call has a
     * deterministic fallback, so the cheapest tier that can read ten headlines
     * is the right one.
     *
     * Pinned rather than floating (`gemini-flash-latest` exists): the same
     * coverage should name the same story on a replay, and an alias that
     * changes underneath us changes labels with no commit to point at.
     *
     * Not `gemini-2.5-flash`, which the live API refuses for new keys — "no
     * longer available to new users", measured 2026-08-14 — while still listing
     * it under `/models`. A model id that appears in the catalogue and 404s on
     * use is exactly why this is config and not a constant.
     *
     * `gemma-4-26b-a4b-it` ("a4b" = 4B active params, a MoE model), not a
     * Gemini model: `gemini-3.1-flash-lite` already spent ZERO thinking
     * tokens naming a storyline (see `gemini.ts`), and Gemma 4 26B publishes
     * double that tier's free-tier ceiling (30 rpm vs 15). Served from the
     * same endpoint (`GEMINI_BASE_URL`), so no client change was needed
     * beyond the id, `GEMINI_MAX_RPM` below, and `maxOutputTokens` in
     * `gemini.ts`. It DOES take a thinking level, contrary to what this
     * comment said until 2026-08-28 — see `GEMINI_THINKING_LEVEL`, which is
     * the difference between this model working and not.
     */
    GEMINI_MODEL: NonEmpty.default("gemma-4-26b-a4b-it"),
    /**
     * How much the model may think before answering. **Model-specific, and
     * paired with `GEMINI_MODEL` above — change one and check the other.**
     * The families spell this differently and reject each other's values.
     *
     * `minimal` for `gemma-4-26b-a4b-it`, and it is not a tuning preference —
     * it is what makes the model usable. Measured 2026-08-28 over the same ten
     * dev-archive storylines, live:
     *
     *   omitted   3 usable labels in 10, median ~43 s, 7 of them spending the
     *             whole 2,048-token budget on thinking and answering nothing
     *   minimal   **9 in 10, median 1.4 s, zero thinking tokens, no MAX_TOKENS**
     *
     * Left unset it is not "unconfigured", it is a model that reasons itself
     * into a wall on most prompts. Naming a storyline is recall, not
     * reasoning — the same finding flash-lite gave in August, reached the
     * other way round.
     *
     * The accepted values are narrow and the errors are unhelpful: gemma takes
     * `minimal`, 400s on `low` ("Thinking level is not supported for this
     * model") and 400s on `none` (not a valid enum value at all). A Gemini 3.x
     * flash model is the mirror image — `low` is its floor, `none`/`minimal`
     * are 400s — so switching `GEMINI_MODEL` back to one means clearing this
     * to empty or setting `low`, or every call 400s.
     */
    GEMINI_THINKING_LEVEL: z.string().trim().default("minimal"),
    /**
     * Per-call deadline. Labelling is never on a reader's path — it runs after
     * a promotion or merge has already been written — so a slow call should be
     * abandoned to the fallback rather than waited on.
     *
     * 20s, not the 8s this started at: measured over 20 live labels on
     * 2026-08-14, flash-lite averaged ~8s per call end to end and one label was
     * lost to the deadline outright. Generous is free here (nothing waits on
     * it) and a timeout costs a label.
     */
    GEMINI_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(20_000),
    /**
     * The tier's published request ceiling, per minute. THE KNOB: 30 is
     * `gemma-4-26b-it`'s free-tier figure (double `gemini-3.1-flash-lite`'s
     * 15); a paid tier raises it and this is the one number to change.
     *
     * It is a ceiling on the KEY, not on a caller, which is why it is enforced
     * inside the client (`gemini.ts`) rather than at each of the five places
     * that label something. The label passes also take it as their spacing, so
     * a backfill paces itself instead of queueing behind the client's pacer,
     * but the client is what makes the limit true.
     *
     * Overshooting costs more than the 429 it earns: labels are a background
     * chore with a deterministic fallback, so a burst that trips the limit
     * turns a batch of model labels into a batch of bigram ones — which are
     * sticky until the drift trigger fires. Slow is free here.
     */
    GEMINI_MAX_RPM: z.coerce.number().int().min(1).max(10_000).default(30),
    /**
     * Storylines one nightly label pass may relabel — the ceiling that makes the
     * pass fit a function's wall clock (VERCEL-ALL-IN-SCOPE §3.3).
     *
     * **A deployment parameter, not an operator convenience**, which is the
     * whole reason it is here rather than only behind `--max-labels`. On Hobby
     * the chores route has 300 s, against the pass's own code default of 500 —
     * so an unbounded night exceeds the function ceiling long before it exceeds
     * the daily quota, and what a truncated night loses is not latency but the
     * `chore_runs` row and the passes ordered after the label one.
     *
     * **The window is spacing PLUS latency, which is why a COUNT is a poor
     * bound on a CLOCK.** Phase 0's 40-60 (findings §2, the source of this 50)
     * counted pacing alone — 75 x 4 s at the old 15 rpm — but `labelPass` is
     * sequential: it sleeps the spacing and THEN awaits the call, so the two
     * add. That holds whatever the model does; what it does not do is yield a
     * replacement number, and this comment will not invent one.
     *
     * **Re-derived 2026-08-28 against the repaired client** (#177), on the dev
     * key with real dev-archive prompts and the pacer off. 10 storylines:
     *
     *   - **3 produced a usable label**, in 20.4 s / 23.8 s / 36.8 s;
     *   - **7 returned no answer at all**, each burning the whole 2,048-token
     *     budget on thinking (`MAX_TOKENS`, ~2,046 thought tokens) in ~43 s.
     *
     * A label therefore costs ~40 s of wall clock on average (2 s of spacing at
     * 30 rpm plus ~38 s of call), which means `CHORE_LABEL_BUDGET_MS`'s 240 s
     * admits about **6**. Not 75, not 50.
     *
     * **50 stays anyway, and the reason is that the count is no longer the
     * clock bound.** `CHORE_LABEL_BUDGET_MS` is, and a budget is right where a
     * count is wrong: it holds at whatever a label happens to cost, so it does
     * not need re-deriving every time latency moves. Pinning this to 6 would
     * bake TODAY's latency — which is pathological, see below — into a
     * deployment parameter, and would throttle a healthy pass to 6 labels a
     * night once it is not. What this number still does is bound SPEND, and at
     * 14,400 requests/day 50 is nothing. The bound costs nothing durable
     * either way: the pass is resumable across nights — it selects the
     * storylines whose labels are missing or drifted — so a bound defers labels
     * rather than dropping them.
     *
     * **Why "pathological".** The 7 failures are not a budget that wants
     * raising. Re-run at `maxOutputTokens` 8192, two of them ran to 8,190 and
     * 8,189 thought tokens — 172 s apiece — and still answered nothing, while
     * the successes reproduced exactly (944 and 1,103 thought tokens, the same
     * seconds; temperature is 0, so the split is the PROMPT, not sampling). The
     * cap is a circuit breaker on runaway reasoning, not a budget: raising it
     * turns a 43 s failure into a 172 s one. See `gemini.ts`.
     *
     * `--max-labels` still overrides it, which is what an operator draining a
     * backlog against a clone wants. The default moved from "unbounded" to this
     * on purpose: an unbounded run is now the deliberate act.
     */
    CHORE_MAX_LABELS: z.coerce.number().int().min(1).max(100_000).default(50),
    /**
     * Wall-clock ceiling for one nightly label pass, in ms — the OTHER half of
     * the bound above, and the half that is actually about the function's
     * deadline.
     *
     * `CHORE_MAX_LABELS` counts storylines, and its comment derives the count
     * from a duration: 4 s of pacing each, so ~75 fills 300 s. That arithmetic
     * has a term missing. A label costs pacing PLUS the model call, and the
     * call is the larger term — ~8 s measured on 2026-08-14, and on 2026-08-28
     * production ran 50 labels in ~25 minutes because every call was burning a
     * full thinking generation before failing the label contract. The function
     * was killed at 300 s: the `chore_runs` row stayed open, and the label-merge
     * and graph passes never ran.
     *
     * So the count cannot bound the clock, because the count does not know what
     * a label costs today. This does, and it is the bound that matches what the
     * platform enforces.
     *
     * **240 s against `api/chores.ts`'s 300 s `maxDuration`.** The 60 s of
     * headroom is for the passes ORDERED AFTER the label one — the label-agreement
     * merge and the graph read — plus the two chore_runs writes. Those are what
     * a killed pass loses, and leaving room for them is the whole point of
     * stopping rather than being killed. It is not a limit on how much labelling
     * gets done: the pass is resumable, so what a budget defers, the next night
     * selects.
     *
     * Raise it with `maxDuration`, never past it. The CLI passes nothing, which
     * is unbounded — a laptop run has no function ceiling and a terminal in front
     * of it.
     */
    CHORE_LABEL_BUDGET_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(240_000),
    /**
     * How long a label may wait for a rate-limit slot before giving up on the
     * model and taking the fallback. Bounds the pacer's queue, which the live
     * ingest tail would otherwise grow without limit during a promotion burst.
     */
    GEMINI_MAX_RATE_WAIT_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(900_000)
      .default(120_000),
    /**
     * Relabel when membership has multiplied by this since the label was made
     * (ADR-0011's drift trigger, "membership doubled"). A label describes the
     * coverage it was shown; at twice the groups it is describing a minority of
     * the story. Below 2 this would relabel on ordinary growth and turn a
     * storyline-volume cost into a group-volume one.
     */
    STORYLINE_LABEL_DRIFT_FACTOR: z.coerce.number().min(2).default(2),
    /**
     * How many member headlines the label is generated from. ~10 per ADR-0011:
     * enough for the model to see what the story IS rather than what its latest
     * turn was, and few enough that the prompt stays a flash-tier call.
     *
     * It also arms the bigram fallback's support floor, which is the one reason
     * to think twice before lowering it: that floor reads the SAMPLE it was
     * handed, not the storyline, so a value under 5 turns it off for arcs of any
     * size (`SUPPORT_FLOOR_AT_MEMBERS`, `bigram-label.ts`) and the all-support-1
     * lottery it exists to stop comes back.
     */
    STORYLINE_LABEL_SAMPLE: z.coerce.number().int().min(2).max(40).default(10),
    /**
     * Days of silence a shared label may bridge before the label-agreement merge
     * stops treating two arcs as one story (`storyline-label-merge.ts`).
     *
     * MEASURED once the label backfill gave the dev archive 855 model-labelled
     * storylines (2026-08-17). Two shared labels are separated by a real gap, and
     * they want opposite answers:
     *
     *   - "Kyle Shanahan car crash" — 12 days between the crash and the admission
     *     of fault. One story that went quiet. Should merge.
     *   - "Canada US tariff talks" — 19 days between two rounds of the same
     *     recurring negotiation. Two arcs ADR-0010's date span is right to keep
     *     apart. Should not.
     *
     * 14 is the only setting in the archive that gets both right: 7 refuses the
     * Shanahan merge that should happen, 20 accepts the tariff merge that should
     * not. The value therefore sits on data now rather than on the argument, but
     * on a sample of two — a third separated component is worth re-reading this
     * knob against.
     */
    STORYLINE_LABEL_MERGE_GRACE_DAYS: z.coerce.number().int().min(0).default(14),
    /**
     * Safety valve on one label's component, in storylines — not a tuning knob.
     * A model label that turned out both generic AND grounded would otherwise
     * collapse an unbounded number of arcs in a single pass, which is the
     * percolation shape ADR-0009's 1,179-group swallow taught this codebase to
     * fear. A refused component is logged by name and left alone.
     *
     * 25 admits every real component measured (the largest is six) with an order of
     * magnitude to spare, and still refuses a swallow.
     */
    STORYLINE_LABEL_MERGE_MAX_COMPONENT: z.coerce.number().int().min(2).default(25),

    // --- storyline day summaries (ADR-0023, docs/STORYLINE-SUMMARIES.md) ---
    /**
     * The historical preserve, OFF on merge.
     *
     * The same posture ADR-0011's linker shipped with, and for the same reason:
     * this is the second thing in the system that spends model quota per call,
     * on a key the labeler is already pacing itself against, so the code merges
     * and deploys before it starts spending. Turning it on is a deliberate act
     * with a night's cost attached, not a default somebody inherits.
     */
    // An enum, not a truthiness test, for the reason `GROUPING_ENABLED` gives:
    // `SUMMARIES_ENABLED=ture` must refuse to boot rather than quietly meaning
    // "false" and leaving a preserve nobody notices is empty.
    SUMMARIES_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * The model that writes the sentences. Defaults to the labeler's, which is
     * not the same as BEING the labeler's: the knob exists so the two can
     * diverge — one names a story in three words, the other writes prose about
     * it, and those are different asks that may want different models.
     *
     * **A different model id is not a different rate limit.** The ceiling
     * belongs to the KEY, so the summariser's client shares the labeler's pacer
     * (`wiring.createModelPacer`); pointing this at another model without that
     * sharing would silently double the rate through one key, which is exactly
     * the contention that collaterally bigram-fell-back 37 organic promotions
     * during a paced relabel campaign.
     */
    SUMMARY_MODEL: NonEmpty.default("gemma-4-26b-a4b-it"),
    /**
     * Paired with `SUMMARY_MODEL`, exactly as `GEMINI_THINKING_LEVEL` is paired
     * with `GEMINI_MODEL` — the families spell this differently and reject each
     * other's values, and gemma is unusable without `minimal`. Change one, check
     * the other.
     */
    SUMMARY_THINKING_LEVEL: z.string().trim().default("minimal"),
    /**
     * The key the summariser calls on. Unset — the default — it uses
     * `GEMINI_API_KEY` and shares that key's pacer with the labeler.
     *
     * Set to a SECOND key, the two lanes stop competing: summaries can no longer
     * starve live labelling into bigram fallbacks, at the cost of a second
     * credential to rotate. The knob exists now, unset, so splitting the lanes
     * later is an environment change rather than a code change — and so that the
     * shared-pacer behaviour above is a decision this file records rather than
     * an accident of there being one key.
     */
    // `|| undefined`, not a bare `.optional()`: an env var that is PRESENT and
    // EMPTY — which is exactly what `.env.example` ships and what a dashboard's
    // blank field sends — parses as `""`, and `SUMMARY_API_KEY ?? GEMINI_API_KEY`
    // does not fall through an empty string. Without this, copying the example
    // file and filling in `GEMINI_API_KEY` gives a working labeler and a
    // summariser with no model at all, silently.
    SUMMARY_API_KEY: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || undefined),
    /**
     * Days after a UTC day closes during which its sentences may still be
     * rewritten. Past this the day is frozen, which is what makes it a preserve.
     *
     * 3, because a day's article set is not settled when the day ends: the
     * linker attaches late groups, the bridge sweep re-parents, and the nightly
     * pass runs five hours after midnight. Frozen-on-first-write would enshrine
     * whatever the first five hours caught, which for a story breaking at 23:00
     * UTC is close to nothing. Unbounded revision is the other failure: every
     * night would re-read all of history looking for changes.
     */
    SUMMARY_SETTLING_DAYS: z.coerce.number().int().min(0).max(30).default(3),
    /**
     * Articles a span must GAIN, inside the window above, before it is worth a
     * model call to rewrite its sentence. Strictly greater than: 4 means five
     * new articles trigger a rewrite.
     *
     * Without it the window alone would rewrite a day for a single late
     * aggregator copy — three extra calls for a sentence that would come back
     * the same.
     */
    SUMMARY_RECOMPUTE_DELTA: z.coerce.number().int().min(0).default(4),
    /**
     * Articles a UTC day must exceed, across a storyline's member groups, before
     * that day is preserved at all. Strictly greater than: 4 means five.
     *
     * Paired with `SUMMARY_MIN_GROUPS` below, and the pairing is the point — see
     * that knob.
     */
    SUMMARY_MIN_ARTICLES_PER_DAY: z.coerce.number().int().min(1).default(4),
    /**
     * Distinct member GROUPS the same day must have, alongside the article count
     * above. Both bars, ANDed.
     *
     * They are not the same test and the difference is the common case in this
     * corpus: one wire story syndicated six times is six articles in ONE group.
     * It clears a volume bar and is not a day's coverage — it is one telling,
     * repeated, and five sentences describing it would be five ways of saying
     * the same headline. 2 is the lowest bar that means "more than one telling".
     */
    SUMMARY_MIN_GROUPS: z.coerce.number().int().min(1).default(2),
    /**
     * Articles that reach the prompt — a DAY's worth since ADR-0027.
     *
     * It was `SUMMARY_SEGMENT_SAMPLE`, it was 8, and 8 was the right number for
     * a sixth of a day. One call now carries the whole day, so the question is
     * no longer "how much of a quarter" but "how much of a day, at what rate".
     *
     * 12 is where the token window puts it, and the arithmetic is worth having
     * written down because it couples this knob to `SUMMARY_MAX_RPM`:
     *
     *   measured, under the quarters: ~490 input tokens per call averaged over
     *   four article calls and one cheap call over their sentences, so an
     *   8-article call is ~580 and an article is ~60 of that.
     *
     *   12 articles ≈ 820 tokens. At `SUMMARY_MAX_RPM` 18 that is ~14.8k
     *   against the key's 16k input-tokens-per-minute ceiling — the same ~14k
     *   the old shape sat at, which is the number to hold.
     *
     * **Raising this means lowering `SUMMARY_MAX_RPM` by the same product.** The
     * pacer counts CALLS and the key also meters TOKENS, so a sample raised on
     * its own buys a rate limit nothing in this process can see: the pass would
     * keep its spacing and the key would start refusing, which reads here as
     * `unavailable` — no row, no attempt, and a night that quietly writes less.
     */
    SUMMARY_DAY_SAMPLE: z.coerce.number().int().min(1).max(40).default(12),
    /**
     * Asks one span gets before it is retired.
     *
     * Prose has no deterministic fallback — a sentence assembled from tokens
     * would be worse than silence — so a refusal is a row with a null summary
     * and this counter, which is what makes "the model would not answer for the
     * Big Bend afternoon of the 14th" a queryable fact rather than an absence
     * indistinguishable from "no articles that afternoon".
     */
    SUMMARY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    /**
     * How far back one nightly summary pass looks for qualifying days.
     *
     * 8, and it needs its own reason now. It used to have a borrowed one — it
     * was deliberately equal to `SUMMARY_CLIFF_DAYS`, so that the nightly pass
     * covered exactly the span over which the six-hour quarters were still
     * honest. ADR-0027 removed the quarters and with them the cliff, so that
     * argument is gone and the number is not.
     *
     * What justifies it now is the split between UNATTENDED and ATTENDED spend.
     * This window bounds what the nightly pass sweeps across every arc with
     * nobody watching; a reader opening a storyline submits that arc's own
     * unsummarised days whatever their age (ADR-0027's click plane), so the
     * window is no longer the only thing that can reach an old day. It buys a
     * predictable night rather than completeness, and completeness now has its
     * own path.
     *
     * Wider than `SUMMARY_SETTLING_DAYS` on purpose — that governs which days
     * are still open to REVISION, this governs which are still looked at, and a
     * slow story that only crosses the article bar on its fourth day still needs
     * to be seen.
     */
    SUMMARY_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(8),
    /**
     * Model calls one nightly summary pass may spend. Since ADR-0027 a day costs
     * exactly one, so this IS a count of days — it keeps the name because what
     * the key meters is calls.
     *
     * **It is a SPEND bound, and `SUMMARY_BUDGET_MS` is the clock bound — the
     * same split `CHORE_MAX_LABELS` and `CHORE_LABEL_BUDGET_MS` make, and the
     * same warning applies: do not read this number as a duration.** The budget
     * is what should stop a healthy night; this is the backstop behind it.
     *
     * **So it has to stay ABOVE what a firing can physically spend.** The pacer
     * caps a firing at `SUMMARY_MAX_RPM / 60 * SUMMARY_BUDGET_MS` — ~82 calls at
     * 18 rpm and 275 s, down from 128 when the rate was 28. The ceiling is
     * further above the clock than it has ever been, which is the right side to
     * err on: a spend bound that quietly becomes the binding one is not a
     * failure anything reports — the night just ends early, correctly, for a
     * reason nobody chose.
     *
     * Note what those ~82 calls now BUY, because the units changed underneath
     * this number: 82 days, where the same firing used to reach 14-25 of them.
     *
     * Raising `SUMMARY_MAX_RPM` or `SUMMARY_BUDGET_MS` means re-checking that
     * product.
     *
     * What a bounded night costs is bounded too, and deliberately so: the walk
     * spends a bounded share on the newest days and the rest OLDEST-day-first,
     * so the ceiling still reaches the days closest to falling out of
     * `SUMMARY_WINDOW_DAYS`. See `SUMMARY_FRESH_DAYS`.
     */
    SUMMARY_MAX_PER_RUN: z.coerce.number().int().min(1).max(100_000).default(200),
    /**
     * Wall-clock ceiling for one summary pass, in ms — the bound that matches
     * what the platform enforces, exactly as `CHORE_LABEL_BUDGET_MS` is for the
     * label pass.
     *
     * **275 s, and it is only safe because the pass now aborts what it cannot
     * stop.** The budget bounds when a call is ADMITTED; a call in flight runs
     * to 3 x `GEMINI_TIMEOUT_MS` plus backoff, up to 60.75 s more, against a
     * 300 s `maxDuration`. `runSummaryChore` now arms an abort at
     * budget + `SUMMARY_ABORT_GRACE_MS`, so the tail is 10 s rather than 61,
     * and the sum that has to clear 300 s is:
     *
     *     2.1 s boot + 275 s + 10 s grace + ~1 s `chore_runs` = ~288 s.
     *
     * Both halves of that were measured on production, 2026-09-16. Raising this
     * means re-doing that arithmetic; being killed costs a `chore_runs` row with
     * a null `finished_at`, which `check-chores.sh` reads as a failed night.
     */
    SUMMARY_BUDGET_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(275_000),
    /**
     * Model calls per minute the summary PASS paces itself at.
     *
     * Its own knob rather than `GEMINI_MAX_RPM`, and deliberately BELOW it. The
     * pass used to sleep a full interval after each answer, so it ran at
     * `60000 / (spacing + latency)` — 18 calls a minute against a key that
     * allows 30, with ~40% of every firing spent asleep. Spacing now overlaps
     * latency (`SummaryPassOptions.ratePerMinute`), which means the configured
     * rate is the rate actually achieved, and a pass configured at the key's
     * ceiling would leave nothing for anything else on that key.
     *
     * **18, down from 28, and the reason is tokens rather than calls.** The
     * drain's organic label promotions are ~5 a night in these hours and they
     * share both the rpm window and the 16k input-tokens-per-minute one. Under
     * the quarters a call averaged ~490 tokens and 28 of them sat at ~14k; under
     * ADR-0027 every call carries a whole day's sample, ~820 tokens at
     * `SUMMARY_DAY_SAMPLE` 12, and 28 of those would be ~23k — over the ceiling,
     * which the pacer cannot see because it counts calls. 18 puts it back to
     * ~14.8k. A label that cannot queue takes the bigram fallback, and a bigram
     * label is sticky until membership doubles.
     *
     * **A lower rate is not less work here.** A day cost up to five calls and
     * now costs one, so 18 calls a minute is ~18 days a minute against the ~5.6
     * that 28 bought — the rate went down and the throughput more than tripled.
     *
     * This knob and `SUMMARY_DAY_SAMPLE` are two halves of one budget; moving
     * either without the other is what silently pushes the key over its token
     * ceiling. With `SUMMARY_API_KEY` set the lanes do not compete on the rpm
     * window — but the token limit is per key too, so the product still binds.
     */
    SUMMARY_MAX_RPM: z.coerce.number().int().min(1).max(10_000).default(18),
    /**
     * Days at the NEWEST end of the window the nightly pass walks first, newest
     * first, before its oldest-first walk over the whole window. 0 turns the
     * phase off and restores ADR-0023's original single walk.
     *
     * 3, matching how long a day stays open to revision — but read from its own
     * knob rather than `SUMMARY_SETTLING_DAYS`, because the two answer different
     * questions (what may be REWRITTEN versus what is walked FIRST) and a shared
     * number is how one of them silently changes the other later.
     */
    SUMMARY_FRESH_DAYS: z.coerce.number().int().min(0).max(30).default(3),
    /**
     * The share of `SUMMARY_BUDGET_MS` that first walk may spend before it
     * yields to the oldest-first one.
     *
     * It is BOUNDED because ADR-0023's argument for oldest-first is still right:
     * the days about to fall out of `SUMMARY_WINDOW_DAYS` are the ones that
     * cannot wait, and an unbounded fresh phase could spend a whole night on the
     * newest end and lose them for good.
     *
     * At 0.6, an ~82-call firing reserves ~49 calls for the newest days and ~33
     * for the old end. Both sides of that were sized against measured demand,
     * and ADR-0027 divided that demand by five: one new UTC day cost 107-211
     * calls under the quarters and costs ~21-42 now, and the largest
     * back-history burst seen was ~400 calls, which is ~80 days. So a single
     * firing's fresh share now covers a new UTC day outright, where it used to
     * take several — which is the starvation this phase was added to fix,
     * fixed again from the other end.
     */
    SUMMARY_FRESH_SHARE: z.coerce.number().min(0).max(1).default(0.6),
    /**
     * Model calls ONE storyline open may submit (ADR-0027's click plane).
     *
     * A click hands the arc's unsummarised qualifying days to the queue; this is
     * how many of them one click buys. The rest wait for the next open, which is
     * a deferral rather than a loss — a reader who keeps coming back to an arc
     * is exactly the reader whose arc is worth summarising.
     *
     * 8 by the same logic ADR-0017 used for the refresh plane it rides beside:
     * a click buys the part of the history a reader can see, and typing the
     * words is what buys the rest. It is the number to change if click-driven
     * summaries turn out to be the cheap way to backfill, and the number to
     * watch if they turn out to be the expensive way to drain a key.
     *
     * **What bounds this ACROSS arcs is the per-IP ceiling and nothing else**,
     * which is stated rather than defended. Every open of a distinct UUID is its
     * own 8, and UUIDs are public on every timeline page.
     *
     * The pacer is NOT a second guard here, and it is worth being exact because
     * the obvious reading is wrong: `createPacer` holds its window in memory and
     * is built once per process (`wiring.ts`), so concurrent consumer
     * invocations are concurrent PACERS. `SUMMARY_MAX_RPM` bounds one job, not
     * the key. At `RATE_LIMIT_PER_MINUTE` 120 the demand one IP can queue is
     * well above what the key allows in a day, and what absorbs the excess is
     * the model refusing — which reads here as `unavailable`, writes no row and
     * spends no attempt, so nothing is corrupted and the labeler's promotions
     * fall back to the bigram extractor.
     *
     * ADR-0017 accepted the same shape for its own plane and the note there
     * applies: a global daily ceiling is the fix if this bites. The difference
     * worth flagging is that ADR-0017's budget refills daily and this one is
     * shared with the labeler in the same minutes.
     */
    SUMMARY_CLICK_MAX_DAYS: z.coerce.number().int().min(0).max(200).default(8),
    /**
     * Wall-clock ceiling on one click's summary job, in ms.
     *
     * Its own knob rather than `SUMMARY_BUDGET_MS`, because the two run under
     * different platform deadlines and the whole point of a budget is to sit
     * under the one that actually applies. The nightly pass runs on
     * `api/chores.ts`; this runs on the queue consumer — and, for an orphaned
     * pending entry, on `api/drain.ts`, which is the tighter of the two and the
     * one that sizes this number.
     *
     * **45 s, because the drain's headroom is 60 s.** `DRAIN_DEADLINE_MS` is
     * 240 s against a 300 s `maxDuration` and is checked BETWEEN jobs, never
     * inside one — its own comment sizes that gap as "room for one long fill
     * plus the response". A job dispatched at 239 s therefore gets 60 s before
     * the function is killed, and being killed there costs every later entry in
     * that pass its settle. With `runSummarizeJob`'s abort ten seconds past this
     * budget plus one unabortable backoff (≤ 500 ms), the worst case is ~55.5 s,
     * which fits. At 120 s it was ~130 s, which did not.
     *
     * It is not tight for the WORK: the job's total is
     * `max(7 × spacing + latency, 8 × latency)` — spacing runs from a call's
     * START, so latency overlaps it until latency exceeds the interval — which
     * at `SUMMARY_MAX_RPM` 18 and the measured ~1.3 s is ~24.6 s.
     *
     * **The bound binds when average latency passes ~5.6 s**, at which point the
     * eighth call is refused and the job reports `budget`. That is the number to
     * hold in mind rather than the 45: `GEMINI_TIMEOUT_MS` is 20 s with two
     * retries, so one pathological call can now consume the whole budget where
     * at 120 s it could not. The consequence is self-healing — the abort reads
     * as `unreachable`, writes no row and spends no attempt, so the next open
     * plans those days again — which is why the tighter budget is the right
     * trade against being killed mid-pass on the drain.
     */
    SUMMARY_CLICK_BUDGET_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(45_000),
    /**
     * How many live storylines must share one label before the ingest tail runs
     * the label-agreement merge for that label, without waiting for the nightly
     * chore. 0 turns the trigger off; the nightly pass still runs either way.
     *
     * 2 — the merge machinery's own bar — is the only defensible setting, and the
     * 2026-08-21 backfill is why: of the six collision components it produced,
     * three held exactly two arcs. A higher threshold leaves every pair standing
     * until a scheduled pass runs, which on a host with no scheduler is forever;
     * this knob exists to make that pass event-driven, so a value that recreates
     * the wait defeats it. It is a knob at all only as an off-switch with a
     * paper trail, not because 3 is a setting anyone should run.
     *
     * 1 is refused rather than accepted-and-ignored. It reads like "fire on
     * every label" and cannot: `sharedLabels` drops any bucket holding fewer
     * than two storylines, so a threshold of 1 pays a full candidate read and
     * bucketing for every model label written and can never plan a merge. Off
     * is 0; on is 2 or more.
     */
    STORYLINE_LABEL_MERGE_TRIGGER: z.coerce
      .number()
      .int()
      .min(0)
      .refine((value) => value !== 1, {
        message:
          "STORYLINE_LABEL_MERGE_TRIGGER=1 costs a candidate read per label and can never merge (a shared label needs two holders). Use 0 to disable, or 2.",
      })
      .default(2),
    // --- request traces and the playback view (ADR-0029, ADR-0031) ---
    /**
     * Off by default. When on, every request to a traceable route is recorded as
     * the stations it touched and what it asked for (ADR-0031), the newest ten are
     * listed, and any of them can be played back at `/?trace`. There is no token:
     * the flag IS the opt-in, and while it is on anyone who can reach the API can
     * collect every traced request's searches and storylines by polling the list,
     * and read each trace by id until its TTL. An enum, not a truthiness test,
     * for the reason GROUPING_ENABLED gives: `REQUEST_TRACE_ENABLED=ture` must
     * refuse to boot.
     *
     * Off means ABSENT rather than idle: no hook, no route, no decorator and no
     * consumer-side lookup is registered, so an untraced deployment runs exactly
     * the code it ran before the feature existed. On costs one `SMEMBERS` per job
     * delivery and four commands per traced request, which is why the operating
     * policy is on for a session, then off.
     */
    REQUEST_TRACE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * How long a trace, its job links and its job runs live. ≥ 1800 because a
     * drained run arrives 15–25 minutes after enqueue (drain.ts takes entries
     * ≥ 900 s old, on a 10-minute cadence, supabase-cron.sql) and must still find
     * its link — below that floor the drain's runs would silently never join.
     */
    REQUEST_TRACE_TTL_SECONDS: z.coerce.number().int().min(1_800).max(86_400).default(3_600),
    /**
     * Touches kept per record; past it the head (60%) and tail are kept and the
     * middle is elided and counted. The ceiling is MAX_TRACE_TOUCHES (400,
     * @zammy/shared), repeated as a literal because config does not depend on
     * shared; `apps/api/src/trace-redact.test.ts` pins the two equal.
     */
    REQUEST_TRACE_MAX_TOUCHES: z.coerce.number().int().min(32).max(400).default(240),
    // --- the v2 linker (ADR-0011); every default below is pinned from
    //     `pnpm measure:storylines-v2`, recorded in docs/STORYLINE-LINKING.md ---
    // There is deliberately NO storyline on/off switch here any more.
    //
    // STORYLINES_V2 selected between two models and migration 0012 dropped the
    // other one; STORYLINE_ENABLED gated the day-clustering pass, which is
    // gone. What replaced them cannot be a knob: the timeline pages over
    // `storyline_days`, and every group's provisional storyline-of-one is what
    // puts a row there. Turning linking off does not degrade the timeline to
    // plain slots — measured, it empties it — so a flag would be an outage
    // switch wearing a feature flag's clothes. Rolling the cutover back is a
    // deploy revert plus `migrate down`, not a boolean.
    /**
     * A shared token anchors a link only below this share of the TRAILING
     * corpus. MEASURED: 0.002 (≈32 articles of a 16k fortnight) is where
     * beat-and-boilerplate storylines stop forming — at 0.005 the sweep builds
     * a "White House press secretary" storyline that swallows every briefing
     * regardless of subject, and at 0.01 a stock-ratings one. Below 0.002 real
     * coverage starts fragmenting (the largest genuine storyline halves).
     */
    STORYLINE_ANCHOR_MAX_SHARE: z.coerce.number().min(0).max(1).default(0.002),
    /**
     * Floor under that share, in articles: a share of a small corpus is noise.
     * UNMEASURED — English never reaches it (0.002 of 16k is 32), so it only
     * binds for a language whose window holds under ~5,000 articles, and the
     * dev archive has no such language to measure against.
     */
    STORYLINE_ANCHOR_DF_FLOOR: z.coerce.number().int().min(1).default(10),
    /**
     * Floor on the summed rarity (Σ ln(N/df)) of what a group and a storyline
     * share. MEASURED: at 20, 41% of groups attach and the largest storyline
     * holds 35 groups (0.18% of the corpus); 16 is the looser alternative
     * measured (52% attach, largest 63). NOT transferable from ADR-0009's 8 —
     * masses scale with ln(corpus), and the corpus grew eleven-fold.
     *
     * Note this is NOT the lever against boilerplate: syndicated legal
     * disclaimers share many moderately-rare tokens, so raising mass makes
     * them MORE prominent, not less. The anchor share is that lever.
     */
    STORYLINE_MASS_THRESHOLD_V2: z.coerce.number().min(0).default(20),
    /**
     * K: independent groups that must bridge two storylines before they merge.
     *
     * MEASURED, and **the measurement does not model the merge it is bounding.**
     * The original reading — K=1 quadruples merges (826 → 3,416) for no gain in
     * the alarm, K=2 is where it settles — came from a replay that drops the
     * loser's bridge evidence on a merge, where `mergeStorylines` re-points it
     * onto the winner and `cascadeMerge` then takes every pair the re-point
     * pushed to K. With that modelled, the same bar and corpus build a
     * **2,591-group** arc on the BIRTH path alone (9.96% of the window) where the
     * harness reported 72, and K would have to reach ~6 to bring the alarm back
     * near 100.
     *
     * K is therefore left at 2 deliberately rather than confidently: raising it
     * is the bluntest of the four levers measured — it raises the bar for every
     * merge, and ADR-0011 refuses to build a split, so the merge is the only
     * repair err-narrow formation has. On the birth path, bounding how many
     * qualifiers one group may bridge beats it on the alarm decisively (largest
     * 22 against K=6's 85) and on the model-named arcs marginally, and that is a
     * change to `bridgePairs`' input rather than to this number.
     * docs/STORYLINE-LINKING.md, "K, re-measured against a replay that
     * re-offers", has the four options priced against one instrument — including
     * where a higher K is the better lever, which is the sweep-on numbers, which
     * is not a state anything runs in.
     *
     * The birth-path figures above are unaffected by the 2026-08-23 correction to
     * that harness (it double-counted a doubly-homed group's membership, which
     * only a re-offer can produce) and were re-run to confirm it.
     */
    STORYLINE_MERGE_BRIDGES: z.coerce.number().int().min(1).default(2),
    /**
     * At most this many of a group's qualifiers may BRIDGE, taken best mass
     * first. **0 is unbounded, and unbounded is the default** — today's
     * behaviour exactly, so this knob changes nothing until it is set.
     *
     * `bridgePairs` is the full O(n^2) cross-product over a group's qualifiers,
     * so a 40-qualifier group writes 780 pairs. That pair count, not K, is what
     * feeds the loop: more pairs reach K, each merge unions two profiles,
     * `mergeStorylines` re-points the loser's bridges onto the winner rather than
     * dropping them, and a wider profile overlaps more on the next arrival. This
     * bounds the quadratic term at source. It bounds the PAIRING only — the
     * attach still picks the group's best qualifier, and the retroactive path
     * still picks the best arc the group is not already in — so it costs
     * evidence, never linking.
     *
     * MEASURED against the re-offering replay (docs/STORYLINE-LINKING.md, "The
     * four options"), retrieval NARROWED, K=2, cascade modelled: on the BIRTH
     * path — the one that is live — the top 2 takes the largest arc from 2,591
     * groups to 22, where K would have to reach 6 for 85. On the sweep-on
     * numbers a higher K is the better lever (299 against K=6's 205), which is
     * not an argument for K=6 because the sweep is off.
     *
     * **There is no gentle version, and that is a finding rather than an
     * inconvenience.** 2 is decisive because two qualifiers is exactly one pair,
     * so the cross-product is gone rather than smaller. At 3 the largest arc is
     * 2,760 and at 5 it is 4,145 — a tenth to a sixth of the window either way.
     * Anything above 2 is close to doing nothing, so this is a switch wearing a
     * number's clothes.
     *
     * **And it is not free.** It removes most of the merge, which ADR-0011 makes
     * the only repair err-narrow formation has (4,608 merges to 2,106 sweep-on).
     * Read rather than counted: at the top 2 the FedEx/PGA tournament run comes
     * out as a 23-group arc where the sweep built the 151-group FIFA/Infantino
     * arc this document judged coherent end to end, and Canada tariff coverage
     * splits into ten narrow arcs. That is err-narrow, which ADR-0011 prefers,
     * and it is a real cost rather than a rounding error.
     *
     * **Its own knob rather than a property of `STORYLINE_NARROW_RETRIEVAL`, and
     * the reason is the opposite of that flag's.** There the two halves are
     * coupled because the split state — broad probe, 4,000-row cap — is worse
     * than either mode, so it must be unreachable. Here no combination is worse
     * than both: narrowed-and-bounded is the recommended state, narrowed-and-
     * unbounded is today's measured baseline, and broad-and-bounded is merely
     * stricter than today rather than dangerous. What coupling would cost is
     * measurement: every number in the option table was taken at narrowed and
     * unbounded, and folding the bound into that flag would make the baseline
     * unreproducible. A configuration nothing can reach is also a configuration
     * nothing can re-measure, which is the mistake §2.5 records one level up.
     *
     * Turn it on WITH `STORYLINE_NARROW_RETRIEVAL`, not instead of it: narrowing
     * is what widens the qualifier set, and this is what makes that safe.
     * Measured on the BIRTH path from production's own cap-built starting state,
     * which is the configuration a rollout would actually walk: narrowed and
     * unbounded merges at 0.256 per arriving group and takes the largest arc to
     * 71 in a week; narrowed and bounded at the top 2 merges at 0.034 and ends
     * at 22, below the 31 that leaving both off leaves. And bounded, the
     * cap-built and from-scratch archives both land on 22 — the hybrid's two
     * starting states stop being distinguishable, because the cross-product was
     * the mechanism that made them differ (VERCEL-PHASE-0-FINDINGS §2.7 step 1).
     * `storyline-replay.ts` reads the same value through the same
     * `bridgePairs`, so the sweep models whichever bound is configured — do not
     * let the two diverge (§2.5 is what that costs).
     */
    STORYLINE_MAX_BRIDGING_QUALIFIERS: z.coerce.number().int().min(0).default(0),
    /**
     * Withhold a FORMATION — two singleton groups becoming a real storyline —
     * until a model has been asked whether they cover one story (ADR-0011's
     * amendment). Off restores the pre-gate behaviour exactly: the linker merges
     * synchronously and the label is asked for afterwards.
     *
     * MEASURED, and it is the first lever here that is not a bidirectional
     * trade. docs/STORYLINE-LINKING.md records thirty-one token thresholds
     * across five families, every one destroying more model-named arcs than it
     * prevents unnameable piles; the verdict catches 85.2% of the declined set
     * at two groups for a true cost of 1-5 in 86.
     *
     * Three things keep it safe, and none of them is this flag:
     *  - only an EXPLICIT "not one story" refuses. An unavailable, slow or
     *    out-of-quota model forms the storyline, exactly as today — the dev key's
     *    ceiling is 500 requests a day and the labelling campaign exhausts it, so
     *    silence-as-refusal would dissolve the archive on a quiet Tuesday.
     *  - it fires ONLY where the winner was a provisional-of-one
     *    (`mayRefuseFormation`). The same verdict wrongly refuses 43% of the
     *    archive's arcs at 20 groups or more, so it never sees one.
     *  - it DEFERS rather than reverts, because a promotion undone is the split
     *    ADR-0011 refuses to build.
     *
     * The flag exists anyway because this is the one linking decision that
     * depends on an external model, and an operator who suspects the prompt has
     * regressed needs a way to stop it that is not a deploy. It has no effect
     * without a GEMINI_API_KEY — with no model there is no verdict to wait for,
     * and deferring would only lose formations.
     */
    STORYLINE_COHERENCE_GATE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * Probe candidate retrieval with the ANCHOR-ELIGIBLE subset of the group
     * profile, capped at 4,000 rows, instead of the whole profile capped at 200
     * (`candidateRetrieval`, `storyline-link.ts`). Off is the pre-2026-08-22
     * behaviour exactly: whole profile, `limit 200`.
     *
     * **It is one flag for two changes because they are a pair, and the split
     * state is worse than either.** The subset is a proven necessary condition —
     * `qualifyingStorylines` rejects a candidate whose rarest shared token is
     * above `anchorCeiling`, so a storyline sharing no eligible token cannot
     * qualify — and 4,000 is a census of THAT probe: it binds on 0 of the dev
     * archive's 12,366 window groups, where 200 binds on 1,131. The broad probe
     * returns p50 1,903 rows and max 8,054, so whole profile with a 4,000 cap is
     * not "the old behaviour, roomier": it is the broad probe with its only bound
     * effectively removed, feeding an O(n^2) `bridgePairs` cross-product. More
     * percolation-prone than the old behaviour and than the new one.
     *
     * MEASURED both ways, and the second measurement is why this is off. The cap
     * was truncating the decision: it bound on 12,266 of 12,366 groups, dropping
     * ~90% of the candidate set by `last_coverage` recency, which is not what the
     * decision reads — so production has judged a capped candidate set against
     * bars pinned by an uncapped replay, and narrowing is what makes the birth
     * path match those bars. But the cap was also doing the bounding K
     * (`STORYLINE_MERGE_BRIDGES`) was believed to be doing. Widen the qualifier
     * set and more pairs reach K, each merge unions two profiles, `mergeStorylines`
     * re-points the loser's bridges onto the winner rather than dropping them, and
     * a wider profile overlaps more on the next arrival. Modelled WITH that
     * re-pointing and the loser's drop, birth-only at the pinned bar leaves a
     * largest arc of 2,591 groups (9.96%); the harness that first justified
     * shipping this unconditionally modelled neither and reported 72.
     * docs/VERCEL-PHASE-0-FINDINGS.md 2.5-2.7 is the history, in the order it was
     * learned.
     *
     * **What turning it on costs.** If it percolates, the archive is not
     * recoverable in place: ADR-0011 refuses to build a split, so the only repair
     * is `backfill:storylines --restart`, which rewrites every storyline and
     * discards all label history — ~3,934 promoted storylines to relabel at the
     * free tier's 500/day, about eight days of quota, against an ADR-0015 that
     * calls the arcs and label history "the product". Nothing is on fire today —
     * the largest arc is 124 groups and exactly one exceeds 100 — but the
     * "no merge is pending" this used to say was wrong twice over: seven of the
     * 1,865 standing pairs are at or above K, and `runBridgeSweepChore` runs
     * UNFLAGGED every night and merges them (124 → 143, first order). Neither
     * `countBridges` nor `readBridgedPairs` reads membership, so a bridge written
     * by a group that is now a member of one side still counts
     * (VERCEL-PHASE-0-FINDINGS §2.7, "The live archive, re-read").
     *
     * And the birth path is now measured from production's own starting state:
     * a cap-built archive continued with the retrieval corrected, birth-only,
     * merges at 0.25 per arriving group against the flag-off control's 0.015 —
     * ~17x, flat over the whole corrected window rather than decaying as a
     * repaired backlog would — with 97% of those merges fusing two cap-shaped
     * arcs. That is §2.7 step 1, and it is why this stays off *by itself*.
     *
     * With `STORYLINE_MAX_BRIDGING_QUALIFIERS` at the top 2 the same run is 0.034
     * per arrival and its largest arc ends at 22, BELOW where leaving this off
     * leaves it — and the cap-built and from-scratch archives both land on 22,
     * so under the bound the hybrid's two starting states stop being
     * distinguishable at all. These two are therefore one decision, not two:
     * the combination the evidence refuses is this flag on with the
     * cross-product unbounded.
     *
     * **What would justify turning it on.** K re-measured against a harness that
     * models the merge — bridge re-pointing included — rather than one that skips
     * it; and then a fortnight of the nightly graph numbers
     * (`runStorylineGraphChore`: largest arc, arc count, arc-size distribution,
     * standing bridges) with it on, showing largest arc flat. Arc count falling
     * while largest arc climbs is the merge rate seen where it has a consequence,
     * and it is the signal to turn this back off. The recommended real fix is a
     * top-2-qualifiers bound on what may bridge, which is a different change with
     * its own evidence and is not this flag.
     *
     * `storyline-replay.ts` reads the same value, so the sweep that pins
     * thresholds models whichever mode is configured. Do not let those two
     * diverge: a replay narrowing while the service does not (or the reverse) is
     * precisely the bug 2.5 records, and it was invisible for months.
     */
    STORYLINE_NARROW_RETRIEVAL: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Run the nightly late-candidate sweep (`runLateCandidateChore`).
     *
     * **Off by default, and the default is the measurement.** The sweep re-offers
     * every group in the trailing window, and it used to do so against a
     * candidate set silently truncated to 200 rows — so how much its bridges
     * could merge was bounded by a bug rather than by a rule. With candidate
     * retrieval narrowed (`STORYLINE_NARROW_RETRIEVAL`, itself off by default
     * now), four passes over 2,000 groups on
     * a clone of the dev archive took the largest storyline from 124 groups to
     * 201 and built four arcs over 100 groups where there was one, and the
     * biggest of them chains Gaza, the Israel-Iran war and Russia-Ukraine
     * together. The replay that pinned these thresholds says the largest arc
     * should be 50 groups, and cannot see the difference because it models
     * birth-time offers only, never a re-offer.
     *
     * **That re-measurement has since been done, and it moved the blocker rather
     * than clearing it** (docs/STORYLINE-LINKING.md, "K, re-measured against a
     * replay that re-offers"). A replay that re-offers says the sweep takes the
     * largest arc to 4,540 groups — 17.46% of the window with the retrieval
     * narrowed, still climbing when the corpus runs out — so this stays off. But
     * the same instrument, once it models `mergeStorylines` re-pointing bridges,
     * says the BIRTH path alone reaches 2,591 at the pinned bar, i.e. 57% of that
     * final arc. K is not the binding constraint and this flag is not the fix;
     * bounding how many qualifiers one group may bridge is the lever that works,
     * and it applies to both paths.
     *
     * The flag rather than a deletion because the sweep is still the only thing
     * that covers the classes no storyline-change trigger can see — a withheld
     * formation leaves no state, and trailing-corpus drift moves a verdict with
     * no storyline in the causal chain at all.
     */
    STORYLINE_LATE_CANDIDATE_SWEEP: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Re-offer a group to the linker when an arriving article JOINS it
     * (`storyline-rejoin-trigger.ts`), on the ingest tail. Off is the pre-trigger
     * behaviour exactly: only seeded groups are linked, and an enlarged group
     * waits for the nightly late-candidate sweep.
     *
     * The mechanism is not in doubt — it is `linkGroup`, unchanged, one offer
     * per enlarged group, and the `ownGroups > 1` guard bounds it to ONE
     * retroactive arc per group whatever the offer rate. It closes a gap the
     * ingest path opens by design: an article joining a group widens the
     * MAJORITY profile the linker judged, and nothing was ever going to ask
     * again.
     *
     * It ships OFF anyway, and the reason has changed since it was written. The
     * original one was the candidate cap: an offer spent a group's ONE lifetime
     * retroactive slot against a set truncated to 200 rows, and that spend is
     * monotone — once `existing.length > 1` the group can never take another
     * arc — so firing at ingest frequency made an irreversible choice earlier
     * and against the worse candidate set. That cap lifts only when
     * `STORYLINE_NARROW_RETRIEVAL` is on — off, which is the default, it is still
     * there and this reason still stands. On the OLD retrieval this trigger
     * bought nothing measurable anyway: 42 retroactive arcs against a control
     * cohort's 29, about 1.5 sigma.
     *
     * Against the NARROWED retrieval it is worth 1.39x the arcs and 2.33x the
     * merges of that control — and the merges are the problem, because merges
     * are what percolate (see `STORYLINE_LATE_CANDIDATE_SWEEP`). It waited on the
     * same thing the sweep waited on: re-measuring K against a replay that
     * re-offers.
     *
     * **That is now measured, and it says stay off** — for a reason that is not
     * about this trigger. Re-offer bridges are what amplify the runaway (removing
     * them takes the sweep's largest arc from 4,540 to 2,176, below even the birth
     * path's own 2,591), and this trigger's whole effect is extra offers. It
     * cannot be safely switched on while an offer's bridge evidence is unbounded,
     * and once that is bounded it should be re-priced rather than assumed.
     * docs/STORYLINE-LINKING.md, "K, re-measured against a replay that
     * re-offers".
     */
    STORYLINE_REOFFER_JOINED_GROUPS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Narrow the nightly late-candidate sweep to the groups whose candidate set
     * could have changed since the last pass cleared its markers
     * (`storyline-changed-set.ts`, `storylines.link_dirty_at`). Off is the
     * unfiltered pass: every group in the trailing DF window, every night.
     *
     * This is where the order of magnitude is — MEASURED, ~12s a night against
     * ~275s — and it is the same decision at the same bar, because the filter is
     * a retrieval bound and `linkGroup` still makes every call.
     *
     * It ships off for two reasons, and the second is the real one.
     *
     * The marker column starts NULL on every existing row, so a filtered pass
     * finds nothing at all until a night of ordinary writes has marked
     * something. Turning this on in the same deploy as the migration would be a
     * silent no-op night that reports a clean tally, which is the exact failure
     * mode a changed-set filter has to be defended against. Deploy, let markers
     * accumulate, then flip.
     *
     * And it narrows a GUARANTEE. The unfiltered pass promises "every group in
     * the window, every night"; this promises "every group whose answer could
     * have moved, as far as a marker can tell". Trailing-corpus drift moves a
     * verdict with no storyline anywhere in the causal chain — last night's
     * retention prune shrinks the window under a group that has not changed —
     * and a group holding no storyline at all has no marker to carry it. Those
     * classes want an unfiltered pass on some cadence (`chores storylines
     * --full`), and the bounded, resumable version of that pass is not built
     * yet. docs/ARCHITECTURE.md §9.1 has the full list.
     */
    STORYLINE_LATE_CANDIDATE_CHANGED_ONLY: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Days without coverage after which a storyline leaves the normal candidate
     * set. UNMEASURED, and honestly so: the dev archive is 31 days, so 30, 90
     * and 365 replay identically — nothing in it is ever dormant. ADR-0011's
     * starting knob, kept, and the first thing S5's full-history backfill can
     * actually measure.
     */
    STORYLINE_DORMANCY_DAYS: z.coerce.number().int().min(1).default(90),
    /**
     * How much harder a dormant storyline is to join: anchor ceiling divided by
     * this, mass floor multiplied by it. One knob because the two must move
     * together. UNMEASURED for the same reason as the window above.
     */
    STORYLINE_DORMANT_STRICTNESS: z.coerce.number().min(1).default(1.5),

    /**
     * Applied when a search omits language. Omitting it upstream returns every
     * language mixed together, so "all" must be an explicit choice (§6.1).
     */
    DEFAULT_LANGUAGE: z.string().trim().min(2).max(8).default("en"),

    /**
     * How long a /v2/latest-news snapshot stays fresh (ARCHITECTURE 10.1).
     * The first visitor after it stales triggers the next one-call sample,
     * so a fully-visited day costs ceil(24h / this) calls per language.
     */
    SAMPLE_REFRESH_MINUTES: z.coerce.number().int().min(1).default(60),

    /**
     * Pages per /v2/latest-news sample, ~20 articles each. Daily worst case is
     * this x ceil(24h / SAMPLE_REFRESH_MINUTES) calls per language; the default
     * (2 x 24 = 48, ~5% of quota) thickens the early-day cloud without
     * re-buying what the next hour's snapshot returns anyway. Capped at 5:
     * /search stops at 100 retrievable results and latest-news paging beyond
     * that is unverified (PROBE-FINDINGS 6c).
     */
    SAMPLE_PAGES: z.coerce.number().int().min(1).max(5).default(2),

    /**
     * How far back the wordcloud looks (ARCHITECTURE 10.1). The window rolls
     * with the clock rather than resetting at midnight (ADR-0008), so this is
     * the only thing that decides what "now" covers. `BASELINE_WINDOW_DAYS`
     * (the trailing per-term mean) went with the terms it suppressed and did
     * not come back: a storyline needs no suppressor, because "is this word
     * perennial" is a question about words (ADR-0013).
     */
    TREND_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(48),

    /**
     * The half-life of the wordcloud's recency decay, in hours (§10.3). A
     * storyline's position is its window article count times
     * `0.5 ^ (age / this)`, so at the default a story that last moved 8 hours
     * ago needs twice the coverage of one moving now to rank level with it.
     *
     * Back from ADR-0008's `TERM_HALF_LIFE_HOURS`, which ADR-0013 deleted when
     * it made recency the cloud's whole ordering, and which ADR-0014 needed
     * again the moment volume rejoined that ordering. Same shape and same
     * default as before, and ADR-0008's argument for exponential over linear
     * carries unchanged: a linear ramp separates a 1-hour-old story from a
     * 5-hour-old one by 17% while treating the 20-to-24-hour tail as
     * significant.
     *
     * Wants tuning against real traffic, in the terms that ADR set out: much
     * shorter than `TREND_WINDOW_HOURS` and the older half of the window is
     * decorative, much longer and the decay does nothing.
     */
    TREND_HALF_LIFE_HOURS: z.coerce.number().min(0.5).max(168).default(8),

    /**
     * The calendar day ARTICLE GROUPING is bounded by (§7.4, ADR-0005) — a
     * group never spans two local days. The wordcloud no longer uses this:
     * it rolled its window instead (ADR-0008). IANA name, validated by Intl.
     */
    APP_TIMEZONE: z
      .string()
      .trim()
      .default("UTC")
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "must be an IANA timezone name Intl recognises (e.g. America/Vancouver)"),

    CORS_ORIGIN: NonEmpty.default("http://localhost:5173"),
    FIXTURES_DIR: z.string().trim().default("./fixtures"),
  })
  .superRefine((env, ctx) => {
    // verify-full with nothing to verify against would fall back to the system
    // trust store, which is not what the setting says and not what a managed
    // Postgres usually presents.
    if (env.DATABASE_SSL === "verify-full" && !env.DATABASE_CA_CERT) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_CA_CERT"],
        message:
          "DATABASE_CA_CERT is required when DATABASE_SSL=verify-full. " +
          "Use DATABASE_SSL=require to encrypt without verifying, or disable for " +
          "a server that offers no TLS (the Compose Postgres).",
      });
    }

    // The reverse is the more dangerous half: a CA sitting in the environment
    // reads as "we verify TLS" to everyone who greps for it, while the
    // connection is in fact plaintext.
    if (env.DATABASE_SSL === "disable" && env.DATABASE_CA_CERT) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_SSL"],
        message:
          "DATABASE_CA_CERT is set but DATABASE_SSL=disable, so the certificate " +
          "verifies nothing. Set DATABASE_SSL=verify-full, or clear the certificate.",
      });
    }

    // Live mode without a key is the single most likely misconfiguration, and it
    // would otherwise surface as a runtime 401 on the first user search.
    if (env.CURRENTS_MODE === "live" && !env.CURRENTS_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["CURRENTS_API_KEY"],
        message:
          "CURRENTS_API_KEY is required when CURRENTS_MODE=live. " +
          "Use CURRENTS_MODE=fixture to develop offline against ./fixtures.",
      });
    }

    // The interactive reserve exists so background backfill can never starve a
    // live search (ARCHITECTURE 5.4). A reserve >= the daily limit inverts that:
    // the worker would never run at all.
    if (env.INTERACTIVE_RESERVE >= env.CURRENTS_DAILY_CALL_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["INTERACTIVE_RESERVE"],
        message:
          `INTERACTIVE_RESERVE (${env.INTERACTIVE_RESERVE}) must be below ` +
          `CURRENTS_DAILY_CALL_LIMIT (${env.CURRENTS_DAILY_CALL_LIMIT}), ` +
          "or background ingestion can never run.",
      });
    }

    // A page cannot exceed the tier's page size, and the retrievable cap must be
    // a whole number of pages or the last page is unreachable.
    if (env.CURRENTS_MAX_RETRIEVABLE_RESULTS % env.CURRENTS_MAX_PAGE_SIZE !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["CURRENTS_MAX_RETRIEVABLE_RESULTS"],
        message:
          `CURRENTS_MAX_RETRIEVABLE_RESULTS (${env.CURRENTS_MAX_RETRIEVABLE_RESULTS}) ` +
          `must be a multiple of CURRENTS_MAX_PAGE_SIZE (${env.CURRENTS_MAX_PAGE_SIZE}).`,
      });
    }

    // The same three checks again for the second provider, and only when it is
    // switched on — an unset GNEWS_API_KEY is the normal state, not a mistake,
    // right up until someone sets GNEWS_ENABLED=true.
    if (env.GNEWS_ENABLED && env.GNEWS_MODE === "live" && !env.GNEWS_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["GNEWS_API_KEY"],
        message:
          "GNEWS_API_KEY is required when GNEWS_ENABLED=true and GNEWS_MODE=live. " +
          "Use GNEWS_MODE=fixture to develop offline against ./fixtures, or " +
          "GNEWS_ENABLED=false to run on Currents alone.",
      });
    }

    if (env.GNEWS_ENABLED && env.GNEWS_INTERACTIVE_RESERVE >= env.GNEWS_DAILY_CALL_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["GNEWS_INTERACTIVE_RESERVE"],
        message:
          `GNEWS_INTERACTIVE_RESERVE (${env.GNEWS_INTERACTIVE_RESERVE}) must be below ` +
          `GNEWS_DAILY_CALL_LIMIT (${env.GNEWS_DAILY_CALL_LIMIT}), ` +
          "or background ingestion can never draw on this provider.",
      });
    }

    // Google News has no page-size or retrievable-results knob to cross-check —
    // both are fixed at the endpoint's 100-item wall in the adapter, because
    // neither is a tier anyone could buy up. The reserve check still applies.
    if (
      env.GOOGLE_NEWS_ENABLED &&
      env.GOOGLE_NEWS_INTERACTIVE_RESERVE >= env.GOOGLE_NEWS_DAILY_CALL_LIMIT
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_NEWS_INTERACTIVE_RESERVE"],
        message:
          `GOOGLE_NEWS_INTERACTIVE_RESERVE (${env.GOOGLE_NEWS_INTERACTIVE_RESERVE}) must be ` +
          `below GOOGLE_NEWS_DAILY_CALL_LIMIT (${env.GOOGLE_NEWS_DAILY_CALL_LIMIT}), ` +
          "or background ingestion can never draw on this provider.",
      });
    }

    // Refused rather than left inert: a fallback switched on with nothing to
    // fall back to would read as working in every log line that names the flag,
    // and quietly fall back to nothing.
    if (env.SEARCH_FALLBACK_ENABLED && !env.GOOGLE_NEWS_ENABLED) {
      ctx.addIssue({
        code: "custom",
        path: ["SEARCH_FALLBACK_ENABLED"],
        message:
          "SEARCH_FALLBACK_ENABLED needs GOOGLE_NEWS_ENABLED=true: the provider a " +
          "refused search falls back to is Google News.",
      });
    }

    if (env.GNEWS_MAX_RETRIEVABLE_RESULTS % env.GNEWS_MAX_PAGE_SIZE !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["GNEWS_MAX_RETRIEVABLE_RESULTS"],
        message:
          `GNEWS_MAX_RETRIEVABLE_RESULTS (${env.GNEWS_MAX_RETRIEVABLE_RESULTS}) ` +
          `must be a multiple of GNEWS_MAX_PAGE_SIZE (${env.GNEWS_MAX_PAGE_SIZE}).`,
      });
    }

    // Retention shorter than the upstream lookback means we would delete articles
    // we could still re-fetch — harmless. Retention LONGER is the valuable case,
    // because beyond the lookback our store is the only copy (ARCHITECTURE 7.5).
    if (env.RETENTION_DAYS < env.CURRENTS_MAX_LOOKBACK_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["RETENTION_DAYS"],
        message:
          `RETENTION_DAYS (${env.RETENTION_DAYS}) is below ` +
          `CURRENTS_MAX_LOOKBACK_DAYS (${env.CURRENTS_MAX_LOOKBACK_DAYS}), ` +
          "which discards history the upstream can no longer supply.",
      });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

/**
 * Parse and validate configuration. Throws ConfigError listing every problem at
 * once rather than failing on the first, so a misconfigured deploy is one fix
 * rather than a guessing game.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

/**
 * Config with every API key removed, safe for logs and error reports.
 * A key must never appear in output (ARCHITECTURE 5.5) — and a second provider
 * means a second key, so this list grows with the providers.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const {
    CURRENTS_API_KEY,
    GNEWS_API_KEY,
    GEMINI_API_KEY,
    SUMMARY_API_KEY,
    CRON_SECRET,
    DATABASE_URL,
    DATABASE_SESSION_URL,
    DATABASE_CA_CERT,
    REDIS_URL,
    ...rest
  } = config;
  return {
    ...rest,
    CURRENTS_API_KEY: CURRENTS_API_KEY ? "[redacted]" : null,
    GNEWS_API_KEY: GNEWS_API_KEY ? "[redacted]" : null,
    GEMINI_API_KEY: GEMINI_API_KEY ? "[redacted]" : null,
    // Usually unset — the summariser falls back to GEMINI_API_KEY — but when it
    // is set it is a second credential and redacts like the first.
    SUMMARY_API_KEY: SUMMARY_API_KEY ? "[redacted]" : null,
    // A bearer token is a password: it authenticates the one route that can
    // spend quota unprompted.
    CRON_SECRET: CRON_SECRET ? "[redacted]" : null,
    DATABASE_URL: redactUrlCredentials(DATABASE_URL),
    // A second URL is a second password (§4.1's session-mode connection).
    DATABASE_SESSION_URL: DATABASE_SESSION_URL
      ? redactUrlCredentials(DATABASE_SESSION_URL)
      : null,
    // Not a secret — a CA certificate is public by construction — but a kilobyte
    // of PEM in the boot line is noise, and noise is what stops the boot line
    // being read.
    DATABASE_CA_CERT: DATABASE_CA_CERT ? "[present]" : null,
    REDIS_URL: redactUrlCredentials(REDIS_URL),
  };
}

function redactUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "[redacted]";
    if (url.username) url.username = "[redacted]";
    return url.toString();
  } catch {
    return "[unparseable]";
  }
}
