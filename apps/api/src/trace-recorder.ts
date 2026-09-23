import {
  MAX_TRACE_MS,
  MAX_TRACE_TOUCHES,
  type Elision,
  type Station,
  type Touch,
  type TouchOf,
  type TouchOutcome,
} from "@zammy/shared/request-trace";

/**
 * The touch recorder (ADR-0029): an ordered, bounded list of what one traced
 * request or one job run touched, in the order it began touching it.
 *
 * **Pure, total, and never a reason for a request to fail.** No I/O, no timers,
 * no promise — just arithmetic over a clock — and every method swallows its own
 * faults and degrades to "that touch is missing". The wrappers in
 * `trace-deps.ts` call it from inside Redis, Kysely, the news clients and the
 * queue, so a throw here would be a throw inside a reader's request; the rule
 * across the tracer is that the recorder calls are wrapped and the inner call
 * never is.
 *
 * **Bounded, with the head and the tail kept.** A cold search makes 300+
 * Postgres statements, and the parts of a record worth drawing are its opening
 * (the rate limit, the cache, the lock, the upstream call) and its epilogue
 * (the enqueues, the ledger read). So past the cap the first
 * `ceil(0.6 × cap)` touches are kept in full, the rest sit in a ring of the
 * newest, and whatever the ring evicts is COUNTED into one `Elision` — how
 * many, of which stations, over what span — rather than silently dropped. A
 * record that lost its middle says so (ADR-0029, "The change" 4).
 *
 * **Sealed once.** `seal()` freezes the record: touches that never ended read
 * `{ ms: null, outcome: "open" }` and every later `begin`/`end`/`prepend` is a
 * no-op. That is what stops the fire-and-forget label tail
 * (`grouping-service.ts`) adding touches after the response has left, and it is
 * why a failed Postgres statement — Kysely never reports a throw to a plugin —
 * reads `open` rather than being invented a duration.
 *
 * What it deliberately does NOT do: hold arguments. A `TouchStart` is the
 * station's closed-vocabulary fields and nothing else, so the recorder cannot
 * be handed a key, a URL or a value to keep even by mistake.
 */

/** A touch without its timing and outcome: what `begin` is handed. */
export type TouchStart = {
  [S in Station]: Omit<TouchOf<S>, "at" | "ms" | "outcome">;
}[Station];

/** The one thing a caller holds between a touch's start and its end. */
export interface TouchHandle {
  /**
   * Idempotent: the first call wins. `patch` may carry station fields decided at
   * the end (an upstream `failure`), and can never overwrite `station`, `at`,
   * `ms` or `outcome`. Ignored after seal, and after the touch was evicted from
   * the ring into the elision.
   */
  end(outcome: TouchOutcome, patch?: Partial<Record<string, unknown>>): void;
}

/** What `seal()` produces, and what the trace record and job runs are built from. */
export interface SealedRecord {
  /** The prepend, then the head, then the ring — each in begin order. */
  touches: Touch[];
  elided: Elision | null;
  /** `now()` at seal: the whole record's duration, excluding whatever comes after. */
  ms: number;
  /** The tracer's own awaited work inside `ms` (job-link writes), rounded to 0.1 ms. */
  overheadMs: number;
}

export interface TouchRecorder {
  /** The clock reading every offset is relative to. */
  readonly t0: number;
  readonly sealed: boolean;
  /**
   * How many job refs `nextRef` has handed out, overflow included. Past 99 the
   * ref saturates at "99", and this is how a caller tells the 100th enqueue from
   * the 99th and marks it unlinked (a ref that names two jobs names neither).
   */
  readonly refsIssued: number;
  /** `clock() − t0`, rounded to 0.1 ms and clamped to `[0, MAX_TRACE_MS]`. */
  now(): number;
  /** Start a touch. After seal, a no-op handle. */
  begin(start: TouchStart): TouchHandle;
  /**
   * A complete touch placed FIRST at seal and exempt from elision — the
   * inferred rate-limit touch, which is only known once the reply exists but
   * happened before anything else. It takes one of the record's slots. Only the
   * first prepend is kept.
   */
  prepend(touch: Touch): void;
  /** The next local job ref: "1", "2", … "99"; past 99 it stays "99" (see `refsIssued`). */
  nextRef(): string;
  /** Add the tracer's own awaited time. Non-finite or negative amounts are ignored. */
  addOverhead(ms: number): void;
  /** Idempotent: later calls return the same record. */
  seal(): SealedRecord;
}

/** The highest local job ref a record hands out (`JOB_REF_PATTERN`'s two digits). */
export const MAX_LOCAL_REF = 99;

/** The share of the cap kept from the start of the record; the rest is the newest. */
const HEAD_SHARE = 0.6;

interface Entry {
  readonly start: TouchStart;
  /** Raw clock reading at begin — the offsets are rounded from these, never from each other. */
  readonly atRaw: number;
  readonly at: number;
  ms: number | null;
  outcome: TouchOutcome | null;
  patch: Partial<Record<string, unknown>> | null;
  /** Evicted from the ring into the elision: its handle is dead. */
  evicted: boolean;
}

const NOOP_HANDLE: TouchHandle = { end: () => {} };

/** 0.1 ms, which is finer than anything the page draws and coarser than jitter. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_TRACE_MS, Math.max(0, value));
}

/**
 * A recorder for one request or one job run.
 *
 * `maxTouches` is config's `REQUEST_TRACE_MAX_TOUCHES`, and it may only LOWER
 * the shared `MAX_TRACE_TOUCHES`: the schema would refuse a longer record, and a
 * record the schema refuses is a record that is not stored.
 */
export function createTouchRecorder(options: {
  maxTouches: number;
  clock?: () => number;
}): TouchRecorder {
  const clock = options.clock ?? (() => performance.now());
  const requested = Number.isFinite(options.maxTouches) ? Math.floor(options.maxTouches) : 0;
  // At least 2, so the head and the ring each have a slot and a prepend still
  // leaves one; config's own floor is 32, so this only guards a caller in a test.
  const cap = Math.max(2, Math.min(requested, MAX_TRACE_TOUCHES));
  const headCap = Math.ceil(cap * HEAD_SHARE);

  let t0 = 0;
  try {
    t0 = clock();
  } catch {
    t0 = 0;
  }

  const head: Entry[] = [];
  const ring: Entry[] = [];
  let prepended: Touch | null = null;
  let sealed: SealedRecord | null = null;
  let refs = 0;
  let overhead = 0;
  let elision: {
    count: number;
    stations: Partial<Record<Station, number>>;
    fromAt: number;
    toAt: number;
  } | null = null;

  const read = (): number => {
    try {
      return clock();
    } catch {
      return t0;
    }
  };
  const offset = (raw: number): number => round1(clampMs(raw - t0));

  /** How many the ring may hold right now: a prepend takes one of the cap's slots. */
  const ringCap = (): number => cap - headCap - (prepended === null ? 0 : 1);

  const evictOldest = (): void => {
    const gone = ring.shift();
    if (gone === undefined) return;
    gone.evicted = true;
    const station = gone.start.station;
    if (elision === null) {
      elision = { count: 0, stations: {}, fromAt: gone.at, toAt: gone.at };
    }
    elision.count += 1;
    elision.stations[station] = (elision.stations[station] ?? 0) + 1;
    elision.fromAt = Math.min(elision.fromAt, gone.at);
    elision.toAt = Math.max(elision.toAt, gone.at);
  };

  const render = (entry: Entry): Touch => {
    const ended = entry.outcome !== null;
    // The patch UNDER everything else, so it can add a station's end-time field
    // (`failure`) but never rewrite the station, what began the touch, or what
    // the recorder measured.
    return {
      ...(entry.patch ?? {}),
      ...entry.start,
      at: entry.at,
      ms: ended ? entry.ms : null,
      outcome: ended ? entry.outcome : "open",
    } as Touch;
  };

  return {
    get t0() {
      return t0;
    },
    get sealed() {
      return sealed !== null;
    },
    get refsIssued() {
      return refs;
    },

    now() {
      return offset(read());
    },

    begin(start) {
      try {
        if (sealed !== null) return NOOP_HANDLE;
        const atRaw = read();
        const entry: Entry = {
          start,
          atRaw,
          at: offset(atRaw),
          ms: null,
          outcome: null,
          patch: null,
          evicted: false,
        };
        if (head.length < headCap) {
          head.push(entry);
        } else {
          ring.push(entry);
          while (ring.length > Math.max(0, ringCap())) evictOldest();
        }
        return {
          end(outcome, patch) {
            try {
              if (sealed !== null || entry.evicted || entry.outcome !== null) return;
              entry.ms = round1(clampMs(read() - entry.atRaw));
              entry.outcome = outcome;
              entry.patch = patch ?? null;
            } catch {
              // A touch that could not be ended reads `open`, which is true.
            }
          },
        };
      } catch {
        return NOOP_HANDLE;
      }
    },

    prepend(touch) {
      try {
        if (sealed !== null || prepended !== null) return;
        prepended = touch;
        // The slot it takes comes out of the ring, oldest first — the head is
        // the part of a long record worth keeping whole.
        while (ring.length > Math.max(0, ringCap())) evictOldest();
      } catch {
        // Nothing to undo: at worst the record is one touch over, and the
        // schema's ceiling is still the recorder's cap plus nothing.
      }
    },

    nextRef() {
      refs += 1;
      return String(Math.min(refs, MAX_LOCAL_REF));
    },

    addOverhead(ms) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) overhead += ms;
    },

    seal() {
      if (sealed !== null) return sealed;
      try {
        const touches: Touch[] = [];
        if (prepended !== null) touches.push(prepended);
        for (const entry of head) touches.push(render(entry));
        for (const entry of ring) touches.push(render(entry));
        const gap = elision as typeof elision;
        sealed = {
          touches,
          elided:
            gap === null
              ? null
              : {
                  // The index of the last touch BEFORE the gap: the end of the
                  // head, shifted one along by a prepend.
                  after: head.length - 1 + (prepended === null ? 0 : 1),
                  count: gap.count,
                  stations: { ...gap.stations },
                  fromAt: gap.fromAt,
                  toAt: gap.toAt,
                },
          ms: offset(read()),
          overheadMs: round1(clampMs(overhead)),
        };
      } catch {
        sealed = { touches: [], elided: null, ms: 0, overheadMs: 0 };
      }
      return sealed;
    },
  };
}
