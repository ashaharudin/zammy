# Storylines v2 — review fixes, by work package

A code review of the v2 implementation (PRs #34–#41, sprints S1–S7) against
[STORYLINES-V2-PLAN.md](STORYLINES-V2-PLAN.md) found four spec gaps and three
implemented-but-wrong behaviors. Two standards findings were fixed on the spot
(PR #42); this plan covers the six that remain, grouped into five work packages
ordered by dependency — dormancy status (WP2) must land before dormant pills
(WP3); everything else is independent. Package sizes follow the plan's
one-session convention.

The repo rules that bound the original sessions still bind these: wire changes
bump `PAGE_SHAPE_VERSION` **with a ledger entry** (the exact drift the review
caught once already), linking-behavior changes ship with `measure:storylines`
output recorded, tests never touch the live Gemini API.

## Dependency graph

```
WP1 read-path fixes ──────────────────────────┐
WP2 dormancy real ── WP3 dormant pills ───────┼── done
WP4 live labels ──────────────────────────────┤
WP5 retroactive attachment (measured, last) ──┘
```

## WP1 — Read-path correctness (impl 1 + impl 3)

Small, independent, no wire change.

**Cursor generation guard.** A cursor minted by one model must not reach the
other's SQL: a v1 bigint cursor hits `::uuid` in
`packages/storage/src/storyline-timeline.ts` (a Postgres cast error — a 500),
and the reverse — a v2 UUID cursor after the flag flips off — hits `::bigint`
in `packages/storage/src/timeline.ts`. Both directions are broken; S6's done
clause ("cursor totality and `hasMore` hold under the new keyset") promised
otherwise.

Fix in `apps/api/src/timeline-service.ts`, the layer that knows the flag: after
`decodeCursor` in both `readTimeline` and `readStorylineView`, reject a cursor
whose id half does not match the serving model (UUID required under v2 and the
storyline view, digits under v1) by throwing `InvalidCursorError` — the route
already maps that to a 400. A small helper (`cursorGeneration(cursor): "v1" |
"v2"`) beside `SLOT_ID` in `packages/shared/src/cursor.ts` keeps the two
regexes in one place.

**Whole-life size in the storyline view.** `readStorylineView` sums
`members.length` over the current page, undercounting the moment a storyline
outgrows one page — but the wire contract says size is "articles in the
storyline, over its whole life". Add `readStorylineArticleCount(db,
storylineId)` to `packages/storage/src/storylines.ts`, reusing the exact count
subquery `findSurfacedStorylines` already runs, and call it from the view.
Value change only — no shape change, no version bump.

**Done when**: a flag flip in either direction turns an in-flight cursor into a
400, never a 500; a storyline longer than `limit` days reports the same size on
page one and page two.

## WP2 — Dormancy becomes real (impl 2)

`setStorylineStatus` exists but nothing writes `"dormant"`: `storylines.status`
is permanently `"active"`, misleading any consumer and blocking WP3. The linker
computes dormancy dynamically from `lastCoverage` — correct for linking
decisions, and untouched here. The column becomes the READ-side representation,
kept honest three ways:

- **A nightly dormancy sweep** on the existing `ChoreQueue` (beside the
  retention chore): mark `dormant` where `status = 'active'` and the
  storyline's latest `day_slot_published` is older than
  `STORYLINE_DORMANCY_DAYS` — the same knob the linker's gate reads, so the
  column and the gate agree. Aliases and provisionals are skipped, as
  `setStorylineStatus` already does.
- **Reactivation on the write path**, not the chore: ADR-0011 says "active
  again when it earns coverage", and a dormant storyline that takes a group
  mid-day must not stay marked until midnight. `attachGroup` and
  `mergeStorylines` set `active` when they add coverage to a dormant row.
- **The backfill stamps status** at the end of its run, so a fresh replay does
  not leave five-month-old storylines marked active until the first chore
  fires.

**Done when**: the chore run over the backfilled dev archive marks the March
storylines dormant, and attaching a new group to one flips it back.

## WP3 — Dormancy on surfaced storylines (spec 3)

**Depends on**: WP2 — there is nothing true to show until the row is honest.

S8's verdict requires it ("dormant marked" on the pill; it "explained the March
match instantly — without it the reader wonders why a five-month-old story is
being offered"), and S7's brief folded it in but never built it.

- **Storage**: `findSurfacedStorylines` selects `s.status` — it already reads
  the `storylines` row.
- **Wire**: `SurfacedStoryline` gains `dormant: boolean` — the one bit the pill
  needs; slots already carry full status internally. A shape change:
  `PAGE_SHAPE_VERSION` → 7, with its ledger entry.
- **Web**: `StorylinePills.tsx` renders the dormant marker (muted pill,
  "dormant" in the `title` alongside the exact count);
  `storylineLabels.ts` threads the field.

**Done when**: browser-verified against backfilled dev data on S8's own
collision case — two "Fort Hood Crash" storylines, one active, one dormant
since March — with the dormant one visibly marked in the pill row.

## WP4 — Live label wiring (spec 1)

S4 asked for "label generation fires at promotion, on merge, and on drift";
nothing on the live path calls the labeler, so with `STORYLINES_V2` on, new
storylines stay label-less until an operator runs `pnpm label:storylines`. The
service half is built and explicitly waiting to be wired
(`storyline-label-service.ts`'s header says so); config already carries every
knob.

- **Construct the generator once in `server.ts`** via `createGeminiClient`
  when `GEMINI_API_KEY` is set — null otherwise, and the bigram fallback
  becomes the only path, which already renders — and thread `LabelerDeps`
  into the grouping deps.
- **Promotion and merge triggers**: after `linkSeededGroups` in
  `grouping-service.ts`, walk the `LinkOutcome`s — `attached: true` fires
  `trigger: "promotion"` for its `storylineId`; each `merged` entry fires
  `trigger: "merge"` for its winner. Critically, OFF the latency path: the
  linker runs inside the §6.3 sync-fill deadline and a label averages ~8s
  (timeout 20s), so labeling runs after the batch as a non-awaited,
  never-throwing tail — mirroring the linker's own never-throws stance — with
  `needsLabel` and the drift baseline already preventing re-ask storms.
- **Drift trigger**: a nightly label pass on the same chore as WP2's sweep,
  reusing `readLabelCandidates` + `labelStoryline({ trigger: "drift" })` — the
  exact loop the CLI runs, so the chore is a scheduler around existing code.
  It doubles as repair for anything the live tail missed (a crash, a deploy, a
  503). The CLI stays, as the manual override.

**Done when**: with the flag on and a fake `TextGenerator` in tests, promotion,
merge, and doubled membership each produce or refresh a label with no operator
involvement.

## WP5 — Retroactive attachment (spec 4)

**Runs last** — it is the only package that changes linking decisions, so it is
the only one that needs measurement.

The plan promised "retroactive attachment rides the same path — an old group is
just a candidate arriving late"; ADR-0011 promises "a Wednesday storyline may
pull in Monday's group". Neither happens: `attachGroup` has no production
callers — the already-homed branch of `linkGroup` only records bridges, and the
chronological backfill decides Monday's group before Wednesday's storyline
exists. Two changes:

1. **Attach in the already-homed branch.** When a replayed or re-offered group
   qualifies for a storyline it is not yet a member of, call `attachGroup` on
   the best qualifier — an ADDITIONAL arc, exactly the case the branch's own
   comment names as `attachGroup`'s purpose. Never re-home, never merge without
   bridge evidence; `attachGroup` is idempotent, so replays stay safe.
2. **Something must re-offer old groups.** A bounded late-candidate sweep on
   the nightly chore: re-run `linkGroup` over groups from the trailing df
   window (`STORYLINE_DF_WINDOW_DAYS`, ~14 days) — cheap, bounded, and it
   delivers "a candidate arriving late" without a full-archive replay. The
   alternative — relying on full backfill re-runs — leaves the live system
   permanently missing the behavior.

Guardrail: run the replay harness before and after, and record
largest-storyline share — attaching late candidates must not move the
percolation alarm. No number ships unmeasured.

**Done when**: the sweep over the dev archive attaches at least one genuinely
late group to a storyline formed after it; the before/after sweep table is
recorded in the commit message; largest-storyline share is unmoved.

## PR shape

Four PRs: WP1 (small, independent); WP2+WP3 together (dormancy end to end, one
`PAGE_SHAPE_VERSION` bump); WP4; WP5 with its measurement recorded. Only WP3
changes the wire; only WP5 changes linking decisions.
