import { describe, expect, it } from "vitest";
import type { SurfacedStoryline, TimelineEntry } from "@zammy/shared";
import {
  sizeBucket,
  SIZE_STEPS,
  storylineQualifier,
  storylineQualifiers,
  visibleStorylines,
} from "./storylineLabels.js";

const entry = (
  storylineId: string,
  label: string | null,
  published = "2026-08-11T09:00:00.000Z",
): TimelineEntry =>
  ({
    storylineId,
    published,
    storyline: label === undefined ? null : { label, from: published, to: published },
  }) as unknown as TimelineEntry;

const surfaced = (id: string, label: string | null, size = 5): SurfacedStoryline => ({
  id,
  label,
  size,
  from: "2026-03-02T00:00:00.000Z",
  to: "2026-03-04T00:00:00.000Z",
});

describe("storylineQualifiers", () => {
  const at = (id: string, label: string | null, from: string) => ({ id, label, from });

  it("qualifies both sides of a collision and nothing else", () => {
    const qualifiers = storylineQualifiers([
      at("a", "Fort Hood Crash", "2026-03-02T00:00:00.000Z"),
      at("b", "Fort Hood Crash", "2026-08-02T00:00:00.000Z"),
      at("c", "Trump Iran War", "2026-08-02T00:00:00.000Z"),
    ]);
    expect(qualifiers.get("a")).toMatch(/Mar/);
    expect(qualifiers.get("b")).toMatch(/Aug/);
    // Unambiguous on screen: a date beside it would answer a question nobody
    // asked, and would stop the date meaning "careful, there are two".
    expect(qualifiers.has("c")).toBe(false);
  });

  it("escalates to the day when two namesakes share a month", () => {
    // Found in the browser against live data: the dev archive holds three
    // storylines labelled "Trump Administration" that all begin in August, and
    // month precision qualified them all as "Aug 2026" — a disambiguator that
    // disambiguated nothing.
    // Midday UTC, not midnight: the qualifier renders in the READER's zone, and
    // a midnight timestamp lands on the previous day west of Greenwich — which
    // would make this assertion about the test runner's timezone rather than
    // about the rule.
    const qualifiers = storylineQualifiers([
      at("a", "Trump Administration", "2026-08-02T12:00:00.000Z"),
      at("b", "Trump Administration", "2026-08-19T12:00:00.000Z"),
    ]);
    expect(qualifiers.get("a")).not.toBe(qualifiers.get("b"));
    expect(qualifiers.get("a")).toMatch(/\b2\b/);
    expect(qualifiers.get("b")).toMatch(/\b19\b/);
  });

  it("does not qualify a storyline against ITSELF across its day slots", () => {
    // A ten-day storyline is ten slots and one storyline; keying by id is what
    // keeps a date off every multi-day label on screen.
    const qualifiers = storylineQualifiers([
      at("a", "Hurricane Fausto", "2026-08-02T00:00:00.000Z"),
      at("a", "Hurricane Fausto", "2026-08-02T00:00:00.000Z"),
    ]);
    expect(qualifiers.size).toBe(0);
  });

  it("ignores unlabelled storylines, which cannot collide", () => {
    expect(
      storylineQualifiers([
        at("a", null, "2026-08-02T00:00:00.000Z"),
        at("b", null, "2026-08-02T00:00:00.000Z"),
      ]).size,
    ).toBe(0);
  });
});

describe("visibleStorylines", () => {
  it("counts the slots' storylines and the surfaced row together", () => {
    // The collision ADR-0011 cares about is "actually on screen together", and
    // the pills row is on screen: a slot labelled "Fort Hood Crash" beside a
    // PILL of the same name is exactly the case the qualifier exists for.
    const visible = visibleStorylines(
      [entry("a", "Fort Hood Crash")],
      [surfaced("b", "Fort Hood Crash")],
    );
    const qualifiers = storylineQualifiers(visible);
    expect(qualifiers.has("a")).toBe(true);
    expect(qualifiers.has("b")).toBe(true);
  });

  it("folds a storyline appearing as both a slot and a pill into one", () => {
    const visible = visibleStorylines(
      [entry("a", "Hurricane Fausto"), entry("a", "Hurricane Fausto")],
      [surfaced("a", "Hurricane Fausto")],
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id: "a", label: "Hurricane Fausto" });
  });
});

describe("storylineQualifier", () => {
  it("names the month the storyline began", () => {
    expect(storylineQualifier("2026-03-02T00:00:00.000Z")).toMatch(/Mar|March/);
    expect(storylineQualifier("2026-03-02T00:00:00.000Z")).toMatch(/2026/);
  });
});

describe("sizeBucket", () => {
  it("fills one square for a small storyline and all four past a hundred", () => {
    expect(sizeBucket(1)).toBe(1);
    expect(sizeBucket(10)).toBe(1);
    expect(sizeBucket(11)).toBe(2);
    expect(sizeBucket(50)).toBe(2);
    expect(sizeBucket(51)).toBe(3);
    expect(sizeBucket(100)).toBe(3);
    expect(sizeBucket(101)).toBe(SIZE_STEPS);
    expect(sizeBucket(9_999)).toBe(SIZE_STEPS);
  });

  it("never draws an empty glyph — a surfaced storyline has at least one article", () => {
    expect(sizeBucket(0)).toBeGreaterThan(0);
  });
});
