import { afterEach, describe, expect, it } from "vitest";
import { isPageVisible } from "./browser.js";

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
