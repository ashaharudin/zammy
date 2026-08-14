# Storylines v2 — implementation plan, by session

The design is settled and recorded in [ADR-0011](adr/0011-a-storyline-is-a-persistent-arc-of-one-event.md);
the glossary ([CONTEXT.md](../CONTEXT.md)) already speaks the new language. This
plan splits the build into sessions, each sized for one focused working session
and self-contained: every session brief lists the context to load, the scope,
and what "done" means. Do not widen a session's scope mid-flight — later
sessions exist for a reason.

**Standing context for every session**: read ADR-0011 in full, plus CONTEXT.md's
Group / Storyline / Storyline label entries. ADR-0009 and ADR-0010 are
superseded but their measured failures are still the specification's guardrails
(the 1,179-group swallow, the live-blog vocabulary problem, the absolute-df
failure). The repo rules that bind every session: no threshold ships
unmeasured (`pnpm measure:storylines`), hand-written SQL migrations (ADR-0003),
wire changes bump `PAGE_SHAPE_VERSION`, tokenizer changes bump
`TOKENIZER_VERSION`.

## Dependency graph

```
S1 schema ──┬── S3 linker ──────┬── S5 backfill ── S6 read path ── S7 frontend ── S9 cutover
            │      │            │                                       │
S2 rarity ──┘      │            │                                       │
            └── S4 labeler ─────┘                S8 UX prototypes ───────┘
```

S8 is independent (mock data) and can run any time; its verdict must land
before S7 finalizes the search-surfacing UI.

---

## S1 — Schema and storage primitives

**Depends on**: nothing. Purely additive; the old read/write paths keep working.

**Scope**: migration `0007` creating the three tables from ADR-0011's Schema
section — `storylines` (UUID pk, label, profile tokens, status
provisional/active/dormant, merged-into alias pointer), `storyline_groups`
(group ↔ storyline join), `storyline_days` (one row per storyline-day:
`(day_slot_published, storyline_id)` keyset index, day key, that day's earliest
article). Kysely types in `packages/storage/src/database.ts`. Storage
functions, pure CRUD with no decision logic: create provisional storyline for
a group, attach group (upserting the affected `storyline_days` rows and
re-deriving profile tokens), promote, merge-with-alias (re-point joins, rewrite
day slots, set alias), resolve alias chain, mark dormant/active.

**Explicitly out**: any linking decision, any change to `articles` columns or
triggers (they die in S9, not before), any read-path change.

**Done when**: migration applies and reverts cleanly; storage functions have
tests covering merge re-pointing, alias resolution, and day-slot maintenance
across attach/merge; `pnpm -r build` and existing tests stay green.

## S2 — Trailing-corpus rarity

**Depends on**: nothing (parallel with S1).

**Context**: `0005-rolling-terms.ts` migration, `term_baseline` /
`trending_terms` infrastructure, `apps/api/src/storyline.ts` (day-df usage
being replaced).

**Scope**: document-frequency over a rolling ~14-day window of article
`story_tokens` — the "rare relative to what" answer for cross-day linking.
Decide (and record in the session) whether this converges with `term_baseline`
or stands alone; ADR-0011 leaves that open deliberately. Provide: a cheap df
lookup for a set of tokens, a corpus-size figure, and maintenance on ingest.
Window length is a config knob (`STORYLINE_DF_WINDOW_DAYS`, default 14).

**Done when**: df lookups return stable numbers over the dev archive, the
maintenance cost on the ingest path is measured and stated, and a
threshold-sweep harness can query it read-only.

## S3 — The linker

**Depends on**: S1, S2.

**Context**: `apps/api/src/storyline.ts` and `storyline-service.ts` (the
structures being generalized), ADR-0009's "Measured failures" table.

**Scope**: the group→storyline decision, per ADR-0011's Linking section.
Pure functions first: storyline profile (tokens ≥ half of member groups),
anchor (shared token rare against the trailing corpus, ceiling as a share,
floored) + mass (Σ ln(N/df) ≥ threshold), dormancy gate (normal thresholds for
storylines active ≤ ~90 days, high-confidence bar beyond). Service wiring:
every newly seeded group births a provisional storyline; candidate retrieval
via GIN overlap against profile tokens; attach to best qualifier; a group
qualifying for two storylines records a bridge; K independent bridges (start
K=2) trigger merge-with-alias. Retroactive attachment rides the same path —
an old group is just a candidate arriving late.

Extend `measure:storylines` (or a v2 sibling) to replay group→storyline
decisions over the live corpus read-only, sweeping anchor share, mass, K, and
the dormancy window, and reporting **largest-storyline share** as the
percolation alarm.

**Done when**: the sweep runs over the dev archive and the chosen starting
thresholds are pinned *from its output*, with the sweep table recorded in the
session's commit message or a docs note — no number ships unmeasured.

## S4 — The labeler

**Depends on**: S1. Parallel with S3.

**Scope**: Gemini flash-tier client behind `GEMINI_API_KEY` in
`packages/config` (server-only, per ADR-0004's boundary). Label generation
fires at promotion, on merge, and on drift (membership doubled since last
label). Input: up to ~10 representative member headlines + descriptions,
recent-weighted. Prompt contract (the fixed part): 2–3 words, must contain a
proper noun, names the event or situation not just the entity, no punctuation.
Validate the response against the contract; on violation, failure, or
unavailability fall back to the existing bigram extractor
(`storyline-phrase.ts` logic, freed from the every-article containment rule),
else leave the storyline label-less. Store label + generated-at on the
storyline row. Tests run against recorded responses, never the live API.

**Done when**: promotion/merge/drift each produce or refresh a label on the
dev archive; the fallback path is exercised in tests; cost per thousand labels
is estimated and noted.

## S5 — Full-history backfill

**Depends on**: S3, S4.

**Context**: `apps/api/src/regroup.ts` (the CLI pattern to follow).

**Scope**: a resumable CLI replaying the linker **chronologically** over the
entire article corpus — replay order is the canonical order — building
storylines, joins, and day slots from scratch. Existing `storyline_id` data is
ignored entirely. Then one labeling pass over promoted storylines (batched,
resumable, rate-limited). Emit a report: storyline count, promoted share,
largest storyline, label coverage, runtime.

**Done when**: the backfill runs end-to-end on the dev archive, is
interruptible and resumable without corruption, and its report numbers are
sane against S3's sweep (largest-storyline share in particular).

## S6 — Read path and wire contract

**Depends on**: S1; meaningful testing needs S5's backfilled dev data.

**Context**: `apps/api/src/timeline-service.ts`, `packages/storage/src/timeline.ts`,
`packages/shared/src/timeline.ts`, `page-cache.ts`, ADR-0002.

**Scope**: behind a `STORYLINES_V2` flag, the timeline paginates over
`storyline_days` — keyset `(day_slot_published, storyline_id)`, hero = the
day's earliest article, that day's remaining articles as the pane, same-story
vs more-coverage sectioning derived from group membership within the slot.
Provisional storylines-of-one render as plain slots. Wire shape: slot carries
storyline UUID, label (nullable), and the storyline's date span (for the
collision disambiguator); `PAGE_SHAPE_VERSION` bump. The **storyline view**:
a UUID query param filtering the timeline to one storyline (alias-resolving),
label echoed back; it replaces `?storyline=<bigint>` seeding —
`attachStorylineToTopic` and the seed param retire with the flag flip.
Storyline surfacing data for search results (keywords ⊆ profile tokens) ships
here so S7/S8 have something to render.

**Done when**: both flag states serve correct pages against the dev archive;
cursor totality and `hasMore` hold under the new keyset (including a group in
two storylines fanning out to two slots); cached old-shape pages cannot reach
new clients.

## S7 — Frontend

**Depends on**: S6; the surfacing treatment depends on S8's verdict.

**Context**: `apps/web/src/TimelinePage.tsx`, `route.ts`, `CommandBar.tsx`,
`format.ts` (`groupByDay`), ADR-0010's layout rationale (the surviving half).

**Scope**: render storyline-day slots (day dividers unchanged — every slot now
lives inside one day by construction); universal gutter labels on every
labeled storyline's slots; click → storyline view (URL carries the UUID as a
sibling of `q`, label as a dismissible chip, empty search box; typing exits
the view). Date-span disambiguator only when two same-label storylines are on
screen together. Duplicated slots (one group, two storylines) render as
ordinary slots, no special casing. Fold in the winning surfacing variant
from S8.

**Done when**: the timeline, storyline view, label collisions, and multi-
storyline duplication all verified in the browser preview against backfilled
dev data.

## S8 — UX prototypes (throwaway)

**Depends on**: nothing hard — mock data suffices; S6's wire shape makes it
realer. Run early.

**Scope**: three variants for how search surfaces storylines, each layered on
universal gutter labels as the baseline: (a) top strip of matched-storyline
cards above results; (b) storyline-as-rail-slot — a matched storyline appears
in the timeline rail as a first-class, visually distinct slot at its latest
activity; (c) command-bar typeahead suggesting storylines while typing.
Throwaway code, no production wiring. Output: a short written verdict — which
variant (or combination) S7 builds, and why.

**Done when**: all three are clickable and the verdict is recorded.

## S9 — Cutover and cleanup

**Depends on**: everything above; the production backfill has run and been
eyeballed.

**Scope**: flip `STORYLINES_V2` on by default. Migration `0008` dropping
`articles.storyline_id`, `articles.storyline_published`, the
`articles_seed_own_storyline_trg` trigger, and their indexes (`story_tokens`
and its GIN index stay — the linker's input). Delete the dead code: the
day-bounded storyline service path, `storyline-phrase.ts` read-time selection,
`attachStorylineToTopic` and the `?storyline=<bigint>` seed handling, the old
measure path. Update `docs/ARCHITECTURE.md` (§7 schema/reads/writes, §8 front
end, §14.3's open question gets its answer). Final `PAGE_SHAPE_VERSION` audit.

**Done when**: `STORYLINE_ENABLED`-era escape hatches are gone or repurposed,
no code references the dropped columns, docs describe only the new model, and
the full test suite is green.
