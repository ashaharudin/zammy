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

    // --- storylines (ARCHITECTURE 14.3 amendment, ADR-0009) ---
    /**
     * Whether a day's groups cluster into storyline slots. Off restores one
     * slot per group; storylines already recorded page as their groups again
     * only after a regroup — flipping this off changes ATTACHMENT, not stored
     * state, so flip it back on and nothing was lost.
     */
    STORYLINE_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * A shared token anchors a storyline link only below this share of the
     * day's corpus. MEASURED (ADR-0009): 0.05 admits a story's own name on
     * the day it dominates coverage (df 64 of 1,453 = 4.4%) and refuses
     * beat vocabulary ("trump" ≈ 20% of any day).
     */
    STORYLINE_ANCHOR_SHARE: z.coerce.number().min(0).max(1).default(0.05),
    /**
     * Floor on the summed rarity (ln(dayN/df)) of everything a pair shares.
     * MEASURED (ADR-0009): at 8, the Leavitt day clusters 31 groups of
     * genuine departure coverage with strays in the low single digits; 6
     * over-attaches, 10 starts shedding real angles. A wrong attach is a
     * stray link under a headline — cheap by design — so err low here, the
     * OPPOSITE direction from GROUPING_SIMILARITY_THRESHOLD, where a wrong
     * merge corrupts the slot itself.
     */
    STORYLINE_MASS_THRESHOLD: z.coerce.number().min(0).default(8),

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
 * Config with the API key removed, safe for logs and error reports.
 * The key must never appear in output (ARCHITECTURE 5.5).
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const { CURRENTS_API_KEY, DATABASE_URL, REDIS_URL, ...rest } = config;
  return {
    ...rest,
    CURRENTS_API_KEY: CURRENTS_API_KEY ? "[redacted]" : null,
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
