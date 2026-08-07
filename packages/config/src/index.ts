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
    CURRENTS_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(1000),
    CURRENTS_BURST_CALL_LIMIT: z.coerce.number().int().min(1).default(60),

    // --- ingestion budget (ARCHITECTURE 6.3, 9.4) ---
    SYNC_FILL_DEADLINE_MS: z.coerce.number().int().min(100).max(10_000).default(1200),
    MAX_SYNC_UPSTREAM_CALLS: z.coerce.number().int().min(1).max(5).default(5),
    INTERACTIVE_RESERVE: z.coerce.number().int().min(0).default(250),
    PER_TOPIC_DAILY_CALL_CAP: z.coerce.number().int().min(1).default(20),
    INGEST_POLL_MAX: z.coerce.number().int().min(1).max(60).default(8),

    RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

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
