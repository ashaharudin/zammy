# S8 verdict — how search surfaces storylines

The prototype round ADR-0011 left open ("the surfacing UX awaits the prototype
round"). Five variants, one dev-only route, mock data:
`apps/web/src/prototype/storylines/`, run with `pnpm prototype:storylines` (or
`/prototype/storylines?variant=A|B|C|D|E` under `pnpm dev:web`). The variant
code is throwaway and stays on branch `claude/s8-implementation-25f41f`; this
note is what survives.

Universal gutter labels were the baseline in all five — settled, not under
test; only the extra layer a *search* adds was compared. Judged cases:

- `iran` — three matched storylines, one wide, all recent (and the phone-width
  stress case for the floating variant)
- `fort hood` — two storylines sharing the label "Fort Hood Crash", one dormant
  since March: the collision case
- `∅` / `army` — searches surfacing nothing or one thing, the common case

## Verdict

**E wins: storyline pills in the command bar, under the date stamp**, size as a
glyph rather than a count, the row collapsible from a handle on the bar's
bottom edge. S7 builds E.

| | | |
|---|---|---|
| **E** — pills in the command bar | **ships** | persistent, occludes nothing, closable |
| A — top strip above the results | fallback | more payload per storyline, but displaces the timeline and only exists at the top of the page |
| B — storyline as a rail slot | refused | surfaces old matches below the fold, mixes two clocks on one axis |
| C — command-bar typeahead | deferred | an accelerator, not a surfacing; needs an API S6 does not ship |
| D — floating bottom strip | superseded | E's persistence without E's occlusion cost |

A stays recorded as the fallback because it alone answers "what if pills are
too thin against real labels" — not because the decision is open. The round ran
in two passes: A/B/C first (A won), then D and E were built on the back of it
and E beat both. The reasoning is kept in the order found, because A's case is
still the case E must keep answering.

### E — pills in the command bar (the winner; S7 builds this)

A row inside the sticky command bar, under the asOf stamp: one pill per
surfaced storyline — size glyph plus label, plus the date qualifier on label
collision. No counts, spans, or sparkline. The bar's bottom edge is a handle (a
hairline with a caret) that hides and restores the row.

It takes D's persistence without D's costs: the bar is already sticky, so pills
are reachable at any scroll depth, and they occlude nothing because the space
is the chrome's own. Measured on `iran`: the bar grows 66px → 96px on three
surfaced storylines, and pills wrap to a second row at 375px instead of hiding
matches behind a horizontal scroll — the wart both A and D carry. It also sits
where the model says it belongs: ADR-0011 makes search and storylines separate
axes, and a treatment in the *chrome* draws that separation, where a strip
inside the results reads as part of the result set.

Size as a glyph: the reader asks "how big is this", not "how many exactly", and
a bucket survives the count moving. Buckets 1–10 / 11–50 / 51–100 / 101+, drawn
as a 2×2 block of 4px squares, one coloured per step, bottom row first — a
container filling. The unfilled squares stay drawn at low opacity, and that is
load-bearing: they are the visible maximum, so a lone pill reads as "one of
four" without a neighbour to compare against. Block-element characters (▂▄▆█)
were tried first and lost for reasons that apply to any typographic ramp: ▁
renders as an underscore at 0.8rem, the ramp needed a faint █ behind it to have
a maximum, the glyphs sit on the text baseline rather than the pill's optical
centre, and the shape depends on the reader's mono font. Four divs have none of
those problems. The exact count lives in the pill's `aria-label` and `title`,
where it costs no width.

**The handle.** Collapsing returns the sticky bar to its pre-storylines height.
Decisions to keep in S7:

- The handle is the bar's own bottom edge — no row of its own, and it stays put
  in both states, which is what makes a closed row findable again.
- The caret is bare in both states; the handle carries a background a shade
  darker than the bar — the tint says "press me" without adding chrome. Mix
  toward black, not `--chip-bg`: that token is *lighter* than the surface in
  the dark theme and would make the handle brighter than its chrome.
- The collapsed state persists across searches: a reader who closed the row
  said "not what I am here for", and re-opening on the next query would be the
  nag D's dismissal was.

Costs accepted:

- Every row added to the sticky bar is subtracted from the timeline on every
  screen: 30px desktop, ~56px on a phone when pills wrap — recoverable via the
  handle, which is why the handle is not optional.
- Bar height differs between surfacing and non-surfacing searches, so the
  rail's start position moves between searches. Acceptable — it moves at query
  time, never under a reading user — but S7 should check it does not fight the
  sticky offset.
- The thinnest payload of any variant: no span, no day count. The collision
  case still resolves via the date qualifier.

### A — top strip (won the first pass; now the fallback)

A row of matched-storyline cards above the first day divider: label, date span,
article/day counts, activity sparkline, dormant marked.

It won the first pass on the case B and C cannot do at all: **comparison**. Two
"Fort Hood Crash" storylines are only separable when adjacent — "Aug 2026, 9
articles, 3 days" beside "Mar 2026, 2 articles, 1 day · dormant" answers "which
one do I mean?" at a glance, exactly the disambiguation ADR-0011 promises. It
is also the only variant whose behaviour is a function of the search alone,
positionally stable however old the matched storylines' latest coverage is.

Why it stays the fallback: the cards have room for span, day count and
sparkline, and the "N storylines about 'iran'" framing states what the row
*is*. If real labels need that context — or pills at three matches read as
chrome noise — this is what S7 falls back to.

Costs, and what S7 would do about them:

- It displaces the newest headline by roughly one card height — the price of an
  answer above its evidence. Keep the strip to one row; **no horizontal
  scroll** — cap at the three or four that fit and drop the rest (the
  prototype's overflow row is the one part of A that reads badly).
- It renders nothing when nothing is surfaced — most searches — which is a
  clean degradation to today's page.
- Cards carry the date qualifier only on collision, matching the gutter rule.

### B — storyline as a rail slot (refused)

A visually distinct storyline slot injected into the timeline at the
storyline's latest activity, absorbing its own slot for that day. Reads
beautifully with one recent match; fails structurally otherwise:

1. **Surfacing below the fold is not surfacing.** The dormant March "Fort Hood
   Crash" lands at March in the rail — five months of scrolling in the dev
   archive, thousands of slots in production. Matched, never seen.
2. **It mixes two clocks on one axis.** Ordinary slots are positioned by the
   day's *earliest* article (the storyline-day's key); an injected storyline by
   its *latest* activity. On `iran` this puts a 14:00 storyline card above a
   07:00 article slot on the same day with no visible reason.
3. **It breaks the collision comparison it needs most**: absorbing the March
   storyline-day removes it from the slot set the on-screen collision check
   reads, so the August slots quietly lose their date qualifier.
4. **Absorption is read-path state the wire does not carry** — a rendering
   decision made from `surfaced`, unrelated to pagination, and it interacts
   badly with keyset pagination: the absorbed day may arrive on a different
   page than the storyline that absorbs it.

Three of the four are structural, not styling. Refused.

### C — command-bar typeahead (deferred, not refused)

A dropdown offering storylines while the reader types, "search for <words>" as
the last row. The nicest thing in the prototype to *use* — one keystroke sooner
than any other route into a storyline, at no cost to the results page — but not
a surfacing treatment: invisible to every reader who does not type (shared
links, landing-page term clicks, back/forward), and gone the moment the search
executes with no way back to what flashed past.

So it cannot answer "how does search surface storylines", but is a good
accelerator on top of something that does. It needs an API the read path lacks
(prefix matching over `storylines.profile_tokens` and labels, ranked,
debounced) and is orthogonal to S7. **Not in S7's scope**; worth its own small
session once the surfacing query from S6 has proved out.

### D — floating bottom strip (superseded by E)

A's cards floated at the bottom of the viewport in the switcher's pill shape:
label chips with sparkline, article count, dormant marker, per-search dismiss,
tail clearance so the last slot stays reachable.

It fixes A's one real weakness — the strip is still there forty slots down,
exactly where "follow the story instead of reading the day" becomes what the
reader wants, while the newest headline keeps the top of the page — and keeps
the side-by-side collision comparison. What kept it from winning, both
observed:

- **It occludes.** Mid-scroll it permanently covers a slot's worth of viewport;
  tail clearance only rescues the very bottom. Displacing content once at the
  top costs less than covering different content forever.
- **It shrinks the payload, and mobile is where that bites.** No room for the
  date span; a chip is label + count. At 375px with three matches the pill
  shows "3 storylines" and one and a half chips, the rest behind a horizontal
  scroll — the wart A was told to drop. A's cards carry span, counts and days
  at any width.

A bounded one-time cost traded for an unbounded recurring one, paid in
information density. **D's idea survives; its position does not**: D was buying
persistence, and E buys it from the sticky bar the page already pays for. The
scroll-demotion hybrid this section once proposed is dropped — it bolted
persistence onto A, and E has it by construction.

## Other findings, for S7

- **The storyline view still draws gutter labels on every slot** while the same
  label sits in the command bar as a chip. Suppress the gutter label inside the
  storyline view — it names what the reader is already inside.
- **The collision qualifier fires per slot**: four days of "Fort Hood Crash"
  repeats "· Aug 2026" four times down the gutter. Correct, noisier than
  expected; try "qualify only the first slot of each run" against real data.
- **Dormancy is worth showing.** "dormant" on a surfaced card explained the
  March match instantly; without it the reader wonders why a five-month-old
  story is offered.
- The strip's counts ("9 articles · 3 days") did more work than the sparkline;
  if per-day activity is expensive in the S6 payload, drop the sparkline before
  the counts.
- **What E needs from S6's surfacing payload is small**: storyline UUID, label,
  article count (for the bucket), status, and the span — only for the collision
  qualifier, so `to` alone would do. No per-day activity array, the one
  expensive field the strip variants wanted.
- Bucket boundaries (10 / 50 / 100) are eyeballed, not measured. Once S5's
  backfill has run, check the distribution of storyline article counts: if nine
  storylines in ten land in one bucket, the ramp is decoration and the
  boundaries should move.
