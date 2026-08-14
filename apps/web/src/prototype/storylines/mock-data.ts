/**
 * PROTOTYPE (S8) — throwaway mock data for /prototype/storylines. No network,
 * no DB, no production wiring.
 *
 * Shapes anticipate S6's wire contract rather than today's: a slot is a
 * STORYLINE-DAY carrying a storyline UUID, a nullable label and the storyline's
 * date span (ADR-0011), and a search additionally SURFACES the storylines whose
 * profile tokens cover the keywords. Everything here is invented content sized
 * to the cases the surfacing UX has to survive:
 *
 *   - "iran"      → three matched storylines, one of them wide (the strip's
 *                   best case, and the rail-slot's worst — three injections)
 *   - "fort hood" → two storylines sharing the label "Fort Hood Crash", one of
 *                   them dormant since March: the collision disambiguator
 *   - anything    → provisional storylines-of-one render as plain slots
 */

export interface MockArticle {
  id: string;
  title: string;
  url: string;
  sourceDomain: string;
  published: string;
  description: string | null;
}

export interface MockStoryline {
  /** Identity is the UUID; the label is presentation and non-unique. */
  id: string;
  label: string | null;
  /** Tokens carried by at least half the member groups. Search matches these. */
  profileTokens: string[];
  status: "active" | "dormant";
  span: { from: string; to: string };
  groupCount: number;
  articleCount: number;
  /** Days with coverage, newest first — the sparkline the strip variant draws. */
  activity: { day: string; articles: number }[];
}

/** One storyline-day: what the timeline pages over in v2. */
export interface MockSlot {
  storylineId: string;
  label: string | null;
  span: { from: string; to: string } | null;
  /** That day's earliest article — the hero. */
  article: MockArticle;
  published: string;
  updatedAt: string;
  /** Same story, other outlets. */
  related: MockArticle[];
  /** Same storyline, different pieces, that day. */
  moreCoverage: MockArticle[];
}

const iso = (day: string, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, monthOf(day), dayOf(day), hour, minute)).toISOString();

/** "aug-13" → month index / day-of-month, so the fixtures below read as dates. */
function monthOf(day: string) {
  return { mar: 2, jul: 6, aug: 7 }[day.slice(0, 3)] ?? 7;
}
function dayOf(day: string) {
  return Number(day.slice(4));
}

let nextId = 1;
function article(
  day: string,
  hour: number,
  title: string,
  sourceDomain: string,
  description: string | null = null,
): MockArticle {
  const id = String(nextId++);
  return {
    id,
    title,
    url: `https://${sourceDomain}/prototype/${id}`,
    sourceDomain,
    published: iso(day, hour),
    description,
  };
}

interface Fixture {
  id: string;
  label: string | null;
  profileTokens: string[];
  status: "active" | "dormant";
  days: { day: string; articles: MockArticle[] }[];
  /**
   * Coverage the mock does not enumerate. The rail only needs a few headlines
   * per day to be judged, but a storyline's SIZE is what the coverage glyph
   * encodes — and a corpus where everything holds nine articles would never
   * exercise more than its first bucket. Real spans in the dev archive run from
   * a handful to several hundred.
   */
  unlisted?: number;
}

const FIXTURES: Fixture[] = [
  {
    id: "8f2b1c40-11d3-4a7e-9c55-6a0f2b3d1e01",
    label: "Fort Hood Crash",
    profileTokens: ["fort", "hood", "crash", "blackhawk", "helicopter", "army"],
    status: "active",
    unlisted: 15,
    days: [
      {
        day: "aug-13",
        articles: [
          article(
            "aug-13",
            6,
            "Army names four soldiers killed in Fort Hood Blackhawk crash",
            "apnews.com",
            "The service released the names a day after notifying families, as investigators recovered the aircraft's flight data recorder.",
          ),
          article("aug-13", 7, "Fort Hood crash victims identified", "reuters.com"),
          article(
            "aug-13",
            11,
            "Blackhawk fleet grounded pending Fort Hood inspection order",
            "militarytimes.com",
            "The order covers 40 aircraft across two commands and is expected to last a week.",
          ),
        ],
      },
      {
        day: "aug-12",
        articles: [
          article(
            "aug-12",
            5,
            "Investigators recover flight data recorder from Fort Hood wreckage",
            "reuters.com",
          ),
          article("aug-12", 9, "What we know about the Fort Hood helicopter crash", "bbc.co.uk"),
          article("aug-12", 14, "Fort Hood crash: army opens safety review", "theguardian.com"),
        ],
      },
      {
        day: "aug-11",
        articles: [
          article(
            "aug-11",
            4,
            "Four dead after Blackhawk goes down during night exercise at Fort Hood",
            "apnews.com",
            "The helicopter went down shortly after 11pm during a routine training flight, the army said.",
          ),
          article("aug-11", 5, "Army helicopter crashes at Fort Hood, four killed", "cnn.com"),
          article("aug-11", 6, "Blackhawk crash kills four at Texas base", "aljazeera.com"),
        ],
      },
    ],
  },
  {
    // Same label, different event, dormant: the collision the disambiguator is for.
    id: "c1a77e92-4b30-42f9-8d61-90aa5c7b2f02",
    label: "Fort Hood Crash",
    profileTokens: ["fort", "hood", "crash", "convoy", "army"],
    status: "dormant",
    days: [
      {
        day: "mar-14",
        articles: [
          article(
            "mar-14",
            8,
            "Two soldiers killed in Fort Hood convoy crash on Highway 190",
            "militarytimes.com",
          ),
          article("mar-14", 10, "Fort Hood convoy crash under investigation", "reuters.com"),
        ],
      },
    ],
  },
  {
    id: "2d4e6f80-9a1b-4c3d-8e5f-70b1c2d3e403",
    label: "Trump Iran War",
    profileTokens: ["trump", "iran", "strikes", "tehran", "war", "pentagon"],
    status: "active",
    unlisted: 131,
    days: [
      {
        day: "aug-13",
        articles: [
          article(
            "aug-13",
            5,
            "Trump orders second round of strikes on Iranian air defences",
            "reuters.com",
            "The president said the strikes were a response to attacks on shipping in the Gulf.",
          ),
          article("aug-13", 6, "US strikes Iran air defence sites, Pentagon says", "apnews.com"),
          article("aug-13", 8, "Tehran vows response as US strikes resume", "aljazeera.com"),
          article(
            "aug-13",
            13,
            "Analysis: how far Trump is willing to take the Iran campaign",
            "ft.com",
            "Two weeks in, the campaign has no stated endpoint and no congressional authorisation.",
          ),
        ],
      },
      {
        day: "aug-12",
        articles: [
          article("aug-12", 7, "Iran recalls envoys as Trump weighs further strikes", "bbc.co.uk"),
          article("aug-12", 16, "Oil holds gains on Iran war risk", "ft.com"),
        ],
      },
      {
        day: "aug-09",
        articles: [
          article(
            "aug-09",
            3,
            "Trump authorises strikes on Iranian missile sites",
            "apnews.com",
            "The first strikes of the campaign hit three sites in western Iran overnight.",
          ),
          article("aug-09", 4, "US launches strikes against Iran", "reuters.com"),
          article("aug-09", 12, "Congress split as Iran strikes begin", "politico.eu"),
        ],
      },
    ],
  },
  {
    id: "5b8c0d21-6e7f-4a90-b1c2-d3e4f5a6b704",
    label: "Hormuz Tanker Seizure",
    profileTokens: ["hormuz", "tanker", "seizure", "iran", "strait", "shipping"],
    status: "active",
    unlisted: 58,
    days: [
      {
        day: "aug-13",
        articles: [
          article(
            "aug-13",
            9,
            "Iran seizes second tanker in Strait of Hormuz",
            "reuters.com",
            "The Greek-operated vessel was boarded by armed personnel in international waters, the operator said.",
          ),
          article("aug-13", 10, "Shipping rates spike after Hormuz seizure", "ft.com"),
        ],
      },
      {
        day: "aug-12",
        articles: [
          article("aug-12", 6, "Tanker seized near Strait of Hormuz, operator says", "apnews.com"),
          article("aug-12", 8, "Insurers pull cover for Gulf transits", "lloydslist.com"),
          article("aug-12", 15, "Hormuz: the chokepoint explained", "bbc.co.uk"),
        ],
      },
    ],
  },
  {
    id: "9e0f1a32-7b8c-4d5e-9f01-2a3b4c5d6e05",
    label: "Iran Sanctions Vote",
    profileTokens: ["iran", "sanctions", "vote", "senate", "bill"],
    status: "active",
    unlisted: 4,
    days: [
      {
        day: "aug-12",
        articles: [
          article(
            "aug-12",
            13,
            "Senate advances Iran sanctions bill in 61-38 vote",
            "politico.eu",
            "Nine Democrats joined Republicans to move the package past a procedural hurdle.",
          ),
          article("aug-12", 14, "Iran sanctions package clears Senate hurdle", "reuters.com"),
        ],
      },
      {
        day: "aug-09",
        articles: [
          article("aug-09", 15, "Sanctions bill on Iran gains sponsors after strikes", "thehill.com"),
          article("aug-09", 17, "What the Iran sanctions bill would do", "npr.org"),
        ],
      },
    ],
  },
];

/**
 * Provisional storylines-of-one: ordinary article slots, no label, no display
 * treatment. They are here because a surfacing treatment has to be judged
 * against the timeline it interrupts, not against a rail of storylines.
 */
const SINGLETONS: { day: string; article: MockArticle }[] = [
  { day: "aug-13", article: article("aug-13", 12, "Texas heat advisory extended through weekend", "khou.com") },
  {
    day: "aug-13",
    article: article("aug-13", 4, "Gulf shipping insurers meet on war-risk premiums", "lloydslist.com"),
  },
  { day: "aug-12", article: article("aug-12", 11, "Army recruiting numbers rise for third quarter", "militarytimes.com") },
  { day: "aug-11", article: article("aug-11", 15, "Iran's currency slides to record low", "aljazeera.com") },
  { day: "aug-11", article: article("aug-11", 9, "Senate returns from recess to a crowded calendar", "politico.eu") },
  { day: "aug-09", article: article("aug-09", 8, "Fuel prices climb ahead of holiday travel", "npr.org") },
];

/**
 * Coverage size as one glyph. Four buckets, because the question a reader asks
 * of a surfaced storyline is "how big is this?", not "how many exactly?" — and
 * a bucket survives the count still moving while they look at it.
 */
export const COVERAGE_BUCKETS = [
  // ▂ rather than ▁ for the first bucket: at 0.8rem the one-eighth block
  // renders as an underscore and reads as a typo, not as a quantity.
  { max: 10, glyph: "▂", label: "1–10 articles" },
  { max: 50, glyph: "▄", label: "11–50 articles" },
  { max: 100, glyph: "▆", label: "51–100 articles" },
  { max: Infinity, glyph: "█", label: "101+ articles" },
] as const;

export function coverageBucket(articleCount: number) {
  return COVERAGE_BUCKETS.find((bucket) => articleCount <= bucket.max)!;
}

export const STORYLINES: MockStoryline[] = FIXTURES.map((fixture) => {
  const all = fixture.days.flatMap((day) => day.articles);
  const times = all.map((a) => a.published).sort();
  return {
    id: fixture.id,
    label: fixture.label,
    profileTokens: fixture.profileTokens,
    status: fixture.status,
    span: { from: times[0]!, to: times.at(-1)! },
    groupCount: fixture.days.reduce((n, day) => n + Math.max(1, day.articles.length - 1), 0),
    articleCount: all.length + (fixture.unlisted ?? 0),
    activity: fixture.days.map((day) => ({
      day: day.day,
      articles: day.articles.length,
    })),
  };
});

const SLOTS: MockSlot[] = [
  ...FIXTURES.flatMap((fixture) => {
    const storyline = STORYLINES.find((s) => s.id === fixture.id)!;
    return fixture.days.map((day): MockSlot => {
      const sorted = [...day.articles].sort((a, b) => a.published.localeCompare(b.published));
      const [hero, ...rest] = sorted;
      // Rough but honest split: same-outlet-day copies read as "same story",
      // the later pieces as "more coverage".
      return {
        storylineId: fixture.id,
        label: fixture.label,
        span: storyline.span,
        article: hero!,
        published: hero!.published,
        updatedAt: sorted.at(-1)!.published,
        related: rest.slice(0, 1),
        moreCoverage: rest.slice(1),
      };
    });
  }),
  ...SINGLETONS.map(
    ({ article: a }): MockSlot => ({
      storylineId: `provisional-${a.id}`,
      label: null,
      span: null,
      article: a,
      published: a.published,
      updatedAt: a.published,
      related: [],
      moreCoverage: [],
    }),
  ),
].sort((a, b) => b.published.localeCompare(a.published));

function tokens(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Search results: slots whose visible text carries every keyword. The timeline
 * is never limited to a storyline — surfacing is the separate axis below.
 */
export function searchSlots(query: string): MockSlot[] {
  const keywords = tokens(query);
  if (keywords.length === 0) return SLOTS;
  return SLOTS.filter((slot) => {
    const text = [slot.article, ...slot.related, ...slot.moreCoverage]
      .map((a) => a.title)
      .join(" ")
      .toLowerCase();
    return keywords.every((keyword) => text.includes(keyword));
  });
}

/** Storylines a search SURFACES: keywords ⊆ profile tokens (ADR-0011). */
export function surfacedStorylines(query: string): MockStoryline[] {
  const keywords = tokens(query);
  if (keywords.length === 0) return [];
  return STORYLINES.filter((storyline) =>
    keywords.every((keyword) =>
      storyline.profileTokens.some((token) => token.startsWith(keyword)),
    ),
  ).sort((a, b) => b.span.to.localeCompare(a.span.to));
}

/** The storyline view: every slot of one storyline, newest first. */
export function storylineSlots(storylineId: string): MockSlot[] {
  return SLOTS.filter((slot) => slot.storylineId === storylineId);
}

export function storylineById(storylineId: string): MockStoryline | undefined {
  return STORYLINES.find((storyline) => storyline.id === storylineId);
}

/** Typeahead: partial keywords, so it fires while the reader is still typing. */
export function suggestStorylines(partial: string): MockStoryline[] {
  const keywords = tokens(partial);
  if (keywords.length === 0) return [];
  const last = keywords.at(-1)!;
  const settled = keywords.slice(0, -1);
  return STORYLINES.filter((storyline) => {
    const haystack = [...storyline.profileTokens, ...tokens(storyline.label ?? "")];
    return (
      settled.every((keyword) => haystack.some((token) => token.startsWith(keyword))) &&
      haystack.some((token) => token.startsWith(last))
    );
  }).sort((a, b) => b.span.to.localeCompare(a.span.to));
}

/** "Aug 11 – Aug 13", or "Mar 14" for a single-day storyline. */
export function spanLabel(span: { from: string; to: string }): string {
  const fmt = (v: string) =>
    new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const from = fmt(span.from);
  const to = fmt(span.to);
  return from === to ? from : `${from} – ${to}`;
}

/** The quiet disambiguator: "Fort Hood Crash · Mar 2026". */
export function spanQualifier(span: { from: string; to: string }): string {
  return new Date(span.to).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const PROTOTYPE_QUERIES = ["iran", "fort hood", "army", "sanctions", "tanker"];
