import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FixtureStore } from "./fixture-store.js";
import { parsePublished } from "./normalize.js";
import { toCurrentsDate, toQueryParams } from "./raw.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

describe("parsePublished", () => {
  it("parses the upstream's non-ISO format", () => {
    // "2026-08-04 20:45:56 +0000" — not ISO-8601, and new Date() is unreliable on it.
    expect(parsePublished("2026-08-04 20:45:56 +0000")).toBe(
      Date.UTC(2026, 7, 4, 20, 45, 56),
    );
  });

  it("applies the timezone offset", () => {
    expect(parsePublished("2026-08-04 20:45:56 +0200")).toBe(
      Date.UTC(2026, 7, 4, 18, 45, 56),
    );
  });

  it("returns NaN rather than guessing on garbage", () => {
    // A wrong timestamp silently corrupts the timeline, which is the one thing
    // the product promises. Better to drop the sighting and count it.
    expect(Number.isNaN(parsePublished("not a date"))).toBe(true);
    expect(Number.isNaN(parsePublished(""))).toBe(true);
  });
});

describe("toQueryParams", () => {
  it("space-joins keywords — comma-joining returns zero results upstream", () => {
    const query = toQueryParams(
      { keywords: ["bitcoin", "volcano"] },
      { maxPageSize: 20 },
    );
    expect(query.get("keywords")).toBe("bitcoin volcano");
  });

  it("clamps page size to the tier maximum", () => {
    const query = toQueryParams({ pageSize: 100 }, { maxPageSize: 20 });
    expect(query.get("page_size")).toBe("20");
  });

  it("never emits page_number below 1", () => {
    const query = toQueryParams({ pageNumber: 0 }, { maxPageSize: 20 });
    expect(query.get("page_number")).toBe("1");
  });

  it("formats dates the way upstream wants them", () => {
    expect(toCurrentsDate(new Date(Date.UTC(2026, 7, 2)))).toBe(
      "2026-08-02T00:00:00+00:00",
    );
  });
});

describe("FixtureStore", () => {
  const store = new FixtureStore(FIXTURES);

  beforeAll(async () => {
    await store.load();
  });

  it("loads the recorded payloads", () => {
    expect(store.size).toBeGreaterThan(100);
  });

  it("returns newest-first, matching upstream's default ordering", () => {
    const results = store.search({}, { maxPageSize: 20 });
    const times = results.map((a) => parsePublished(a.published));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("respects the tier page size", () => {
    expect(store.search({}, { maxPageSize: 20 })).toHaveLength(20);
    expect(store.search({ pageSize: 5 }, { maxPageSize: 20 })).toHaveLength(5);
  });

  it("pages disjointly, as upstream does", () => {
    const page1 = store.search({ pageNumber: 1 }, { maxPageSize: 20 });
    const page2 = store.search({ pageNumber: 2 }, { maxPageSize: 20 });
    const firstPageIds = new Set(page1.map((a) => a.id));
    const overlap = page2.filter((a) => firstPageIds.has(a.id));
    expect(overlap).toHaveLength(0);
  });

  it("preserves the duplication the real API exhibits", () => {
    // This is the point of using recorded payloads: fixture mode must reproduce
    // the upstream's actual misbehaviour, or the collapse gets built against data
    // that never needed it. Synthetic fixtures would hide exactly this.
    const all = store.search({ pageSize: 20, pageNumber: 1 }, { maxPageSize: 1000 });
    expect(all.length).toBeGreaterThan(0);

    const everything = store.search({}, { maxPageSize: 10_000 });
    const uniqueIds = new Set(everything.map((a) => a.id));
    const uniqueUrls = new Set(everything.map((a) => a.url));
    expect(uniqueUrls.size).toBeLessThan(uniqueIds.size);
  });

  it("preserves the literal \"None\" image value", () => {
    const everything = store.search({}, { maxPageSize: 10_000 });
    expect(everything.some((a) => a.image === "None")).toBe(true);
  });
});
