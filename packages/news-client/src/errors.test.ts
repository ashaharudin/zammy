import { describe, expect, it } from "vitest";
import {
  NewsAuthError,
  NewsBlockedError,
  NewsCallerAbortedError,
  NewsCircuitOpenError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsSchemaError,
  NewsTimeoutError,
  NewsUpstreamError,
  isNewsError,
  tagProvider,
} from "./errors.js";

/**
 * The structural guard, which had no tests of its own until it started deciding
 * things (ARCHITECTURE 5.3).
 *
 * `isNewsError` is the check every caller uses in place of `instanceof`, so that
 * an error crossing a package boundary is still recognised. What it returns is
 * load-bearing in four places: the transport wraps a `false` in a retryable
 * `NewsUpstreamError`, decides whether to retry it, and counts it against the
 * breaker; and the ingest consumer settles a delivery on the strength of it. A
 * guard that quietly narrowed would turn a revoked key into three deliveries
 * and a 502 into an unretried failure — neither with an error anywhere.
 */

/** One of each, so a new member of the taxonomy cannot slip past the guard. */
const everyKind = () => [
  new NewsAuthError("401"),
  new NewsBlockedError("cloudflare 1010"),
  new NewsInvalidQueryError("400"),
  new NewsQuotaError("429"),
  new NewsUpstreamError("502", 502),
  new NewsCircuitOpenError("open", new Date("2026-08-26T00:00:30.000Z")),
  new NewsTimeoutError("deadline"),
  new NewsCallerAbortedError("budget spent"),
  new NewsSchemaError("unparseable body"),
];

describe("isNewsError", () => {
  it("recognises every member of the taxonomy", () => {
    for (const error of everyKind()) {
      expect(isNewsError(error), error.name).toBe(true);
    }
  });

  it("guarantees the three fields it narrows to, `provider` included", () => {
    // The reason `provider` is CHECKED and not merely asserted: callers read it
    // straight off the narrowed type into log lines that are sometimes a
    // failure's only diagnosis, and an unchecked assertion logs `undefined` at
    // exactly that moment. Every class carries it from the base field
    // initializer, so this costs a real error nothing.
    for (const error of everyKind()) {
      expect(typeof error.provider, error.name).toBe("string");
      expect(Object.hasOwn(error, "provider"), error.name).toBe(true);
    }
  });

  it("rejects an error-shaped object that is missing a field it promises", () => {
    const kindOnly = Object.assign(new Error("half a news error"), {
      kind: "invalid_query",
      retryable: false,
    });
    expect(isNewsError(kindOnly)).toBe(false);

    const providerless = Object.assign(new Error("no provider"), {
      kind: "upstream",
      retryable: true,
    });
    expect(isNewsError(providerless)).toBe(false);
  });

  it("rejects anything that is not an Error, however well-shaped", () => {
    // A plain object survives `JSON.parse(JSON.stringify(err))`; an `Error` does
    // not. Callers must treat a revived error as unrecognised rather than act
    // on fields that outlived the prototype.
    expect(
      isNewsError({ kind: "auth", retryable: false, provider: "currents", message: "401" }),
    ).toBe(false);
    expect(isNewsError(new Error("plain"))).toBe(false);
    expect(isNewsError(null)).toBe(false);
    expect(isNewsError(undefined)).toBe(false);
  });

  it("still recognises an error after the boundary tag is stamped on it", () => {
    // `tagProvider` runs on the way out of an adapter and is the reason the
    // field is populated for anything the guard will ever see in anger.
    const tagged = tagProvider(new NewsAuthError("401"), "currents");
    expect(tagged.provider).toBe("currents");
    expect(isNewsError(tagged)).toBe(true);
  });
});
