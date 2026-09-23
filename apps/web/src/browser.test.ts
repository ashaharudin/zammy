import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isPageVisible,
  prefersReducedMotion,
  usePrefersReducedMotion,
  watchDevicePixelRatio,
} from "./browser.js";

/**
 * `isPageVisible` is one line and needs no renderer to check — only a stand-in
 * for the global it reads. Worth the six lines because of what it gates: a
 * version of it stuck at `true` puts the progressive-fill poll back on a hidden
 * tab, which is forty invocations, forty Postgres round trips and forty Redis
 * ones per window that the reader cannot see and nothing else would notice.
 * That is a silent COST regression, the kind no assertion about rendering ever
 * catches, so the assertion has to be here.
 */
describe("isPageVisible", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "document");
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, "document", real);
    else delete (globalThis as { document?: unknown }).document;
  });

  const withVisibility = (visibilityState: string) => {
    Object.defineProperty(globalThis, "document", {
      value: { visibilityState },
      configurable: true,
    });
  };

  it("is false only for a hidden document", () => {
    withVisibility("hidden");
    expect(isPageVisible()).toBe(false);
  });

  it("is true for a visible one", () => {
    withVisibility("visible");
    expect(isPageVisible()).toBe(true);
  });

  // A tab being pre-rendered or in the back/forward cache. Not hidden, so it
  // polls — which is what TanStack's own reading did, and matching it is the
  // whole point of this function.
  it("is true for prerender, as the reading it replaces was", () => {
    withVisibility("prerender");
    expect(isPageVisible()).toBe(true);
  });

  // No DOM at all: a node test run, or SSR. `undefined !== "hidden"` is visible,
  // which is also what `focusManager.isFocused()` answers there.
  it("is true where there is no document to ask", () => {
    delete (globalThis as { document?: unknown }).document;
    expect(isPageVisible()).toBe(true);
  });
});

/**
 * The reduced-motion reading, moved here from `TrendingCloud` (ADR-0029). What
 * a regression looks like is a reader who asked for less motion getting it
 * anyway: the playback view autoplays a canvas that no stylesheet can hold
 * still, so a reading stuck at `false` is the whole of the accessibility
 * promise gone, and nothing on screen says so.
 */
describe("prefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A `matchMedia` that answers `matches` for the one query it recognises. */
  const stubMatchMedia = (matches: boolean) => {
    const asked: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      asked.push(query);
      return { matches: query === "(prefers-reduced-motion: reduce)" && matches };
    });
    return asked;
  };

  it("is true for a reader who asked for less motion", () => {
    const asked = stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    // The exact query, since a stub that answers every query would hide a typo.
    expect(asked).toEqual(["(prefers-reduced-motion: reduce)"]);
  });

  it("is false for a reader who did not", () => {
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  // A node test run, or a server render. The stylesheet's own media blocks are
  // what hold CSS motion still there; false is the half that cannot throw.
  it("is false where there is no matchMedia to ask", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

/**
 * The hook's FIRST render, which is the one thing about it that changed in the
 * move. The copy it replaces started at `false` and corrected itself in an
 * effect; the playback view decides on its first render whether to autoplay,
 * so that copy would have started the loop for exactly the reader it must not.
 *
 * The one render in this suite, and a server one on purpose: a static render
 * runs no effects, so what it prints is the seed and nothing else. A version
 * that seeded `false` and fixed it in `useEffect` renders "false" here and
 * passes in any renderer that runs effects.
 */
describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const firstRender = () =>
    renderToStaticMarkup(
      createElement(function Probe() {
        return createElement("output", null, String(usePrefersReducedMotion()));
      }),
    );

  it("already knows on the first render, before any effect runs", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(firstRender()).toBe("<output>true</output>");
  });

  it("renders false for a reader who did not ask, and where there is no matchMedia", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(firstRender()).toBe("<output>false</output>");
    vi.stubGlobal("matchMedia", undefined);
    expect(firstRender()).toBe("<output>false</output>");
  });
});

/**
 * The pixel-ratio watch behind the playback canvas's backing store (ADR-0029).
 * What a regression looks like: a zoom or a move to another monitor leaves the
 * canvas at the old ratio, and the browser resamples its pixel art unevenly —
 * or the watch fires once and never again, because the query it listens to
 * still names the ratio it started at.
 */
describe("watchDevicePixelRatio", () => {
  /** A window whose ratio the test moves, with `change` fired as a browser would. */
  const fakeWindow = (initial: number) => {
    const listeners = new Map<string, Set<() => void>>();
    const win = {
      devicePixelRatio: initial,
      asked: [] as string[],
      matchMedia(query: string) {
        win.asked.push(query);
        const set = listeners.get(query) ?? new Set<() => void>();
        listeners.set(query, set);
        return {
          addEventListener: (_: "change", listener: () => void) => set.add(listener),
          removeEventListener: (_: "change", listener: () => void) => set.delete(listener),
        };
      },
      /** Moves the ratio and fires `change` on every query that stopped matching. */
      setRatio(next: number) {
        const before = `(resolution: ${win.devicePixelRatio}dppx)`;
        win.devicePixelRatio = next;
        for (const listener of [...(listeners.get(before) ?? [])]) listener();
      },
      listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    };
    return win;
  };

  it("reports every change, re-arming on the new ratio each time", () => {
    const win = fakeWindow(2);
    const seen: number[] = [];
    watchDevicePixelRatio((ratio) => seen.push(ratio), win);
    win.setRatio(3);
    win.setRatio(1.5);
    win.setRatio(2);
    expect(seen).toEqual([3, 1.5, 2]);
    expect(win.asked).toEqual([
      "(resolution: 2dppx)",
      "(resolution: 3dppx)",
      "(resolution: 1.5dppx)",
      "(resolution: 2dppx)",
    ]);
    // One listener at a time: the old query's is removed when it fires.
    expect(win.listening()).toBe(1);
  });

  it("stops when asked, and leaves no listener behind", () => {
    const win = fakeWindow(2);
    const seen: number[] = [];
    const stop = watchDevicePixelRatio((ratio) => seen.push(ratio), win);
    win.setRatio(3);
    stop();
    win.setRatio(1);
    expect(seen).toEqual([3]);
    expect(win.listening()).toBe(0);
  });

  it("watches nothing where there is no matchMedia", () => {
    expect(() => watchDevicePixelRatio(() => {}, { devicePixelRatio: 2 })()).not.toThrow();
    expect(() => watchDevicePixelRatio(() => {}, undefined)()).not.toThrow();
  });
});
