import type { CSSProperties, ReactNode, Ref } from "react";
import { MONO } from "../theme.js";
import type { Pace } from "./choreography.js";
import { SPEEDS, type Speed, type Transport, type TransportAction } from "./playbackClock.js";

/**
 * The playback's controls (ADR-0029, "The canvas is decoration; the words are the page"):
 * restart, step back, play/pause, step forward, end; the speed; the pace; showing or hiding
 * the steps; and a scrubber over the steps.
 *
 * Every control is a real `<button>` (or, for the scrubber, a real range input), so the
 * keyboard, a switch device and a screen reader all reach it without help, and each toggle
 * says its state with `aria-pressed` rather than by colour alone. The glyphs are decorative
 * (`aria-hidden`, and pinned to text presentation with U+FE0E so no platform swaps in a
 * colour emoji); every button's name is its `aria-label`. The scrubber's
 * `aria-valuetext` is the landing step in words, so dragging it reads "Step 6 of 23 · Request
 * · Redis · …" rather than "6".
 *
 * Play is ONE toggle with one name: the constant label "Play", its state in `aria-pressed`,
 * and a tooltip that says the same. A name of "Play" with a description of "Pause" (a
 * tooltip that followed the state) had a screen reader announce "Play, pressed, Pause", and
 * a speech-input user who said the tooltip they could see matched nothing.
 *
 * The page's window-level shortcuts (`keyToAction`) keep working while one of these buttons
 * has focus — only Space is left to the button, which already clicks on it natively — and
 * the range input keeps its own arrow keys, which move it a step at a time.
 *
 * Laid out as three wrapping rows — transport, then speed and pace, then the full-width
 * scrubber — with 44 px targets, so a 375 px phone gets the same controls without a
 * horizontal scroll. Deliberately not here: any state. The page owns the transport, and
 * this bar only reports what the reader pressed (`onAction`, `onScrub`, `onPace`,
 * `onToggleSteps`).
 */
export function TransportBar({
  status,
  speed,
  pace,
  stepIndex,
  stepCount,
  valueText,
  stepsHidden,
  stepsHideable,
  onAction,
  onScrub,
  onPace,
  onToggleSteps,
  playRef,
  children,
}: {
  status: Transport["status"];
  speed: Speed;
  pace: Pace;
  stepIndex: number;
  stepCount: number;
  /** The current step in words: the scrubber's `aria-valuetext`. */
  valueText: string;
  stepsHidden: boolean;
  /** False when the canvas is unavailable: the steps are then the only view, so they stay. */
  stepsHideable: boolean;
  onAction: (action: TransportAction) => void;
  /** The scrubber moved to a step: a seek its own `aria-valuetext` already announces. */
  onScrub: (stepIndex: number) => void;
  onPace: (pace: Pace) => void;
  onToggleSteps: () => void;
  /** The Play button, for the page to hand focus to when a control it replaces goes away. */
  playRef?: Ref<HTMLButtonElement>;
  /** Extra controls for this trace ("Check again", "play on"), after the rows. */
  children?: ReactNode;
}) {
  const playing = status === "playing";
  return (
    <div
      role="group"
      aria-label="Playback controls"
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontFamily: MONO }}
    >
      <div style={ROW}>
        <ControlButton
          label="Restart"
          glyph={"⏮\uFE0E"}
          onClick={() => onAction({ type: "restart" })}
        />
        <ControlButton
          label="Step back"
          glyph="◁"
          onClick={() => onAction({ type: "step", delta: -1 })}
        />
        <ControlButton
          ref={playRef}
          label="Play"
          glyph={playing ? "❚❚" : "▶\uFE0E"}
          pressed={playing}
          wide
          onClick={() => onAction({ type: "toggle" })}
        />
        <ControlButton
          label="Step forward"
          glyph="▷"
          onClick={() => onAction({ type: "step", delta: 1 })}
        />
        <ControlButton label="End" glyph={"⏭\uFE0E"} onClick={() => onAction({ type: "end" })} />
      </div>
      <div style={ROW}>
        <div role="group" aria-label="Speed" style={GROUP}>
          {SPEEDS.map((s) => (
            <ControlButton
              key={s}
              label={`${s}× speed`}
              glyph={`${s}×`}
              pressed={speed === s}
              onClick={() => onAction({ type: "speed", speed: s })}
            />
          ))}
        </div>
        <div role="group" aria-label="Pace" style={GROUP}>
          <ControlButton
            label="Readable pace"
            glyph="Readable"
            pressed={pace === "readable"}
            onClick={() => onPace("readable")}
          />
          <ControlButton
            label="Real-time pace"
            glyph="Real time"
            pressed={pace === "real"}
            onClick={() => onPace("real")}
          />
        </div>
        {stepsHideable && (
          <ControlButton
            label="Hide steps"
            glyph="Hide steps"
            pressed={stepsHidden}
            onClick={onToggleSteps}
          />
        )}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.8rem" }}>
        <span style={{ color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
          Step {stepIndex + 1}/{stepCount}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, stepCount - 1)}
          step={1}
          value={stepIndex}
          aria-label="Step"
          aria-valuetext={valueText}
          onChange={(event) => onScrub(Number(event.target.value))}
          style={{ flex: 1, minWidth: 0, minHeight: "44px", accentColor: "var(--fg)" }}
        />
      </label>
      {children}
    </div>
  );
}

const ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.4rem",
};

const GROUP: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.25rem" };

/**
 * One control: a 44 px target, the house chip look (`ThemeToggle`, the cloud's toggle), and
 * a filled face while pressed so a toggle's state is visible as well as announced.
 */
function ControlButton({
  ref,
  label,
  glyph,
  pressed,
  wide,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  glyph: string;
  pressed?: boolean;
  wide?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      // The tooltip IS the name, so it is never exposed as a description saying otherwise.
      title={label}
      onClick={onClick}
      style={{
        minWidth: wide ? "56px" : "44px",
        minHeight: "44px",
        padding: "0 0.7rem",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: pressed ? "var(--fg)" : "var(--chip-bg)",
        color: pressed ? "var(--bg)" : "var(--fg)",
        cursor: "pointer",
        fontFamily: MONO,
        fontSize: "0.85rem",
        lineHeight: 1,
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
