import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { watchDevicePixelRatio } from "../browser.js";
import type { Timeline } from "./choreography.js";
import { overviewOps, sceneOps } from "./drawList.js";
import { frameAt, type Motion } from "./frame.js";
import { chooseLayout, type LayoutChoice } from "./layout.js";
import type { Ink } from "./palette.js";
import { createAtlas, paint } from "./renderer.js";

/** What the page can ask of the stage between React renders: paint the current instant now. */
export interface StageHandle {
  paint(): void;
}

/**
 * The playback's canvas (ADR-0029, "The canvas is decoration; the words are the page"): the
 * one element on the page that is a picture rather than text, and so the one hidden from
 * assistive technology — the steps list below it carries the same content, in order, as real
 * buttons.
 *
 * It owns three things and nothing else:
 *  - **Size.** A `ResizeObserver` on its container asks `chooseLayout` for the plan and an
 *    INTEGER scale (the wide plan at ≥ 640 css px, the tall one below), so every logical pixel
 *    is an exact square of device pixels. The backing store is the plan times `backingScale`
 *    (the scale times the device pixel ratio) and the element is styled at the css size with
 *    `image-rendering: pixelated`, so the browser never resamples the art. The RATIO is
 *    watched too (`watchDevicePixelRatio`): a zoom or a move to another monitor changes it
 *    without changing the container's css width — the page is capped at `--page-max` — so
 *    the `ResizeObserver` alone would leave the backing store at the old ratio.
 *  - **The atlas**, every sprite frame pre-rendered once (`renderer.ts`).
 *  - **Painting**: `sceneOps(frameAt(t))` for the current instant, or the static
 *    `overviewOps` map while the page shows the overview (reduced motion, before Play).
 *
 * It does NOT own time. The page's transport lives in a ref and changes sixty times a second
 * while playing, so the page calls `paint()` through the handle after each change instead of
 * re-rendering this component per frame; `getT` reads the instant at paint time. Props that
 * change what is drawn (the timeline, the ink, the overview flag, the motion, the size) repaint
 * on their own.
 *
 * If the browser has no 2D context (a canvas blocked by policy, a hardened profile), the stage
 * says so through `onUnavailable` and draws nothing; the page then keeps the steps list shown.
 */
export function PlaybackStage({
  ref,
  timeline,
  motion,
  ink,
  overview,
  getT,
  onUnavailable,
}: {
  ref?: Ref<StageHandle>;
  timeline: Timeline;
  motion: Motion;
  ink: Ink;
  /** Draw the static overview map instead of the frame at `getT()`. */
  overview: boolean;
  getT: () => number;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [choice, setChoice] = useState<LayoutChoice | null>(null);
  const atlas = useMemo(() => createAtlas(document), []);

  // Measure before the first paint (a layout effect), then follow the container.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const next = chooseLayout(container.clientWidth, window.devicePixelRatio || 1);
      setChoice((current) =>
        current &&
        current.layout === next.layout &&
        current.scale === next.scale &&
        current.backingScale === next.backingScale
          ? current
          : next,
      );
    };
    measure();
    const unwatch = watchDevicePixelRatio(measure);
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        unwatch();
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      unwatch();
      observer.disconnect();
    };
  }, []);

  // The backing store follows the plan and scale; resizing it resets the context's state,
  // which `paint` sets afresh every time anyway.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !choice) return;
    canvas.width = choice.layout.width * choice.backingScale;
    canvas.height = choice.layout.height * choice.backingScale;
    if (contextRef.current === null) {
      contextRef.current = canvas.getContext("2d");
      if (contextRef.current === null) onUnavailable();
    }
  }, [choice, onUnavailable]);

  // The overview is a few hundred ops and a placement search: built once per plan and trace.
  const overviewList = useMemo(
    () => (overview && choice ? overviewOps(choice.layout, timeline, ink) : null),
    [overview, choice, timeline, ink],
  );

  // What a paint reads, kept current without making `paintNow` change identity every render.
  const latest = useRef({ timeline, motion, ink, choice, overviewList, getT });
  latest.current = { timeline, motion, ink, choice, overviewList, getT };

  const paintNow = useCallback(() => {
    const ctx = contextRef.current;
    const {
      timeline: tl,
      motion: m,
      ink: k,
      choice: c,
      overviewList: map,
      getT: now,
    } = latest.current;
    if (!ctx || !c) return;
    const ops = map ?? sceneOps(c.layout, frameAt(tl, c.layout, now(), m), k);
    paint(ctx, ops, atlas, c.backingScale, k.bg);
  }, [atlas]);

  useImperativeHandle(ref, () => ({ paint: paintNow }), [paintNow]);

  useEffect(() => {
    paintNow();
  }, [paintNow, choice, timeline, motion, ink, overviewList]);

  return (
    <div ref={containerRef} style={{ width: "100%" }}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          display: "block",
          margin: "0 auto",
          // The css size is an exact multiple of the plan; `height: auto` keeps the aspect
          // ratio should `maxWidth` ever bite (a container under 160 px, the one width no
          // integer scale fits).
          width: choice ? `${choice.cssWidth}px` : "100%",
          height: "auto",
          maxWidth: "100%",
          imageRendering: "pixelated",
          borderRadius: "2px",
          boxShadow: "var(--shadow)",
        }}
      />
      <p className="sr-only">Animated floor plan; the steps list below carries the same.</p>
    </div>
  );
}
