import { z } from "zod";

/**
 * @zammy/config — server-only configuration, validated at boot.
 *
 * The process refuses to start on bad config rather than failing mysteriously
 * later (ARCHITECTURE 12). This package holds the Currents API key and must
 * NEVER be imported by @zammy/web — the browser only ever talks to our API.
 */

const NonEmpty = z.string().trim().min(1);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    DATABASE_URL: NonEmpty,
    REDIS_URL: NonEmpty,

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
     * Also what the nightly prune keeps, plus a day of slack, exactly as
     * BASELINE_WINDOW_DAYS is for `term_snapshots`.
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
     */
    STORYLINE_LABEL_SAMPLE: z.coerce.number().int().min(2).max(40).default(10),
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
     * MEASURED: K=1 quadruples merges (826 → 3,416) for no gain in the alarm,
     * which is single-bridge percolation exactly as ADR-0011 predicted; K=2 is
     * where it settles.
     */
    STORYLINE_MERGE_BRIDGES: z.coerce.number().int().min(1).default(2),
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
     * the only thing that decides what "now" covers.
     */
    TREND_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    /**
     * Recency half-life inside that window (§10.3). An article contributes
     * `0.5 ^ (age / this)`: ~0.125 at the 24-hour edge by default. Much
     * shorter than TREND_WINDOW_HOURS makes the window's older half
     * decorative; much longer and the weighting stops doing anything.
     */
    TERM_HALF_LIFE_HOURS: z.coerce.number().min(0.5).max(168).default(8),

    /**
     * How many days of hourly snapshots the baseline means over (§10.3).
     * Also what the nightly prune keeps, plus a day of slack (§7.5).
     */
    BASELINE_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(7),

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
    REDIS_URL,
    ...rest
  } = config;
  return {
    ...rest,
    CURRENTS_API_KEY: CURRENTS_API_KEY ? "[redacted]" : null,
    GNEWS_API_KEY: GNEWS_API_KEY ? "[redacted]" : null,
    GEMINI_API_KEY: GEMINI_API_KEY ? "[redacted]" : null,
    DATABASE_URL: redactUrlCredentials(DATABASE_URL),
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
