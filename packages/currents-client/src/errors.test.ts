import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  NewsAuthError,
  NewsBlockedError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsSchemaError,
  NewsUpstreamError,
} from "@zammy/news-client";
import { mapErrorResponse } from "./map-error.js";
import { RawCategories, RawLanguages, RawRegions } from "./raw.js";
import { FIXTURES_DIR, makeClient, quotaHeaders, stubFetch } from "./test-support.js";

/**
 * The client error taxonomy, bound to real captured bodies
 * (ARCHITECTURE 12, `error-and-reference-bodies.json`).
 *
 * These assertions are deliberately written against the recorded payloads rather
 * than against hand-written JSON, because the recorded shapes are the evidence:
 * neither the 400 nor the 401 body matches the OpenAPI spec's `ApiResponse`
 * definition, so a synthetic fixture would have been written from the spec and
 * would have tested the wrong shape.
 */

// `object` rather than `unknown`: every field is a captured HTTP response body,
// so all nine are JSON objects, and the point of the file — that no shape is
// asserted here — is unaffected. `unknown` additionally meant these could not be
// handed to `stubFetch` as a body without a cast, which is how four of them were
// being used all along, unchecked (§12).
interface ErrorFixture {
  unauthorized_401: object;
  page_size_over_tier_400: object;
  page_number_zero_400: object;
  page_number_over_cap_400: object;
  lookback_exceeded_400: object;
  past_end_page_200_empty: object;
  reference_languages: object;
  reference_regions: object;
  reference_categories: object;
}

let fixture: ErrorFixture;

beforeAll(() => {
  fixture = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "error-and-reference-bodies.json"), "utf8"),
  ) as ErrorFixture;
});

const asBody = (value: unknown): string => JSON.stringify(value);

describe("400 — a bug in our query construction", () => {
  const cases = [
    ["page_size_over_tier_400", "page_size", /Max page_size for Free tier is 20/],
    ["page_number_zero_400", "page_number", /Min value: 1/],
    ["page_number_over_cap_400", "page_number", /Max retrievable results/],
    ["lookback_exceeded_400", "date_range", /30 days/],
  ] as const;

  for (const [key, expectedField, expectedMessage] of cases) {
    it(`maps ${key} to NewsInvalidQueryError preserving details.errors`, () => {
      const error = mapErrorResponse({
        status: 400,
        bodyText: asBody(fixture[key]),
      });

      expect(error).toBeInstanceOf(NewsInvalidQueryError);
      expect(error.retryable).toBe(false);

      const fieldErrors = (error as NewsInvalidQueryError).fieldErrors;
      expect(Object.keys(fieldErrors)).toContain(expectedField);
      expect(fieldErrors[expectedField]).toMatch(expectedMessage);

      // The violated limit must survive into the message: that is what turns a
      // tier mistake into a one-line diagnosis instead of a hunt (ARCHITECTURE 5.3).
      expect(error.message).toMatch(expectedMessage);
      expect(error.message).toContain(expectedField);
    });
  }

  it("never reports a 400 as retryable — a retry spends quota to learn the same thing", () => {
    const error = mapErrorResponse({
      status: 400,
      bodyText: asBody(fixture.page_size_over_tier_400),
    });
    expect(error.retryable).toBe(false);
  });
});

describe("401 — an operator problem", () => {
  it("maps the recorded body to NewsAuthError", () => {
    const error = mapErrorResponse({
      status: 401,
      bodyText: asBody(fixture.unauthorized_401),
    });

    expect(error).toBeInstanceOf(NewsAuthError);
    expect(error).not.toBeInstanceOf(NewsBlockedError);
    expect(error.message).toContain("Invalid token");
    expect(error.retryable).toBe(false);
  });
});

describe("403 non-JSON — Cloudflare, NOT an auth failure", () => {
  // The probe lost its first 11 calls to this exact confusion: a Cloudflare block
  // returns 403 even for a request with no credentials at all, so reading it as an
  // auth failure sends you to the key instead of to the User-Agent.
  const cloudflareBody = [
    "<!DOCTYPE html><html><head><title>Access denied</title></head>",
    "<body>error code: 1010</body></html>",
  ].join("");

  it("maps to NewsBlockedError", () => {
    const error = mapErrorResponse({ status: 403, bodyText: cloudflareBody });

    expect(error).toBeInstanceOf(NewsBlockedError);
    expect(error).not.toBeInstanceOf(NewsAuthError);
    expect(error.retryable).toBe(false);
  });

  it("names the User-Agent in the message, since that is the actual fix", () => {
    const error = mapErrorResponse({ status: 403, bodyText: cloudflareBody });
    expect(error.message).toMatch(/user-agent/i);
    expect(error.message).toMatch(/NOT an authentication failure/);
  });

  it("treats an empty or plain-text 403 body as a block too", () => {
    expect(mapErrorResponse({ status: 403, bodyText: "" })).toBeInstanceOf(
      NewsBlockedError,
    );
    expect(mapErrorResponse({ status: 403, bodyText: "denied" })).toBeInstanceOf(
      NewsBlockedError,
    );
  });
});

describe("429 and 5xx — the retryable ones", () => {
  it("maps 429 to NewsQuotaError, carrying the reset time", () => {
    const error = mapErrorResponse({
      status: 429,
      bodyText: JSON.stringify({ status: "429", msg: "Too many requests" }),
      headers: new Headers({ "x-ratelimit-reset-time": "2026-08-05T00:00:00+00:00" }),
    });

    expect(error).toBeInstanceOf(NewsQuotaError);
    expect((error as NewsQuotaError).resetAt?.toISOString()).toBe(
      "2026-08-05T00:00:00.000Z",
    );
    expect(error.retryable).toBe(true);
  });

  it("maps 5xx to NewsUpstreamError, retryable", () => {
    const error = mapErrorResponse({ status: 503, bodyText: "gateway down" });
    expect(error).toBeInstanceOf(NewsUpstreamError);
    expect((error as NewsUpstreamError).status).toBe(503);
    expect(error.retryable).toBe(true);
  });

  it("treats an unexpected 4xx as our bug, never as retryable", () => {
    const error = mapErrorResponse({ status: 404, bodyText: "not found" });
    expect(error).toBeInstanceOf(NewsInvalidQueryError);
    expect(error.retryable).toBe(false);
  });
});

describe("past-end page — an end signal, not an error", () => {
  it('serves {"status":"ok","news":[]} as isLastPage with no error', async () => {
    const { fetch } = stubFetch([
      { body: fixture.past_end_page_200_empty, headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch });

    const result = await client.search({ keywords: ["climate"], pageNumber: 5 });

    expect(result.sightings).toHaveLength(0);
    expect(result.rawCount).toBe(0);
    expect(result.isLastPage).toBe(true);
  });

  it('rejects status: "error" under HTTP 200, which no status code would report', async () => {
    const { fetch } = stubFetch([{ body: { status: "error", news: [] } }]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["climate"] })).rejects.toBeInstanceOf(
      NewsSchemaError,
    );
  });
});

describe("reference bodies — name→code maps, values used verbatim", () => {
  it("parses languages as a map, typos and all", () => {
    const parsed = RawLanguages.parse(fixture.reference_languages);

    expect(parsed.languages["English"]).toBe("en");
    // "Vietnamise" is upstream's spelling and "msa" is three letters, not two.
    // Deriving a code from a name would produce "vi" and "ms" — both wrong.
    expect(parsed.languages["Vietnamise"]).toBeDefined();
    expect(parsed.languages["Malay"]).toBe("msa");
  });

  it("parses regions as a map, typos and all", () => {
    const parsed = RawRegions.parse(fixture.reference_regions);
    expect(parsed.regions["United State"]).toBe("US");
    expect(parsed.regions["German"]).toBeDefined();
  });

  it("parses categories as an array, including the junk values", () => {
    const parsed = RawCategories.parse(fixture.reference_categories);
    // Junk survives parsing on purpose: filtering belongs to the UI picker, not to
    // the wire layer, because a stored sighting may legitimately carry one.
    expect(parsed.categories).toContain("technology");
    expect(parsed.categories).toContain("crap");
  });

  it("returns reference maps through the client surface", async () => {
    const { fetch } = stubFetch([
      { body: fixture.reference_languages, headers: quotaHeaders() },
      { body: fixture.reference_regions, headers: quotaHeaders() },
      { body: fixture.reference_categories, headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch });

    expect((await client.availableLanguages())["English"]).toBe("en");
    expect((await client.availableRegions())["Taiwan"]).toBeDefined();
    expect(await client.availableCategories()).toContain("politics");
  });
});

describe("v2 latest-news 400 — the recorded invalid-category body (PROBE-FINDINGS 6c)", () => {
  it("maps to NewsInvalidQueryError with the taxonomy list preserved", () => {
    const recorded = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "latest-news-v2-sample.json"), "utf8"),
    ) as { error_bodies: { v2_invalid_category_400: unknown } };

    const error = mapErrorResponse({
      status: 400,
      bodyText: asBody(recorded.error_bodies.v2_invalid_category_400),
    });

    expect(error).toBeInstanceOf(NewsInvalidQueryError);
    expect(error.retryable).toBe(false);
    const fieldErrors = (error as NewsInvalidQueryError).fieldErrors;
    // The allowed-values list IS the taxonomy documentation — losing it turns
    // a one-line diagnosis into a hunt (ARCHITECTURE 5.3).
    expect(fieldErrors.category).toMatch(/science_technology/);
    expect(fieldErrors.category).toMatch(/Invalid category value\(s\): technology/);
  });
});
