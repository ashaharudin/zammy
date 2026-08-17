import { describe, expect, it } from "vitest";
import { NewsInvalidQueryError } from "@zammy/news-client";
import { FixtureGnewsClient } from "./fixture-client.js";
import { GnewsFixtureStore } from "./fixture-store.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * Fixture mode exists so the app is developable and the suite runnable with no
 * network and no quota — which matters more for GNews than for Currents, since
 * the Free tier's 100 calls a day would not survive one afternoon of hot reload.
 *
 * What is asserted is that it behaves like the live client where behaviour
 * matters: the same local refusals, the same paging, the same honest null quota.
 */

const limits = {
  maxPageSize: 10,
  maxRetrievableResults: 100,
  maxLookbackDays: 30,
  maxRangeDays: 30,
};

async function client(): Promise<FixtureGnewsClient> {
  const store = new GnewsFixtureStore(FIXTURES_DIR);
  await store.load();
  return new FixtureGnewsClient(store, limits, { dailyLimit: 100, burstLimit: 60 });
}

describe("the recorded payloads", () => {
  it("loads and normalizes cleanly", async () => {
    const result = await (await client()).search({ keywords: ["the"] });

    expect(result.sightings.length).toBeGreaterThan(0);
    expect(result.normalization.kept).toBe(result.normalization.received);
  });

  it("tags every sighting as gnews, with a derived uuid", async () => {
    const result = await (await client()).search({ keywords: ["the"] });

    for (const sighting of result.sightings) {
      expect(sighting.provider).toBe("gnews");
      expect(sighting.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("refuses to load from a directory with no fixture", async () => {
    await expect(new GnewsFixtureStore("/nonexistent").load()).rejects.toThrow(
      /gnews-search-sample\.json/,
    );
  });
});

describe("it refuses what the live client refuses", () => {
  it("rejects a category filter, so the sit-out path is exercised offline", async () => {
    await expect(
      (await client()).search({ keywords: ["x"], category: "business" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });

  it("rejects a keyword-less sweep", async () => {
    await expect((await client()).search({})).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });
});

describe("paging and quota", () => {
  it("reproduces the tier's page size", async () => {
    const result = await (await client()).search({ keywords: ["the"], pageSize: 50 });

    expect(result.pageSize).toBe(10);
    expect(result.sightings.length).toBeLessThanOrEqual(10);
  });

  it("advances through pages", async () => {
    const one = await (await client()).search({ keywords: ["the"], pageNumber: 1 });
    const two = await (await client()).search({ keywords: ["the"], pageNumber: 2 });

    if (two.sightings.length > 0) {
      expect(two.sightings[0]!.url).not.toBe(one.sightings[0]!.url);
    }
  });

  it("reports a null quota, because no call was made", async () => {
    const result = await (await client()).search({ keywords: ["the"] });
    expect(result.quota).toBeNull();
  });
});
