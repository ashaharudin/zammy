import type { Config } from "@zammy/config";
import type { StorylinePassDeps } from "./chores.js";
import { createDb, databaseSsl, type Database } from "@zammy/storage";
import type { Kysely } from "kysely";
import { createGeminiClient } from "./gemini.js";
import { BullMqIngestQueue } from "./ingest-queue-bullmq.js";
import { VercelIngestQueue, type QueueLogger } from "./ingest-queue-vercel.js";
import type { IngestQueue } from "./ingest-queue.js";
import type { LabelerDeps } from "./storyline-label-service.js";
import type { LabelMergeRules } from "./storyline-label-merge.js";
import type { LinkerConfig } from "./storyline-linker.js";

/**
 * The runtime objects built from `Config` by more than one entrypoint.
 *
 * Two processes now make storyline decisions: the server's live ingest tail, and
 * the nightly chore runner (`chores-cli.ts`). They must build these two objects
 * identically — not approximately — because both of them ARE decisions:
 *
 *   - `createLinkerConfig` fixes the bar a group is judged at. A sweep that
 *     builds its own copy with one field different judges Monday's group by
 *     rules the live path never used, and nothing in the rows records which
 *     bar was applied.
 *   - `createLabeler` fixes the model, the sample, the drift factor and the
 *     pacing. The pacing matters most: the ceiling being paced is on the KEY
 *     both processes share (STORYLINE-LABELS, "The rate limit").
 *
 * Neither is exported for the operator CLIs to use. `regroup` disables the
 * linker outright and `backfill:storylines` deliberately differs (no coherence
 * gate, its own `--label-rate`), so their divergence is a decision each one
 * documents — not the accidental kind this module exists to prevent.
 */

/** Everything a labelling call needs except the database handle. */
export type Labeler = Omit<LabelerDeps, "db">;

/**
 * The database handle for every entrypoint that builds one from `Config` — the
 * chore runner and the nine operator CLIs. It belongs here for the same reason
 * the two above do: the connection is a decision, and there are now two of them
 * to get wrong.
 *
 *   - TLS is set here, never in the URL. node-postgres silently ignores the
 *     `ssl` object when the connection string carries `sslmode`, so a CLI that
 *     built its own handle would be encrypted-or-not according to whichever the
 *     driver read last (@zammy/storage's `databaseSsl`).
 *   - `session: true` asks for `DATABASE_SESSION_URL`, and only the two callers
 *     holding a SESSION-scoped advisory lock may: the migrator and the chore
 *     runner. Everything else is transaction-scoped or lockless and should go
 *     through the request-path URL.
 *
 * `server.ts` is the exception and stays one: it builds its own `pg.Pool`
 * because `/readyz` probes the same pool the queries use, and a handle built
 * here would give it a second one.
 */
export function createConfiguredDb(
  config: Config,
  options: { max?: number; session?: boolean } = {},
): Kysely<Database> {
  const url = options.session
    ? (config.DATABASE_SESSION_URL ?? config.DATABASE_URL)
    : config.DATABASE_URL;
  return createDb(url, {
    ...(options.max !== undefined ? { max: options.max } : {}),
    ssl: databaseSsl({ mode: config.DATABASE_SSL, caCert: config.DATABASE_CA_CERT }),
  });
}

/**
 * The ingest queue `INGEST_QUEUE_DRIVER` asks for.
 *
 * It belongs here for the reason everything else does: two entrypoints build
 * one now — the request path, which only publishes, and the push-mode consumer,
 * which drains and republishes the halves of a truncated segment. They must
 * agree on the transport AND on the queue's `name`, because that name scopes
 * both the pending registry `meta.ingest` reads and the trending sample lock. A
 * consumer that built a differently-named queue would settle jobs into a
 * registry nobody polls.
 */
export function createIngestQueue(
  config: Config,
  options: { queueName?: string; log?: QueueLogger } = {},
): IngestQueue {
  if (config.INGEST_QUEUE_DRIVER === "vercel") {
    return new VercelIngestQueue(config.REDIS_URL, options);
  }
  return new BullMqIngestQueue(config.REDIS_URL, {
    ...(options.queueName ? { queueName: options.queueName } : {}),
  });
}

/**
 * `STORYLINE_MAX_BRIDGING_QUALIFIERS` as `bridgePairs` wants it: 0 is unbounded,
 * expressed as `undefined`.
 *
 * A function, and exported, because the sweep CLI needs the same translation and
 * "0 means unbounded" written twice is one place for the two to disagree. 0
 * rather than an absent variable so the knob has a value in `.env` either way —
 * a bound of 1 is a legitimate setting (one qualifier is no pair, so it turns
 * bridging off entirely) and must not collide with "not set".
 */
export function maxBridgingQualifiers(config: Config): number | undefined {
  return config.STORYLINE_MAX_BRIDGING_QUALIFIERS === 0
    ? undefined
    : config.STORYLINE_MAX_BRIDGING_QUALIFIERS;
}

/**
 * The linker config the LIVE write path uses, and therefore the one the nightly
 * sweeps must use: they exist to offer the linker what it already declined or
 * never saw, at the bar it would have applied.
 */
export function createLinkerConfig(config: Config): LinkerConfig {
  return {
    // Structural, not optional: no storylines means no timeline rows.
    enabled: true,
    rules: {
      anchorMaxShare: config.STORYLINE_ANCHOR_MAX_SHARE,
      anchorDfFloor: config.STORYLINE_ANCHOR_DF_FLOOR,
      massThreshold: config.STORYLINE_MASS_THRESHOLD_V2,
      dormancyDays: config.STORYLINE_DORMANCY_DAYS,
      dormantStrictness: config.STORYLINE_DORMANT_STRICTNESS,
    },
    mergeBridges: config.STORYLINE_MERGE_BRIDGES,
    // No model, no verdict to wait for — deferring would only lose formations
    // to a tail that can never resolve them.
    coherenceGate: config.STORYLINE_COHERENCE_GATE && Boolean(config.GEMINI_API_KEY),
    // Both halves of the retrieval, from one flag (`candidateRetrieval`).
    narrowRetrieval: config.STORYLINE_NARROW_RETRIEVAL,
    // 0 is unbounded, which is the default and today's behaviour. A separate
    // knob from the retrieval above on purpose — see the flag's own note; the
    // short version is that no combination of the two is worse than both, so
    // nothing here has to be made unreachable.
    maxBridgingQualifiers: maxBridgingQualifiers(config),
    storyDf: {
      windowDays: config.STORYLINE_DF_WINDOW_DAYS,
      timeZone: config.APP_TIMEZONE,
    },
    timeZone: config.APP_TIMEZONE,
  };
}

/**
 * The bar the label-agreement merge judges at, for the two processes that repair
 * on the SAME evidence: the nightly chore, and the ingest tail's collision
 * trigger. Same reason as `createLinkerConfig` — the trigger exists to run the
 * nightly decision earlier, so a grace window or component valve that differed
 * between them would make "earlier" mean "different", and the row would not
 * record which bar was applied.
 *
 * `storyline-label-merge-cli.ts` deliberately does NOT use this: its whole
 * purpose is letting an operator try another bar with `--grace` and
 * `--max-component`, which is the documented kind of divergence above.
 */
export function createLabelMergeRules(config: Config): LabelMergeRules {
  return {
    graceDays: config.STORYLINE_LABEL_MERGE_GRACE_DAYS,
    maxComponent: config.STORYLINE_LABEL_MERGE_MAX_COMPONENT,
  };
}

/**
 * The labeler (ADR-0011's Labels). No key is a supported configuration and not a
 * degraded one: the generator is null, the bigram extractor becomes the only
 * path, and it renders.
 *
 * One client per process is one pacer per process, and that is the most the
 * pacer can promise — it is a window inside a client, so it cannot see the
 * server's calls from the chore runner's process or the reverse. Two pacers each
 * admitting `GEMINI_MAX_RPM` is up to 2x the ceiling on the shared key, caught
 * by the 429 cooldown rather than by the window (STORYLINE-LABELS, "The pacer's
 * scope"). The chore runner's lever for staying under it is `--label-rate`.
 */
export function createLabeler(config: Config, logger?: Labeler["logger"]): Labeler {
  return {
    generator: config.GEMINI_API_KEY
      ? createGeminiClient({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
          baseUrl: config.GEMINI_BASE_URL,
          thinkingLevel: config.GEMINI_THINKING_LEVEL,
          timeoutMs: config.GEMINI_TIMEOUT_MS,
          maxRequestsPerMinute: config.GEMINI_MAX_RPM,
          maxRateWaitMs: config.GEMINI_MAX_RATE_WAIT_MS,
        })
      : null,
    sampleSize: config.STORYLINE_LABEL_SAMPLE,
    driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
    logger,
  };
}

/**
 * The configured night: everything a chore pass needs, from `Config` alone.
 *
 * It belongs here for the reason the three constructions below it do — **two
 * entrypoints build one**. `chores-cli.ts` runs the passes under Compose and
 * from a laptop; `chore-route.ts` runs them on the deployment. A route that
 * built its own linker bar or its own labeler pacing would judge Monday's group
 * by rules the live path never used, with nothing in the rows recording which
 * bar was applied — which is the accident this module exists to prevent, stated
 * at the top of it.
 *
 * The per-run knobs (`--max-labels`, `--changed-only`, `--late-candidates`, and
 * their query-parameter twins) are deliberately NOT here. They are overrides an
 * operator applies to this, one run at a time; folding them in would make the
 * configured night and a one-off run indistinguishable.
 */
export function choreDepsFromConfig(
  config: Config,
  log: StorylinePassDeps["log"],
): StorylinePassDeps {
  return {
    // `session: true` and `max: 4`: the pass lock is session-scoped, so it must
    // not go through a transaction-mode pooler (`chore-runner.ts` has why), and
    // one connection is pinned holding it while the passes borrow the rest. What
    // it must not be is 1, which would deadlock against the pinned connection.
    db: createConfiguredDb(config, { max: 4, session: true }),
    config: {
      retentionDays: config.RETENTION_DAYS,
      storyDfWindowDays: config.STORYLINE_DF_WINDOW_DAYS,
      storylineDormancyDays: config.STORYLINE_DORMANCY_DAYS,
      timeZone: config.APP_TIMEZONE,
    },
    now: () => new Date(),
    log,
    linker: createLinkerConfig(config),
    labeler: createLabeler(config, log),
    rules: createLabelMergeRules(config),
    // Defaults to the configured ceiling, so the pass paces itself rather than
    // piling into the client's pacer and waiting there.
    labelRatePerMinute: config.GEMINI_MAX_RPM,
    // The deployment parameter, not the pass's code default of 500: at
    // `GEMINI_MAX_RPM=15` a label is >=4 s of pacing, so 75 labels IS the whole
    // 300 s function ceiling (VERCEL-ALL-IN-SCOPE §3.3).
    maxLabels: config.CHORE_MAX_LABELS,
    // The bound that matches what the PLATFORM enforces. `maxLabels` above is a
    // count, and a count only bounds the clock if a label costs what the count
    // was sized against — see `CHORE_LABEL_BUDGET_MS`.
    labelBudgetMs: config.CHORE_LABEL_BUDGET_MS,
    lateCandidateSweep: config.STORYLINE_LATE_CANDIDATE_SWEEP,
    lateCandidatesChangedOnly: config.STORYLINE_LATE_CANDIDATE_CHANGED_ONLY,
  };
}
