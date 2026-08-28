import { describe, expect, it } from "vitest";
import type { FetchLike } from "@zammy/news-client";
import { createGoogleNewsClient, googleNewsClientLimits } from "./factory.js";
import { FixtureGoogleNewsClient } from "./fixture-client.js";
import { HttpGoogleNewsClient } from "./http.js";
import { ITEMS_PER_QUERY } from "./raw.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * The flag, and what "off" has to mean.
 *
 * Off must mean UNREACHABLE, not merely unwired. Nothing above this package
 * calls the factory yet — G5 is what wires it — so an "unwired" guard would be
 * satisfied by doing nothing at all, and would stop being satisfied the moment
 * someone added the import. The guard being inside the factory is what makes
 * the flag survive that.
 */

function config(overrides: Record<string, unknown> = {}) {
  return {
    GOOGLE_NEWS_ENABLED: false,
    GOOGLE_NEWS_MODE: "fixture" as const,
    GOOGLE_NEWS_BASE_URL: "https://news.google.com/rss",
    GOOGLE_NEWS_USER_AGENT: "zammy-test/0.0",
    GOOGLE_NEWS_LANGUAGE: "en",
    GOOGLE_NEWS_COUNTRY: "CA",
    GOOGLE_NEWS_MAX_LOOKBACK_DAYS: 730,
    GOOGLE_NEWS_DAILY_CALL_LIMIT: 200,
    GOOGLE_NEWS_BURST_CALL_LIMIT: 5,
    GOOGLE_NEWS_BURST_WINDOW_MS: 60_000,
    GOOGLE_NEWS_INTERACTIVE_RESERVE: 50,
    FIXTURES_DIR,
    ...overrides,
  };
}

describe("with the flag off", () => {
  it("refuses to build a client at all", async () => {
    await expect(createGoogleNewsClient(config())).rejects.toThrow(/GOOGLE_NEWS_ENABLED/);
  });

  it("refuses in live mode too, before anything could reach the network", async () => {
    // The guard is ahead of the mode branch on purpose: an operator who set
    // GOOGLE_NEWS_MODE=live and forgot the flag must get nothing, not a client.
    await expect(
      createGoogleNewsClient(config({ GOOGLE_NEWS_MODE: "live" })),
    ).rejects.toThrow(/GOOGLE_NEWS_ENABLED/);
  });

  it("makes no upstream call on the way to refusing", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return new Response("", { status: 200 });
    };

    await expect(
      createGoogleNewsClient(config({ GOOGLE_NEWS_MODE: "live" }), { fetch }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("says why, and names the phases that have to land first", async () => {
    // The message is the documentation an operator will actually read.
    await expect(createGoogleNewsClient(config())).rejects.toThrow(
      /DISCOVERY-DEEPENING-PLAN/,
    );
  });
});

describe("with the flag on", () => {
  it("builds the fixture client in fixture mode", async () => {
    const client = await createGoogleNewsClient(config({ GOOGLE_NEWS_ENABLED: true }));

    expect(client).toBeInstanceOf(FixtureGoogleNewsClient);
    expect(client.provider).toBe("google-news");
  });

  it("builds the live client in live mode, without touching the network", async () => {
    const client = await createGoogleNewsClient(
      config({ GOOGLE_NEWS_ENABLED: true, GOOGLE_NEWS_MODE: "live" }),
    );

    expect(client).toBeInstanceOf(HttpGoogleNewsClient);
  });

  it("refuses live mode with no User-Agent, since there is no key either", async () => {
    await expect(
      createGoogleNewsClient(
        config({
          GOOGLE_NEWS_ENABLED: true,
          GOOGLE_NEWS_MODE: "live",
          GOOGLE_NEWS_USER_AGENT: "",
        }),
      ),
    ).rejects.toThrow(/GOOGLE_NEWS_USER_AGENT/);
  });
});

describe("limits", () => {
  it("fixes both page caps at the endpoint's wall, not at anything configurable", async () => {
    // Neither is a tier that could be bought up: the endpoint returns at most
    // 100 items and offers no offset.
    const limits = googleNewsClientLimits(config());

    expect(limits.maxPageSize).toBe(ITEMS_PER_QUERY);
    expect(limits.maxRetrievableResults).toBe(ITEMS_PER_QUERY);
  });

  it("leaves exactly one retrievable page, so the shared clamp refuses a second", () => {
    const limits = googleNewsClientLimits(config());

    expect(Math.floor(limits.maxRetrievableResults / limits.maxPageSize)).toBe(1);
  });

  it("sets no per-call range ceiling below the lookback", () => {
    // No range limit was found and none is documented. The real constraint on a
    // wide window is the 100-item cap, which surfaces as `isLastPage: false`
    // rather than as a refusal — the honest signal, since the window WAS
    // answerable, just not answered completely.
    const limits = googleNewsClientLimits(config());

    expect(limits.maxRangeDays).toBe(limits.maxLookbackDays);
  });
});
