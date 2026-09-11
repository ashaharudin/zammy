import type { Config } from "@zammy/config";
import type { StorylinePassDeps } from "./chores.js";
import { createDb, databaseSsl, type Database } from "@zammy/storage";
import type { Kysely } from "kysely";
import { createGeminiClient, createPacer, type ModelPacer } from "./gemini.js";
import { BullMqIngestQueue } from "./ingest-queue-bullmq.js";
import { VercelIngestQueue, type QueueLogger } from "./ingest-queue-vercel.js";
import type { IngestQueue } from "./ingest-queue.js";
import type { LabelerDeps } from "./storyline-naming.js";
import type { LabelMergeRules } from "./storyline-label-merge.js";
import { storylineBar, type StorylineBarOverrides } from "./storyline-bar.js";
import type { LinkerConfig } from "./storyline-linker.js";
import type { SummarizerDeps } from "./storyline-summary-service.js";

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
 * The bar is now a VALUE and this is only the adapter that reads it from the
 * environment: `STORYLINE_BAR` in `storyline-bar.ts` holds the measured
 * defaults, `storylineBar(overrides)` applies a named divergence to them, and
 * `createLinkerConfig` is `storylineBar(linkerBarFromEnv(config))`. That is
 * what makes the rule above enforceable rather than merely stated — the leverage
 * of this module was two callers, while the same fifteen fields were written
 * out at nineteen sites, `test-support.ts` among them as a whole second default.
 *
 * Both operator CLIs go through it too, and that is the same argument rather
 * than an exception to it: `regroup` disables the linker outright and
 * `backfill:storylines` deliberately differs (no coherence gate, its own
 * `--label-rate`), which is a divergence of TWO fields — and each of them
 * spelled it as a fifteen-field copy, the drift this header predicts. What
 * they legitimately differ on now sits beside the reason it differs, and the
 * rest follow the live path. (`backfill:storylines` also NAMES `honourRefusals`
 * without differing on it by default, because the two were one field until
 * 2026-09-11 and stating both is how they stay apart — `backfillBar`.)
 *
 * `createLabeler` **is** what the CLIs use, as of the operator-command
 * refactor, and that is the same argument rather than an exception to it. Five
 * of them hand-rolled a Gemini client and the pacing drifted exactly as this
 * header predicts it would: `merge:storyline-labels` omitted
 * `maxRequestsPerMinute` altogether and took `gemini.ts`'s literal 30 rpm
 * against a deployment configured for 15 — 2x the ceiling on the shared key,
 * from a line that looked complete. What those five legitimately differ on is
 * one or two fields with a reason attached, so they pass `LabelerOverrides`
 * and the reason stays beside the field. See `operator-command.ts`.
 */

/** Everything a labelling call needs except the database handle. */
export type Labeler = Omit<LabelerDeps, "db">;

/** The same, for the historical preserve (ADR-0023). */
export type Summarizer = Omit<SummarizerDeps, "db">;

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
 * `STORYLINE_BAR`'s every env-derived field, as a divergence from it.
 *
 * Exported because the two operator CLIs whose divergence this module's header
 * sanctions still need the CONFIGURED bar to diverge from — `regroup` disables
 * the linker and `backfill:storylines` drops the coherence gate, and neither is
 * a licence to also re-declare the twelve fields it does not differ on. That
 * re-declaration is what both of them used to be.
 *
 * Every field of the bar appears here except two, and both exceptions are
 * deliberate: `enabled` is structural (`STORYLINE_BAR`) rather than configured,
 * and `honourRefusals` is evidence rather than policy — replaying a verdict a
 * person has already read is not a thing a deployment tunes, and the one caller
 * that may decline says so on the command line. `wiring.test.ts` asserts both.
 */
export function linkerBarFromEnv(config: Config): StorylineBarOverrides {
  return {
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
 * The linker config the LIVE write path uses, and therefore the one the nightly
 * sweeps must use: they exist to offer the linker what it already declined or
 * never saw, at the bar it would have applied.
 *
 * The shipped bar with the environment applied to it, and nothing else — so an
 * unset variable is the measured default by construction rather than by a
 * literal here agreeing with one in `storyline-bar.ts`.
 */
export function createLinkerConfig(config: Config): LinkerConfig {
  return storylineBar(linkerBarFromEnv(config));
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
 * The two or three client fields ONE operator command legitimately sets
 * differently, each with its reason written beside it at the call site.
 *
 * Deliberately narrow. Everything absent from this type — the key, the base
 * URL, the thinking level, the timeout, the sample size, the drift factor — is
 * not a per-command decision, and the whole point of routing the CLIs through
 * `createLabeler` is that they cannot quietly make it one.
 */
export interface LabelerOverrides {
  /**
   * A sibling model, for the measurement CLI that continues on another model's
   * quota once one is spent. It also becomes `modelId`, because what
   * `label_source` must record is the model that was actually called.
   */
  model?: string;
  /** A rate below the configured ceiling. Above it buys nothing: see below. */
  maxRequestsPerMinute?: number;
  /** How long a call will sit in the pacer's queue before giving up. */
  maxRateWaitMs?: number;
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
 *
 * **`modelId` is set here**, and it is the field this function used to leave
 * out. `storyline-naming.ts` falls back to the literal string `"model"`
 * without it, so the server path, the chore path and `pnpm label:storylines`
 * all stamped `label_source = 'model'` while `backfill:storylines --relabel`
 * computed its "already current" target as the real model id — and re-spent
 * model quota on every row that was already current. The two now cannot
 * disagree: `modelLabelSource` in `storyline-label.ts` is the one place the
 * value is decided, and this is the one place the id comes from.
 */
export function createLabeler(
  config: Config,
  logger?: Labeler["logger"],
  /**
   * A pacer to share with the summariser. Absent, the client builds its own,
   * which is correct for every caller that has only one model on the key.
   */
  pacer?: ModelPacer,
  /** One command's documented divergence — see `LabelerOverrides`. */
  overrides: LabelerOverrides = {},
): Labeler {
  const model = overrides.model ?? config.GEMINI_MODEL;
  return {
    generator: config.GEMINI_API_KEY
      ? createGeminiClient({
          apiKey: config.GEMINI_API_KEY,
          model,
          baseUrl: config.GEMINI_BASE_URL,
          thinkingLevel: config.GEMINI_THINKING_LEVEL,
          timeoutMs: config.GEMINI_TIMEOUT_MS,
          maxRequestsPerMinute: overrides.maxRequestsPerMinute ?? config.GEMINI_MAX_RPM,
          maxRateWaitMs: overrides.maxRateWaitMs ?? config.GEMINI_MAX_RATE_WAIT_MS,
          ...(pacer ? { pacer } : {}),
        })
      : null,
    // No key, no call, no model id: a row must not claim provenance from a
    // model that was never asked. `setStorylineLabel` records `bigram` or null
    // on that path, which is the truth.
    ...(config.GEMINI_API_KEY ? { modelId: model } : {}),
    sampleSize: config.STORYLINE_LABEL_SAMPLE,
    driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
    logger,
  };
}

/**
 * One pacer for one KEY, to be shared by every client pointed at it.
 *
 * This exists because `SUMMARY_MODEL` made "one process, one model" false. The
 * per-minute ceiling belongs to the key and not to the model id, so two clients
 * each counting their own window admit up to 2x it — the same overshoot two
 * PROCESSES on one key produce, except this one would be inside a single
 * process and therefore entirely preventable. `createGeminiClient` still builds
 * its own when nobody hands it one, which is what every single-model caller
 * (the server, the operator CLIs) wants.
 */
/**
 * Does the summariser count against the labeler's window?
 *
 * Yes while they are on one key, which is the default and the case the shared
 * pacer exists for. **No the moment `SUMMARY_API_KEY` is set** — that knob's
 * whole purpose is that the two lanes stop competing, so handing the second key
 * the first key's window would be the opposite of what was asked for, and would
 * halve a rate limit somebody paid for.
 *
 * A predicate rather than an inline `?:` because it is the one branch here with
 * a wrong answer that is invisible at runtime: both spellings produce a working
 * client, and the difference only shows up as a rate nobody is watching.
 */
export function summarySharesLabelerPacer(config: Config): boolean {
  // Unset, empty — or set to the SAME credential, which is the natural
  // "be explicit" move and the obvious thing to do when uncommenting the line
  // in `.env.example`. What decides this is which KEY is being spent, not which
  // variable it was read from; two pacers on one key is the 2x overshoot the
  // shared pacer exists to prevent.
  return !config.SUMMARY_API_KEY || config.SUMMARY_API_KEY === config.GEMINI_API_KEY;
}

export function createModelPacer(config: Config): ModelPacer {
  return createPacer({
    maxRequestsPerMinute: config.GEMINI_MAX_RPM,
    maxRateWaitMs: config.GEMINI_MAX_RATE_WAIT_MS,
  });
}

/**
 * The summariser (ADR-0023). No key is a supported configuration, exactly as it
 * is for the labeler — but the consequence differs and is worth stating: the
 * labeler degrades to the bigram extractor, and this one simply writes nothing.
 * Prose has no deterministic fallback.
 *
 * **`pacer` is honoured only while the summariser is on the labeler's key.**
 * Set `SUMMARY_API_KEY` and the whole point is that the two lanes stop
 * competing, so sharing the labeler's window would be the opposite of what was
 * asked for — a second key gets its own pacer.
 */
export function createSummarizer(
  config: Config,
  logger?: Summarizer["logger"],
  pacer?: ModelPacer,
): Summarizer {
  // `||`, so an empty string falls through to the labeler's key the way an
  // absent variable does — config already normalizes it, and this is the line
  // that would be wrong if that ever regressed.
  const apiKey = config.SUMMARY_API_KEY || config.GEMINI_API_KEY;
  const shared = summarySharesLabelerPacer(config) ? pacer : undefined;
  return {
    generator: apiKey
      ? createGeminiClient({
          apiKey,
          model: config.SUMMARY_MODEL,
          baseUrl: config.GEMINI_BASE_URL,
          thinkingLevel: config.SUMMARY_THINKING_LEVEL,
          timeoutMs: config.GEMINI_TIMEOUT_MS,
          // The ceiling and the queue cap belong to whichever pacer ends up
          // governing this client, so they are passed ONLY when it builds its
          // own — a shared pacer already has its own copy of both, and passing
          // them alongside one would read as if they still applied.
          ...(shared
            ? { pacer: shared }
            : {
                maxRequestsPerMinute: config.GEMINI_MAX_RPM,
                maxRateWaitMs: config.GEMINI_MAX_RATE_WAIT_MS,
              }),
        })
      : null,
    modelId: apiKey ? config.SUMMARY_MODEL : null,
    sampleSize: config.SUMMARY_SEGMENT_SAMPLE,
    maxAttempts: config.SUMMARY_MAX_ATTEMPTS,
    settlingDays: config.SUMMARY_SETTLING_DAYS,
    recomputeDelta: config.SUMMARY_RECOMPUTE_DELTA,
    cliffDays: config.SUMMARY_CLIFF_DAYS,
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
 *
 * `options.db` is for the third caller: `summaries:storylines`, which declares
 * `db: { session: true }` on its spec and therefore already holds exactly the
 * handle this needs. Passing it in is what lets that command run its pass
 * through `runChorePass` without opening a second session pool beside the one
 * `operator-command.ts` opened and will close.
 */
export function choreDepsFromConfig(
  config: Config,
  log: StorylinePassDeps["log"],
  options: { db?: Kysely<Database> } = {},
): StorylinePassDeps {
  const pacer = createModelPacer(config);
  return {
    // `session: true` and `max: 4`: the pass lock is session-scoped, so it must
    // not go through a transaction-mode pooler (`chore-runner.ts` has why), and
    // one connection is pinned holding it while the passes borrow the rest. What
    // it must not be is 1, which would deadlock against the pinned connection.
    db: options.db ?? createConfiguredDb(config, { max: 4, session: true }),
    config: {
      retentionDays: config.RETENTION_DAYS,
      storyDfWindowDays: config.STORYLINE_DF_WINDOW_DAYS,
      storylineDormancyDays: config.STORYLINE_DORMANCY_DAYS,
      timeZone: config.APP_TIMEZONE,
    },
    now: () => new Date(),
    log,
    linker: createLinkerConfig(config),
    // ONE pacer, handed to both clients: the ceiling is the key's, and the
    // labeler and the summariser are two models on one key (`createModelPacer`).
    labeler: createLabeler(config, log, pacer),
    summarizer: createSummarizer(config, log, pacer),
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
    summariesEnabled: config.SUMMARIES_ENABLED,
    summaryGate: {
      windowDays: config.SUMMARY_WINDOW_DAYS,
      minArticlesExclusive: config.SUMMARY_MIN_ARTICLES_PER_DAY,
      minGroups: config.SUMMARY_MIN_GROUPS,
    },
    maxSummaries: config.SUMMARY_MAX_PER_RUN,
    summaryBudgetMs: config.SUMMARY_BUDGET_MS,
    // The same reasoning as `labelRatePerMinute`: pace the PASS as well as the
    // client, so it spaces itself instead of piling into the pacer's queue.
    summaryRatePerMinute: config.GEMINI_MAX_RPM,
  };
}
