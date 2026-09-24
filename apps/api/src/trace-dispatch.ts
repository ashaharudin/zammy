import { JobRun, MAX_JOB_REF_DEPTH, type RunSource, type Touch } from "@zammy/shared/request-trace";
import { ingestJobId, type IngestHandler, type IngestJob } from "./ingest-queue.js";
import type { Services } from "./server.js";
import { createTouchScope } from "./trace-deps.js";
import { createTouchRecorder, type SealedRecord } from "./trace-recorder.js";
import { jobKindOf, jobPlaneOf, upstreamFailureOf } from "./trace-redact.js";
import type { JobLink, TraceRuntime } from "./trace-store.js";

/**
 * The consumer side of request tracing (ADR-0029, "The change" 6): a job a
 * traced request enqueued is run over traced deps, and its run is appended to
 * every trace that asked for it.
 *
 * **One seam covers every consumer.** `ingestDispatch` is what the in-process
 * BullMQ worker, the push-mode Vercel function and the manual drain all hand
 * their jobs to, so wrapping it here is the whole of the consumer change: no
 * transport, no retry policy, no job id and no payload is touched.
 *
 * **The link is looked up by the job's own id.** The request wrote
 * `<q>:trace:job:<ingestJobId>` before it published (`trace-deps.ts`), so a
 * run finds its traces whichever consumer runs it, however late — a
 * redelivery at +305 s or the drain 15–25 minutes on. The lookup is one
 * `SMEMBERS` per delivery while tracing is on, and that is the standing charge
 * the ADR's "on for a session, then off" policy is about. No link: the plain
 * handler runs over the boot bundles BY IDENTITY.
 *
 * **A linked run is observed, never altered.** It runs the same processor over
 * a traced copy of the bundles, and whatever it throws is rethrown UNCHANGED,
 * so `createMessageHandler`'s retry-or-give-up and the drain's settle see
 * exactly what they would have. The run record is written either way; the
 * links are consumed only after an OK run — a thrown one leaves them for the
 * redelivery, which appends another record under the same ref, and an ok one
 * removes them so a later identical job someone ELSE enqueues (the queue's
 * 900 s dedup has long expired) is never appended to this trace.
 *
 * What it deliberately does NOT see: a run that started before the link landed
 * (the lookup is a snapshot at dispatch start), the SDK's lease and ack around
 * the handler, and anything the job does after it returns — its recorder is
 * sealed, so a label tail it did not await is dropped.
 */

/** What the dispatch needs from `Services`: the three bundles the processors take. */
export type DispatchBundles = Pick<Services, "deps" | "trendingDeps" | "summarizeDeps">;

/**
 * Wrap a dispatch so that linked jobs are traced.
 *
 * `dispatchOver` is a parameter rather than an import so this module never
 * imports `server.ts` at runtime (`Services` is type-only here). `plain` is
 * built once, over the boot bundles; a traced dispatch is built per linked job.
 */
export function traceRuns(
  bundles: DispatchBundles,
  runtime: TraceRuntime,
  dispatchOver: (bundles: DispatchBundles) => IngestHandler,
  source: RunSource,
): IngestHandler {
  const plain = dispatchOver(bundles);

  return async (job: IngestJob): Promise<void> => {
    let links: JobLink[] = [];
    let jobId = "";
    let sequence = 1;
    let redisAtStart: ReturnType<TraceRuntime["redisStatus"]> = "down";
    try {
      sequence = runtime.nextSequence();
      redisAtStart = runtime.redisStatus();
      jobId = ingestJobId(job);
      links = await runtime.linksForJob(jobId);
    } catch {
      links = [];
    }
    if (links.length === 0) return plain(job);

    let traced: IngestHandler;
    let seal: () => SealedRecord;
    try {
      const recorder = createTouchRecorder({ maxTouches: runtime.maxTouches });
      const scope = createTouchScope({ recorder, runtime, traceId: null, parentLinks: links });
      traced = dispatchOver({
        deps: scope.wrap(bundles.deps),
        trendingDeps: scope.wrap(bundles.trendingDeps),
        summarizeDeps: scope.wrap(bundles.summarizeDeps),
      });
      seal = () => recorder.seal();
    } catch {
      // A tracer that cannot be built is a job that is not traced.
      return plain(job);
    }

    const startedAt = new Date();
    let threw = false;
    let error: unknown;
    try {
      await traced(job);
    } catch (caught) {
      threw = true;
      error = caught;
    }

    try {
      await appendRuns(runtime, {
        job,
        links,
        source,
        startedAt,
        sequence,
        redisAtStart,
        sealed: seal(),
        threw,
        error,
      });
    } catch {
      // The run is missing from its traces; the job's result is not affected.
    }

    if (!threw) {
      try {
        await runtime.consumeLinks(jobId, links);
      } catch {
        // The links expire with their TTL instead.
      }
    }

    // The SAME error, unwrapped: the consumer's retry policy reads its kind.
    if (threw) throw error;
  };
}

/**
 * One run's touches as trace L knows them: every queue touch's local ref `n`
 * becomes `${L.ref}.${n}` — the child this run enqueued — or stays `n` and reads
 * unlinked when that would nest past `MAX_JOB_REF_DEPTH` (no link was written
 * for it, so no run of it can arrive).
 */
function renderFor(link: JobLink, touches: readonly Touch[]): Touch[] {
  const tooDeep = link.ref.split(".").length >= MAX_JOB_REF_DEPTH;
  return touches.map((touch) => {
    if (touch.station !== "queue") return touch;
    return tooDeep ? { ...touch, linked: false } : { ...touch, ref: `${link.ref}.${touch.ref}` };
  });
}

async function appendRuns(
  runtime: TraceRuntime,
  run: {
    job: IngestJob;
    links: readonly JobLink[];
    source: RunSource;
    startedAt: Date;
    sequence: number;
    redisAtStart: ReturnType<TraceRuntime["redisStatus"]>;
    sealed: SealedRecord;
    threw: boolean;
    error: unknown;
  },
): Promise<void> {
  const plane = jobPlaneOf(run.job);
  const results = await Promise.allSettled(
    run.links.map(async (link) => {
      const parsed = JobRun.safeParse({
        v: 1,
        ref: link.ref,
        job: jobKindOf(run.job),
        ...(plane === undefined ? {} : { plane }),
        source: run.source,
        startedAt: run.startedAt.toISOString(),
        ms: run.sealed.ms,
        overheadMs: run.sealed.overheadMs,
        result: run.threw ? "threw" : "ok",
        ...(run.threw ? { failure: upstreamFailureOf(run.error) } : {}),
        // More than one link means the queue deduplicated one job several traces
        // asked for, and this single run is every one of theirs.
        sharedWith: run.links.length,
        origin: runtime.origin(run.sequence, run.redisAtStart),
        touches: renderFor(link, run.sealed.touches),
        elided: run.sealed.elided,
      });
      if (!parsed.success) {
        runtime.warnUnstored({
          reason: "schema",
          paths: parsed.error.issues.map((issue) => issue.path.join(".")),
        });
        return;
      }
      // The PARSE OUTPUT, as with the request record. Only a `failed` append is
      // warned: a `capped` one reached Redis and was trimmed by design (ADR-0029
      // does not record a trace's runs past the sixteenth), and calling that a
      // Redis failure would send the operator to debug a Redis that is fine.
      if ((await runtime.appendRun(link.traceId, parsed.data)) === "failed") {
        runtime.warnUnstored({ reason: "redis" });
      }
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") runtime.warnUnstored({ reason: "redis" });
  }
}
