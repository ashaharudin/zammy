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
 * the app deliberately swallows (server.ts), and a load balancer watching
 * `/readyz` sees HTTP 200 and routes traffic to an instance whose ingest queue
 * silently does nothing (DEPLOYMENT-OCI §2.4, archival — the failure mode is the
 * load balancer's, not that target's).
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
    INGEST_POLL_MAX: z.coerce.number().int().min(1).max(60).default(8),
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
     * so the default is 0. (Worked through for the OCI load balancer in
     * DEPLOYMENT-OCI §4 and §9.2, archival; the arithmetic is the same for any.)
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
     * LITE, and measured: naming a storyline is not a reasoning task. Asked to
     * name the Fort Hood crash, `gemini-3.1-flash-lite` returns the same label
     * as `gemini-3.7-flash` while spending ZERO thinking tokens, where 3.7
     * spends ~300 — and thinking tokens bill as output. See
     * docs/STORYLINE-LABELS.md for the comparison over the dev archive.
     */
    GEMINI_MODEL: NonEmpty.default("gemini-3.1-flash-lite"),
    /**
     * How much the model may think before answering, for the families that
     * reason by default. EMPTY — omit the field — is the default because the
     * measured answer is that thinking buys nothing here and costs everything:
     * see `gemini.ts`. Set it (`low` is the floor 3.x flash accepts) only if a
     * chosen model needs it.
     */
    GEMINI_THINKING_LEVEL: z.string().trim().default(""),
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
     * The tier's published request ceiling, per minute. THE KNOB: 15 is the
     * free tier's figure; a paid tier raises it and this is the one number to
     * change.
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
    GEMINI_MAX_RPM: z.coerce.number().int().min(1).max(10_000).default(15),
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
     * calls the arcs and label history "the product". Nothing is on fire today:
     * all 1,913 standing bridge pairs hold exactly one independent bridge and
     * none is at K=2, so no merge is pending.
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
    TREND_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),

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
