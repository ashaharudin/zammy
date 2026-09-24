import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { TraceEnvironment, TraceReadResponse } from "@zammy/shared/request-trace";
import { isPageVisible, usePrefersReducedMotion } from "../browser.js";
import { MONO } from "../theme.js";
import { useTheme } from "../ThemeProvider.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { buildTimeline, stepAt, type Pace, type Timeline } from "./choreography.js";
import { exampleBySlug, type ExampleTrace } from "./exampleTraces.js";
import type { Motion } from "./frame.js";
import { startLoop } from "./loop.js";
import {
  NOTICE_TEXT,
  offersCheckAgain,
  pollLine,
  readAnnouncement,
  readFailureNotice,
  recordAnnouncement,
  recordNotice,
  spokenText,
  type ReadMemory,
} from "./pageNotices.js";
import { INK_FALLBACK, readInk, type Ink } from "./palette.js";
import { PlaybackAnnouncer } from "./PlaybackAnnouncer.js";
import {
  carryAcrossPace,
  initialTransport,
  keyLegend,
  keyToAction,
  transport,
  withMotion,
  type Speed,
  type Transport,
  type TransportAction,
} from "./playbackClock.js";
import { usePlaybackPreferences } from "./playbackPreferences.js";
import {
  DEFAULT_EXAMPLE_SLUG,
  parsePlaybackLocation,
  playbackHref,
  type PlaybackTarget,
} from "./playbackRoute.js";
import { PlaybackStage, type StageHandle } from "./PlaybackStage.js";
import { RecordPanel } from "./RecordPanel.js";
import { SourceBar } from "./SourceBar.js";
import { StepList } from "./StepList.js";
import { describeHeadline, describeStep, honestyNotes, type PlaybackSource } from "./stepText.js";
import type { RecordResult } from "./traceFetch.js";
import {
  minutesLeft,
  nextClockChangeMs,
  pollStatus,
  traceQueryOptions,
  traceTimeLeftMs,
  type PollState,
  type PollStatus,
} from "./tracePoll.js";
import { TransportBar } from "./TransportBar.js";

/**
 * The request playback page, `/?trace` (ADR-0029, "The page is an operator's view on `/`"): a
 * trace played back as a 16-bit warehouse — a robot carrying the request past a turnstile, a
 * rack of Redis bins, a Postgres vault, a Currents mast, and through a hatch onto a belt where
 * worker robots pick up the jobs it enqueued — with the same content as a list of steps in
 * words.
 *
 * Its own lazy chunk (`App.tsx`), so none of this, and none of the trace schemas, reaches a
 * reader's main chunk. Entry and exit are full page loads; inside, the page switches what it
 * plays with `history.replaceState` only (a new example, a recorded id, a fresh recording), so
 * Back leaves the page rather than walking through everything that was watched, and the
 * record panel stays mounted — its token survives from one recording to the next, and only
 * for this visit (`RecordPanel.tsx`). The one change from outside it follows is a new `#t=`
 * fragment, which a browser applies without a load.
 *
 * What it plays comes from one of three places (`PlaybackSource`): a built-in example, a
 * recorded trace read back by id (`#t=<id>`) and polled while its job runs land
 * (`tracePoll.ts`), or a browser-only trace for a request no function could trace (a CDN
 * cache answer, or a platform 504). The status plate says which, always, and the legend under
 * the stage says what the page cannot see.
 *
 * Motion is opt-out, never forced (WCAG 2.2.2): with motion allowed it autoplays once and
 * never loops, and Pause is always there; under `prefers-reduced-motion` it does not autoplay,
 * shows a static overview map first, and plays by holding each step and jumping to the next.
 * The keyboard drives all of it (`keyToAction`), its letter shortcuts can be turned off (WCAG
 * 2.1.4), and the one live region (`PlaybackAnnouncer`, mounted here so a new trace does not
 * wipe it) speaks once per event: a reader's action, a record run coming back, a read
 * settling with something new, the poll giving up (`pageNotices.ts`). A control that goes
 * away under the reader's focus hands it on first — to the Play button or the status plate —
 * rather than dropping it on `<body>`.
 *
 * Deliberately not here: any canvas drawing (`PlaybackStage` → `drawList.ts`), any rule of
 * the transport (`playbackClock.ts`) or the choreography, any rule of the poll
 * (`tracePoll.ts`), and any wording of a step or a notice (`stepText.ts`, `pageNotices.ts`).
 */
export function PlaybackPage({ initial }: { initial: PlaybackTarget }) {
  const [start] = useState(() => resolveInitial(initial));
  const [target, setTarget] = useState<PlaybackTarget>(start.target);
  const [notices, setNotices] = useState<readonly string[]>(start.notices);
  const [local, setLocal] = useState<TraceReadResponse | null>(null);
  const prefs = usePlaybackPreferences();
  const reduced = usePrefersReducedMotion();
  const ink = usePageInk();
  const { spoken, say } = useSpoken();
  usePlaybackHead();

  const plateRef = useRef<HTMLElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  /** Set when the reader asks for a read ("Try again", "Check again"); spent by its settle. */
  const userAsked = useRef(false);

  /** Show something else: an example, a recorded id, a fresh recording's trace. */
  const pick = useCallback((next: PlaybackTarget) => {
    setLocal(null);
    setNotices([]);
    setTarget(next);
  }, []);

  // The URL says what is playing, always by replacement (see the header). A browser-only
  // trace is never put in it: there is nothing stored to link to.
  useEffect(() => {
    const href = playbackHref(target);
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (here !== href) window.history.replaceState(null, "", href);
  }, [target]);

  // The one navigation that is not a page load: a different `#t=` link pasted into the address
  // bar of a playback page already open changes only the fragment. It is followed, like a pick.
  useEffect(() => {
    const onHashChange = () => {
      const next = parsePlaybackLocation(
        window.location.pathname,
        window.location.search,
        window.location.hash,
      );
      if (!next) return;
      const resolved = resolveInitial(next);
      pick(resolved.target);
      setNotices(resolved.notices);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [pick]);

  // Read and polled only while it is what the page shows: a browser-only trace on screen
  // leaves the recorded one behind it unread, rather than polled and announced unseen.
  const recordedId = target.kind === "recorded" && local === null ? target.id : null;
  const recorded = useQuery(traceQueryOptions(recordedId));
  const pollState: PollState = { data: recorded.data, error: recorded.error };
  const nowMs = Date.now();
  const status = pollStatus(pollState, nowMs);

  // The poll window closing and the expiry badge counting down change what the page shows
  // with nothing else to re-render it (`nextClockChangeMs`), so a timer does.
  useRenderClock(recordedId === null ? null : nextClockChangeMs(pollState, nowMs));

  const fallback = defaultExample();
  const shown = ((): Shown | null => {
    if (local) return { response: local, source: "browser", example: null };
    if (target.kind === "example") {
      const example = exampleBySlug(target.slug) ?? fallback;
      return { response: example.response, source: "example", example };
    }
    if (recorded.data) {
      return {
        response: recorded.data.response,
        source: "recorded",
        example: null,
        // A 404 after a good read outranks any estimate of the time left.
        gone: status.kind === "expired",
        minutesLeft: minutesLeft(traceTimeLeftMs(recorded.data, nowMs)),
      };
    }
    // A recorded trace that could not be read leaves the page showing the default example —
    // never an empty stage — with the reason above it.
    if (recorded.isError)
      return { response: fallback.response, source: "example", example: fallback };
    return null;
  })();

  const onRecorded = useCallback(
    (result: RecordResult) => {
      const said = recordAnnouncement(result);
      if (said !== null) say(said);
      const notice = recordNotice(result);
      switch (result.kind) {
        case "traced":
          pick({ kind: "recorded", id: result.id });
          return;
        case "browser":
          setNotices(notice ? [notice] : []);
          setLocal(result.response);
          return;
        case "unstored":
        case "untraced":
          setNotices(notice ? [notice] : []);
          return;
        case "invalid":
          // The panel shows, and alerts, its own form errors.
          return;
      }
    },
    [pick, say],
  );

  // Each read that SETTLES is said once, if it brought something to say (`readAnnouncement`):
  // the first read's headline, job runs arriving, a failure — a poll failing the same way
  // again is not said again. Keyed on the settle counters, since a poll that brings back the
  // same record keeps the same `data` and would otherwise be invisible here.
  const readMemory = useRef<ReadMemory | null>(null);
  const { data, error, dataUpdatedAt, errorUpdatedAt } = recorded;
  useEffect(() => {
    if (recordedId === null || (dataUpdatedAt === 0 && errorUpdatedAt === 0)) return;
    const next = readAnnouncement(readMemory.current, {
      id: recordedId,
      data,
      error,
      userAsked: userAsked.current,
      nowMs: Date.now(),
    });
    userAsked.current = false;
    readMemory.current = next.memory;
    if (next.text !== null) say(next.text);
  }, [recordedId, data, error, dataUpdatedAt, errorUpdatedAt, say]);

  // The poll giving up is said once: nothing else would tell a reader who is not looking.
  const lastStatus = useRef<{ id: string | null; kind: PollStatus["kind"] }>({
    id: null,
    kind: "none",
  });
  const line = pollLine(status);
  useEffect(() => {
    const before = lastStatus.current;
    lastStatus.current = { id: recordedId, kind: status.kind };
    if (before.id !== recordedId || before.kind !== "waiting" || status.kind !== "stopped") return;
    if (line !== null) say(line);
  }, [recordedId, status.kind, line, say]);

  // A read that failed with nothing read yet explains the fallback example; one that failed
  // after a good read (a poll, "Check again") leaves the last copy playing and says so.
  const readFailure = recorded.isError
    ? readFailureNotice(recorded.error, recorded.data !== undefined)
    : null;

  /** "Try again": a read the reader asked for, with focus moved off a button about to go. */
  const tryAgain = () => {
    if (recorded.isFetching) return;
    // The button goes whichever way the read ends: with no copy read, the refetch puts the
    // query back to pending; with one, a good answer clears the failure. The plate, which
    // will say how it went, takes the focus first.
    plateRef.current?.focus();
    userAsked.current = true;
    void recorded.refetch();
  };

  /** "Check again": one more read. Focus stays on it, unless the answer takes it away. */
  const checkAgain = () => {
    if (recorded.isFetching) return;
    userAsked.current = true;
    void recorded.refetch().then((result) => {
      // TanStack re-renders the page a task after this resolves, so the button is still
      // mounted, and focused, here: hand focus on before it goes.
      const next = pollStatus({ data: result.data, error: result.error }, Date.now());
      if (offersCheckAgain(next)) return;
      if (next.kind === "expired") plateRef.current?.focus();
      else playRef.current?.focus();
    });
  };

  return (
    <div
      style={{
        maxWidth: "var(--page-max)",
        margin: "0 auto",
        padding: "1rem 16px 3rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        fontFamily: MONO,
      }}
    >
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.8rem" }}>
        <a href="/" style={{ fontWeight: 700, fontSize: "1.2rem", textDecoration: "none" }}>
          zammy&gt;
        </a>
        <h1 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>Request playback</h1>
        <span style={{ marginLeft: "auto" }}>
          <ThemeToggle />
        </span>
      </header>

      <SourceBar
        current={
          local === null && target.kind === "example" ? (shown?.example?.slug ?? null) : null
        }
        onExample={(slug) => pick({ kind: "example", slug })}
        onRecorded={(id) => pick({ kind: "recorded", id })}
      />
      <RecordPanel onResult={onRecorded} />

      <main style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: 0 }}>
        <StatusPlate
          ref={plateRef}
          shown={shown}
          notices={readFailure ? [readFailure.text, ...notices] : notices}
          loading={recordedId !== null && recorded.isPending}
          retry={readFailure?.retry ? tryAgain : null}
          busy={recorded.isFetching}
        />
        {shown && (
          <PlaybackView
            key={`${shown.source}:${shown.response.trace.id}`}
            response={shown.response}
            source={shown.source}
            pace={prefs.pace}
            speed={prefs.speed}
            letters={prefs.letters}
            onPace={prefs.setPace}
            onSpeed={prefs.setSpeed}
            onLetters={prefs.setLetters}
            reduced={reduced}
            ink={ink}
            say={say}
            playRef={playRef}
          >
            {shown.source === "recorded" && (line !== null || offersCheckAgain(status)) && (
              <div style={POLL_ROW}>
                {line !== null && <p style={{ ...NOTE, flex: "1 1 16rem" }}>{line}</p>}
                {offersCheckAgain(status) && (
                  <SmallButton onClick={checkAgain} busy={recorded.isFetching}>
                    {recorded.isFetching ? "Checking…" : "Check again"}
                  </SmallButton>
                )}
              </div>
            )}
          </PlaybackView>
        )}
      </main>
      <PlaybackAnnouncer message={spoken} />
    </div>
  );
}

type Shown =
  | { response: TraceReadResponse; source: "example" | "browser"; example: ExampleTrace | null }
  | {
      response: TraceReadResponse;
      source: "recorded";
      example: null;
      /** A read after a good one answered 404: the API no longer has it, whatever the clock says. */
      gone: boolean;
      minutesLeft: number;
    };

function defaultExample(): ExampleTrace {
  const found = exampleBySlug(DEFAULT_EXAMPLE_SLUG);
  if (!found) throw new Error(`no default example ${DEFAULT_EXAMPLE_SLUG}`);
  return found;
}

const BAD_ID =
  "That link named a recorded trace by something that is not a trace id, so the default " +
  "example is showing instead.";

/** The target the page opens on, and what to say about how it got there. */
function resolveInitial(initial: PlaybackTarget): {
  target: PlaybackTarget;
  notices: readonly string[];
} {
  if (initial.kind === "recorded") return { target: initial, notices: [] };
  if (initial.notice === "bad_id") {
    return { target: { kind: "example", slug: DEFAULT_EXAMPLE_SLUG }, notices: [BAD_ID] };
  }
  if (!exampleBySlug(initial.slug)) {
    const fallback = defaultExample();
    return {
      target: { kind: "example", slug: fallback.slug },
      notices: [`There is no example called “${initial.slug}”, so “${fallback.title}” is showing.`],
    };
  }
  return { target: { kind: "example", slug: initial.slug }, notices: [] };
}

/**
 * The live region's one sentence, and the setter every event says it through. Each `say`
 * bumps a serial, so saying the same sentence twice in a row still CHANGES the region and is
 * announced both times (`spokenText`).
 */
function useSpoken(): { spoken: string; say: (text: string) => void } {
  const [said, setSaid] = useState({ text: "", serial: 0 });
  const say = useCallback(
    (text: string) => setSaid((before) => ({ text, serial: before.serial + 1 })),
    [],
  );
  return { spoken: spokenText(said.text, said.serial), say };
}

/** Re-renders the caller `wakeInMs` from now, or never for null. */
function useRenderClock(wakeInMs: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (wakeInMs === null) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), wakeInMs);
    return () => window.clearTimeout(timer);
  }, [wakeInMs]);
}

/**
 * The page's ink, re-read whenever the theme changes. A PASSIVE effect on purpose: it runs
 * after `ThemeProvider`'s layout effect has written `data-theme`, whereas a layout effect
 * here — a child's — would run first and read the colours of the theme being left. The first
 * value is read at once — this chunk loads long after the provider first wrote the theme.
 */
function usePageInk(): Ink {
  const { theme } = useTheme();
  const [ink, setInk] = useState<Ink>(readPageInk);
  useEffect(() => {
    setInk(readPageInk());
  }, [theme]);
  return ink;
}

function readPageInk(): Ink {
  if (typeof getComputedStyle !== "function") return INK_FALLBACK;
  const style = getComputedStyle(document.documentElement);
  return readInk((token) => style.getPropertyValue(token));
}

/**
 * `noindex` and the tab title for as long as the page is open (ADR-0029, docs/SEO.md): the
 * view lives on `/`, whose canonical is `/`, and an operator's tool should never be indexed
 * as the home page. Both are undone on the way out.
 */
function usePlaybackHead(): void {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    const title = document.title;
    document.title = "Request playback · zammy";
    return () => {
      meta.remove();
      document.title = title;
    };
  }, []);
}

// ── the status plate ─────────────────────────────────────────────────────────

/**
 * What is playing, where it came from, and anything the page has to say about it.
 * Focusable from script only (`tabIndex={-1}`): it is where focus goes when the control the
 * reader used ("Try again", a "Check again" that found the trace gone) is about to go away,
 * since it is where the outcome will be written.
 */
function StatusPlate({
  ref,
  shown,
  notices,
  loading,
  retry,
  busy,
}: {
  ref?: Ref<HTMLElement>;
  shown: Shown | null;
  notices: readonly string[];
  loading: boolean;
  retry: (() => void) | null;
  busy: boolean;
}) {
  const trace = shown?.response.trace;
  const env = trace?.origin?.environment ?? null;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="Trace"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "0.8rem",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        background: "var(--surface)",
        fontSize: "0.8rem",
        lineHeight: 1.5,
        overflowWrap: "anywhere",
      }}
    >
      {notices.map((text) => (
        <p key={text} style={NOTICE_TEXT}>
          {text}
        </p>
      ))}
      {retry && (
        <div>
          <SmallButton onClick={retry} busy={busy}>
            Try again
          </SmallButton>
        </div>
      )}
      {loading && <p style={{ margin: 0, color: "var(--fg-muted)" }}>Reading the trace…</p>}
      {shown && trace && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem" }}>
            <Chip strong>{sourceBadge(shown)}</Chip>
            {env && environmentChips(env).map((chip) => <Chip key={chip}>{chip}</Chip>)}
            {trace.origin && (
              <Chip>
                {trace.origin.instanceSequence === 1
                  ? "first request on its instance"
                  : `request ${trace.origin.instanceSequence} on its instance`}
              </Chip>
            )}
          </div>
          <p style={{ margin: 0, color: "var(--fg)" }}>{describeHeadline(trace)}</p>
          {shown.example && (
            <p style={{ margin: 0, color: "var(--fg-muted)" }}>
              <strong style={{ color: "var(--fg)" }}>{shown.example.title}.</strong>{" "}
              {shown.example.summary}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function sourceBadge(shown: Shown): string {
  switch (shown.source) {
    case "example":
      return "Example — timings illustrative";
    case "browser":
      return "Browser-only — not saved";
    case "recorded":
      if (shown.gone) return "Recorded — no longer stored";
      return shown.minutesLeft > 0
        ? `Recorded — expires in ${shown.minutesLeft} min`
        : "Recorded — expired";
  }
}

/** The configuration facts the trace carries about the process that recorded it. */
function environmentChips(env: TraceEnvironment): string[] {
  return [
    env.queue === "bullmq" ? "BullMQ" : "Vercel Queues",
    `Currents ${env.currents}${env.gnews ? " + GNews" : ""}`,
    `Google News ${env.googleNews}`,
    `summaries ${env.summaries ? "on" : "off"}`,
    `labeler ${env.labeler ? "on" : "off"}`,
  ];
}

function Chip({ children, strong }: { children: string; strong?: boolean }) {
  return (
    <span
      style={{
        padding: "0.1rem 0.5rem",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: strong ? "var(--fg)" : "var(--chip-bg)",
        color: strong ? "var(--bg)" : "var(--fg-muted)",
        fontSize: "0.75rem",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/**
 * The page's small chip button. `busy` is `aria-disabled` with the click ignored, never
 * `disabled`: disabling the focused control drops keyboard focus on `<body>`, and every one
 * of these is pressed and then busy. `pressed` makes it a toggle.
 */
function SmallButton({
  children,
  onClick,
  busy,
  pressed,
}: {
  children: string;
  onClick: () => void;
  busy?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!busy) onClick();
      }}
      aria-disabled={busy || undefined}
      aria-pressed={pressed}
      style={{
        minHeight: "44px",
        padding: "0 0.9rem",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: pressed ? "var(--fg)" : "var(--chip-bg)",
        color: pressed ? "var(--bg)" : "var(--fg)",
        cursor: busy ? "progress" : "pointer",
        fontFamily: MONO,
        fontSize: "0.8rem",
      }}
    >
      {children}
    </button>
  );
}

const NOTE = { margin: 0, color: "var(--fg-muted)", fontSize: "0.8rem", lineHeight: 1.5 } as const;

const POLL_ROW = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem" } as const;

// ── the player ───────────────────────────────────────────────────────────────

/** The transport actions that count as the reader taking over from the overview. */
const TAKES_OVER: ReadonlySet<TransportAction["type"]> = new Set([
  "toggle",
  "play",
  "step",
  "seek",
  "restart",
  "end",
]);

interface TransportView {
  stepIndex: number;
  status: Transport["status"];
  speed: Speed;
  mode: Transport["mode"];
}

const viewOf = (state: Transport, timeline: Timeline): TransportView => ({
  stepIndex: stepAt(timeline, state.t),
  status: state.status,
  speed: state.speed,
  mode: state.mode,
});

const sameView = (a: TransportView, b: TransportView) =>
  a.stepIndex === b.stepIndex && a.status === b.status && a.speed === b.speed && a.mode === b.mode;

/**
 * One trace, played: the stage, the transport, the steps and the legend. Keyed by the trace
 * (`source:id`), so a different trace starts afresh — at the start, autoplaying if motion is
 * welcome — while the SAME trace changing under it keeps its place: a pace change keeps the
 * step (by what the step is, `carryAcrossPace`, since the paces order the steps differently),
 * and job runs arriving by poll keep the instant (and offer to play on if it had ended).
 *
 * The transport lives in a ref, not state: it changes every frame while playing, and a React
 * render per frame would be sixty renders a second for a picture the canvas repaints
 * directly. What the DOM shows of it (the step, the status, the speed, the mode) is mirrored
 * into state only when it changes. The frame loop runs only while playing (`startLoop`), and
 * its effect's cleanup stops it — which is what makes StrictMode's double-run harmless.
 *
 * It speaks through the page's `say`, not a region of its own: the page's region outlives
 * this component, which a new trace remounts.
 */
function PlaybackView({
  response,
  source,
  pace,
  speed,
  letters,
  onPace,
  onSpeed,
  onLetters,
  reduced,
  ink,
  say,
  playRef,
  children,
}: {
  response: TraceReadResponse;
  source: PlaybackSource;
  pace: Pace;
  speed: Speed;
  /** Whether the single-character shortcuts are on (`keyToAction`). */
  letters: boolean;
  onPace: (pace: Pace) => void;
  onSpeed: (speed: Speed) => void;
  onLetters: (on: boolean) => void;
  reduced: boolean;
  ink: Ink;
  say: (text: string) => void;
  /** The Play button, which a control that goes away hands focus to. */
  playRef: { current: HTMLButtonElement | null };
  children?: ReactNode;
}) {
  const timeline = useMemo(() => buildTimeline(response, { pace }), [response, pace]);
  const descriptions = useMemo(
    () => timeline.steps.map((step) => describeStep(step, timeline)),
    [timeline],
  );
  const notes = useMemo(() => honestyNotes(response, source), [response, source]);

  const transportRef = useRef<Transport | null>(null);
  if (transportRef.current === null) {
    transportRef.current = initialTransport({
      autoplay: !reduced,
      speed,
      mode: reduced ? "stepped" : "animated",
    });
  }
  const timelineRef = useRef(timeline);
  const stageRef = useRef<StageHandle | null>(null);
  const [view, setView] = useState<TransportView>(() => viewOf(transportRef.current!, timeline));
  const [interacted, setInteracted] = useState(false);
  const [stepsHidden, setStepsHidden] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [grew, setGrew] = useState(false);

  const getT = useCallback(() => transportRef.current!.t, []);
  const sync = useCallback(() => {
    const next = viewOf(transportRef.current!, timelineRef.current);
    setView((before) => (sameView(before, next) ? before : next));
  }, []);
  const repaint = useCallback(() => stageRef.current?.paint(), []);

  // The same trace, rebuilt: a new pace keeps the step; new job runs keep the instant.
  useLayoutEffect(() => {
    const previous = timelineRef.current;
    timelineRef.current = timeline;
    if (previous === timeline) return;
    const state = transportRef.current!;
    if (previous.pace !== timeline.pace) {
      transportRef.current = carryAcrossPace(state, previous, timeline);
    } else {
      const longer = timeline.duration > previous.duration;
      const resume = state.status === "ended" && longer;
      transportRef.current = {
        ...state,
        t: Math.min(state.t, timeline.duration),
        held: 0,
        status: resume ? "paused" : state.status,
      };
      if (resume) setGrew(true);
    }
    sync();
    repaint();
  }, [timeline, sync, repaint]);

  /**
   * One reader action: through the reducer, onto the stage, and said out loud — unless the
   * control already says it (`quiet`): the scrubber is a range input whose own
   * `aria-valuetext` a screen reader reads as it moves, and saying it twice is noise.
   */
  const act = useCallback(
    (action: TransportAction, quiet = false) => {
      const before = transportRef.current!;
      const tl = timelineRef.current;
      const next = transport(before, action, tl);
      transportRef.current = next;
      if (TAKES_OVER.has(action.type)) {
        setInteracted(true);
        setGrew(false);
      }
      if (next.speed !== before.speed) onSpeed(next.speed);
      sync();
      repaint();
      const said = quiet ? null : announcement(action, before, next, tl);
      if (said !== null) say(said);
    },
    [onSpeed, sync, repaint, say],
  );

  // The frame loop, only while playing.
  const playing = view.status === "playing";
  useEffect(() => {
    if (!playing) return;
    return startLoop({
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      isVisible: isPageVisible,
      onTick: (dtMs) => {
        transportRef.current = transport(
          transportRef.current!,
          { type: "tick", dtMs },
          timelineRef.current,
        );
        repaint();
        sync();
        return transportRef.current.status === "playing";
      },
    });
  }, [playing, sync, repaint]);

  // Reduced motion switched on or off while the page is open: step or glide from here on —
  // and a reader already watching it play keeps watching it, not the before-Play overview.
  useEffect(() => {
    const changed = withMotion(transportRef.current!, reduced, timelineRef.current);
    if (changed.state === transportRef.current) return;
    transportRef.current = changed.state;
    if (changed.takesOver) setInteracted(true);
    sync();
    repaint();
  }, [reduced, sync, repaint]);

  // The keyboard, window-wide (`keyToAction` leaves typing and native activation alone, and
  // the letters alone too while the reader has them off).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = keyToAction(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          target: event.target instanceof HTMLElement ? event.target : null,
        },
        { letters },
      );
      if (action === null) return;
      event.preventDefault();
      act(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [act, letters]);

  const onUnavailable = useCallback(() => setCanvasFailed(true), []);
  const seek = useCallback((stepIndex: number) => act({ type: "seek", stepIndex }), [act]);
  const scrub = useCallback((stepIndex: number) => act({ type: "seek", stepIndex }, true), [act]);
  const motion: Motion = reduced ? "reduced" : "full";
  const stepIndex = Math.min(view.stepIndex, timeline.steps.length - 1);
  const valueText = descriptions[stepIndex] ?? "";

  return (
    <>
      <div style={canvasFailed ? { display: "none" } : undefined}>
        <PlaybackStage
          ref={stageRef}
          timeline={timeline}
          motion={motion}
          ink={ink}
          overview={reduced && !interacted}
          getT={getT}
          onUnavailable={onUnavailable}
        />
      </div>
      {canvasFailed && (
        <p style={NOTE}>This browser cannot draw the floor plan; the steps below carry the same.</p>
      )}
      {reduced && !interacted && !canvasFailed && (
        <p style={NOTE}>
          Reduced motion is on, so this is the whole route at once: each badge lists the steps that
          happened there. Play steps through it one step at a time.
        </p>
      )}
      <TransportBar
        status={view.status}
        speed={view.speed}
        pace={pace}
        stepIndex={stepIndex}
        stepCount={timeline.steps.length}
        valueText={valueText}
        stepsHidden={stepsHidden && !canvasFailed}
        stepsHideable={!canvasFailed}
        onAction={act}
        onScrub={scrub}
        onPace={onPace}
        onToggleSteps={() => setStepsHidden((hidden) => !hidden)}
        playRef={playRef}
      >
        {grew && (
          <div>
            <SmallButton
              onClick={() => {
                // This button goes as soon as it is pressed; Play, which it pressed, keeps
                // the focus rather than `<body>`.
                playRef.current?.focus();
                setGrew(false);
                act({ type: "play" });
              }}
            >
              New job runs arrived — play on
            </SmallButton>
          </div>
        )}
        {children}
      </TransportBar>
      <div style={LEGEND}>
        {keyLegend(letters).map(({ keys, action }) => (
          <span key={keys} style={{ whiteSpace: "nowrap" }}>
            <kbd style={KBD}>{keys}</kbd> {action}
          </span>
        ))}
        <SmallButton pressed={letters} onClick={() => onLetters(!letters)}>
          Letter shortcuts
        </SmallButton>
      </div>
      <StepList
        descriptions={descriptions}
        current={stepIndex}
        hidden={stepsHidden && !canvasFailed}
        onSeek={seek}
      />
      {notes.length > 0 && (
        <section aria-label="What this playback cannot show" style={{ ...NOTE }}>
          <h2 style={{ margin: "0 0 0.4rem", fontSize: "0.85rem", color: "var(--fg)" }}>
            What this cannot show
          </h2>
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.2rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
            }}
          >
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const LEGEND = {
  ...NOTE,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.3rem 1rem",
} as const;

const KBD = {
  padding: "0 0.3rem",
  border: "1px solid var(--border)",
  borderRadius: "3px",
  background: "var(--chip-bg)",
  color: "var(--fg)",
  fontFamily: MONO,
} as const;

/**
 * What the live region says after a reader's action: "Playing", or where the action landed
 * ("Paused · Step 6 of 23 · …"); null for actions that move nothing (speed, mode), whose
 * buttons already carry their state (`aria-pressed`).
 */
function announcement(
  action: TransportAction,
  before: Transport,
  after: Transport,
  timeline: Timeline,
): string | null {
  const landing = timeline.steps[stepAt(timeline, after.t)];
  const where = landing ? describeStep(landing, timeline) : "";
  switch (action.type) {
    case "toggle":
    case "play":
    case "pause":
      if (after.status === "playing")
        return before.status === "ended" ? "Playing from the start" : "Playing";
      return before.status === "playing" ? `Paused · ${where}` : null;
    case "step":
    case "seek":
    case "restart":
    case "end":
      return where;
    default:
      return null;
  }
}
