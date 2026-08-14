# S8 verdict — how search surfaces storylines

The prototype round ADR-0011 left open ("Left open: the surfacing UX awaits the
prototype round"). Five variants, one dev-only route, mock data:
`apps/web/src/prototype/storylines/`, run with `pnpm prototype:storylines` (or
`/prototype/storylines?variant=A|B|C|D|E` while `pnpm dev:web` runs). The variant
code is throwaway and stays on the `claude/s8-implementation-25f41f` branch; this
note is the part that survives.

Universal gutter labels were the baseline in all five — settled, not under
test — so what was compared is only the extra layer a *search* adds.

The cases each variant was judged on, all in the mock corpus:

- `iran` — three matched storylines, one wide, all recent (and, for the floating
  variant, the case that decides whether the strip fits on a phone)
- `fort hood` — two storylines sharing the label "Fort Hood Crash", one of them
  dormant since March: the collision case
- `∅` / `army` — searches that surface nothing or one thing, i.e. the common case

## Verdict

**E wins: storyline pills in the command bar, under the date stamp**, size
carried by a glyph rather than a count, the row collapsible from a handle on the
bar's bottom edge. That is what S7 builds.

The rest, in one line each:

| | | |
|---|---|---|
| **E** — pills in the command bar | **ships** | persistent, occludes nothing, closable |
| A — top strip above the results | fallback | more payload per storyline, but displaces the timeline and only exists at the top of the page |
| B — storyline as a rail slot | refused | surfaces old matches below the fold, mixes two clocks on one axis |
| C — command-bar typeahead | deferred | an accelerator, not a surfacing; needs an API S6 does not ship |
| D — floating bottom strip | superseded | E's persistence without E's occlusion cost |

A stays written down as the fallback because it is the one variant that answers
"what if pills are too thin against real labels" — not because the decision is
open. It is not: S7 builds E.

The round ran in two passes: A/B/C first, where A won; then D (floating strip)
and E (pills in the chrome) were built on the back of it, and E beat both. The
sections below keep the reasoning in the order it was found, because A's case is
still the case E has to keep answering.

### E — pills in the command bar (the winner; S7 builds this)

A row inside the sticky command bar, under the asOf stamp: one pill per surfaced
storyline, each a size glyph plus the label, plus the date qualifier when two
labels collide. No counts, no spans, no sparkline. The bar's bottom edge is a
handle — a hairline with a caret on it — that hides and restores the row.

It takes D's persistence and pays none of D's costs. The bar is already sticky,
so the pills are reachable at any scroll depth — the property that made D worth
building — but they occlude nothing, because the space is the chrome's own.
Measured on the `iran` case: the bar grows from 66px to 96px when a search
surfaces three storylines, and the pills wrap to a second row at 375px rather
than hiding matches behind a horizontal scroll, which is the wart both A and D
carry.

It also sits where the model says it belongs. ADR-0011 makes search and
storylines separate axes; a surfacing treatment in the *chrome* is that
separation drawn in layout, while a strip inside the results reads as part of
the result set.

Size as a glyph earns its place. The question a reader asks of a surfaced
storyline is "how big is this", not "how many exactly", and a bucket survives the
count moving while they look at it. Buckets: 1–10, 11–50, 51–100, 101+, drawn as
a 2×2 block of 4px squares with one square coloured per step, bottom row first —
a container filling rather than a bar growing.

The unfilled squares stay drawn at low opacity, and that is the load-bearing
part: they are the visible maximum, so one pill on its own reads as "one of
four" instead of needing a neighbour to be compared against.

It reached that shape via block-element characters (▂▄▆█), which are recorded
here because the reasons they lost apply to any typographic ramp: ▁ renders as
an underscore at 0.8rem and reads as a typo; the ramp needed a faint █ painted
behind it to have a maximum at all; the glyphs sit on the text baseline rather
than the pill's optical centre; and the shape is at the mercy of whichever mono
font the reader has. Four divs have none of those problems.

The exact count still exists for anyone who needs it: it is in the pill's
`aria-label` and `title`, where it costs no width.

**The handle.** The pills row is closable — the hairline at the foot of the
command bar carries a caret, and collapsing takes the sticky bar back to its
pre-storylines height. Two decisions worth keeping in S7:

- The handle is the bar's own bottom edge, so the control costs no row of its
  own, and it stays put in both states — which is what makes a closed row
  findable again.
- The caret is bare in both states, and the handle carries a background a shade
  darker than the bar instead: the tint is what says "press me", and it says it
  without adding a word of chrome to a bar whose whole point is terseness. Mix
  toward black rather than reach for `--chip-bg` — that token is *lighter* than
  the surface in the dark theme, which would make the handle brighter than the
  chrome it belongs to.
- The collapsed state persists across searches. A reader who closed the row is
  saying "not what I am here for", and re-opening it on the next query would be
  the nag D's dismissal was.

Costs accepted:

- The bar is sticky, so every row added to it is subtracted from the timeline on
  every screen. 30px desktop, ~56px on a phone when the pills wrap — recoverable
  by the reader via the handle, which is why the handle is not optional.
- The bar's height differs between searches that surface and searches that do
  not, so the rail's start position moves between searches. Acceptable —
  it moves at query time, never under a reading user — but S7 should check it
  does not fight the sticky offset.
- The thinnest payload of any variant: no span, no day count. The collision case
  still resolves, because the date qualifier does that work, not the span line.

### A — top strip (won the first pass; now the fallback)

A row of matched-storyline cards above the first day divider: label, date span,
article/day counts, an activity sparkline, dormant marked.

It won the first pass on the case B and C cannot do at all: **comparison**. Two
storylines called "Fort Hood Crash" are only separable when they are adjacent —
side by side, "Fort Hood Crash · Aug 2026, 9 articles, 3 days" against "Fort
Hood Crash · Mar 2026, 2 articles, 1 day · dormant" answers "which one do I
mean?" in one glance. That is also exactly the disambiguation ADR-0011 promises,
so the strip is where the promise is actually keepable.

It is also the only variant whose behaviour is a function of the search alone:
the strip is the answer to "what stories are your words about", and it is
positionally stable regardless of how old the matched storylines' latest
coverage is.

What it keeps over E, and why it stays the fallback: the cards have room for the
span, the day count and the activity sparkline, and the "N storylines about
'iran'" framing states what the row *is*. If real labels turn out to need that
context — or if pills at three matches read as chrome noise rather than as an
answer — this is what S7 falls back to.

Costs, and what S7 would do about them:

- It displaces the newest headline by roughly one card height. Real, and the
  price of an answer above its evidence. Keep the strip to one row; **no
  horizontal scroll** — cap at the three or four that fit and drop the rest
  rather than hiding matches behind a swipe (the prototype's overflow row is the
  one part of A that reads badly).
- It renders nothing when nothing is surfaced, which is most searches. That is a
  clean degradation to today's page, not a failure.
- Cards carry the date qualifier only on collision, matching the gutter rule.

### B — storyline as a rail slot (refused)

A visually distinct storyline slot injected into the timeline at the
storyline's latest activity, absorbing its own slot for that day.

It reads beautifully with one recent match and fails structurally otherwise:

1. **Surfacing below the fold is not surfacing.** The dormant "Fort Hood Crash"
   from March lands at March in the rail — five months of scrolling away in the
   dev archive, thousands of slots in production. The search matched it and the
   reader never sees it.
2. **It mixes two clocks on one axis.** Ordinary slots are positioned by that
   day's *earliest* article (the storyline-day's key); an injected storyline is
   positioned by its *latest* activity. Both descend, by different measures, in
   the same column. On `iran` this already puts a 14:00 storyline card above a
   07:00 article slot on the same day with no visible reason.
3. **It breaks the collision comparison** it needs most: absorbing the March
   storyline-day into a storyline card removes it from the slot set the
   on-screen collision check reads, so the August slots quietly lose their date
   qualifier.
4. **Absorption is read-path state the wire does not carry.** Deciding which
   storyline-day rows to swallow is a rendering decision made from data
   (`surfaced`) that has nothing to do with pagination — and it interacts badly
   with keyset pagination, where the absorbed day may arrive on a different page
   than the storyline that absorbs it.

Three of those four are structural, not styling. Refused.

### C — command-bar typeahead (deferred, not refused)

A dropdown under the command bar offering storylines while the reader types,
with "search for <words>" as the last row.

It is the nicest thing in the prototype to *use* — one keystroke sooner than any
other route into a storyline, and it costs the results page nothing. But it is
not a surfacing treatment:

- It is invisible to every reader who does not type: shared links, the landing
  page's term clicks, back/forward.
- It is gone the moment the search executes, and cannot be revisited. A reader
  who saw "Trump Iran War" flash past while typing has no way back to it from
  the results page.

So it cannot be the answer to "how does search surface storylines" — but it is a
good accelerator on top of one that is. It needs an API the read path does not
have yet (prefix matching over `storylines.profile_tokens` and labels, ranked,
debounced) and it is orthogonal to everything in S7. **Not in S7's scope**;
worth a small session of its own once the strip is live and the surfacing query
from S6 has proved out.

### D — floating bottom strip (superseded by E)

A's cards taken out of the flow and floated at the bottom of the viewport in the
switcher's own pill shape: label chips with sparkline, article count and the
dormant marker, a per-search dismiss, and tail clearance so the last slot is
still reachable underneath.

It fixes A's one real weakness cleanly. The strip is still there forty slots
down, which is exactly where "follow the story instead of reading the day"
becomes the thing the reader wants, and the newest headline keeps the top of the
page. It also keeps the property that decided the round: two "Fort Hood Crash"
chips sit side by side with their qualifiers, comparable at a glance.

What kept it from winning, both observed:

- **It occludes.** Mid-scroll it permanently covers a slot's worth of the
  viewport. Tail clearance only rescues the very bottom of the page. A strip
  that displaces content once, at the top, costs the reader less than one that
  covers different content forever.
- **It shrinks the payload, and mobile is where that bites.** In the pill there
  is no room for the date span, so a chip carries label + count. At 375px with
  three matches — the `iran` case — the pill shows the "3 storylines" label and
  one and a half chips; everything else is behind a horizontal scroll, which is
  the wart A was told to drop. A's cards carry span, counts and days at any
  width.

So it trades a bounded, one-time cost for an unbounded, recurring one, and pays
for it in information density.

**D's idea survives; its position does not.** What D was really buying was
persistence — the pills still being there deep in the rail — and E buys the same
thing from the sticky bar, which the page already pays for. Once E existed there
was nothing D did better, so the scroll-demotion hybrid this section originally
proposed is dropped: it was a way to bolt persistence onto A, and E has it by
construction.

## Other findings, for S7

- **The storyline view still draws gutter labels on every slot** while the same
  label sits in the command bar as a chip. Suppress the gutter label inside the
  storyline view — it names what the reader is already inside.
- **The collision qualifier fires per slot**, so a run of four days of "Fort
  Hood Crash" repeats "· Aug 2026" four times down the gutter. Correct, and
  noisier than expected. Worth trying "qualify only the first slot of each run"
  in S7 against real data.
- **Dormancy is worth showing.** "dormant" on a surfaced storyline card
  explained the March match instantly; without it the reader wonders why a
  five-month-old story is being offered.
- The strip's counts ("9 articles · 3 days") did more work than the sparkline.
  If the S6 payload makes the per-day activity expensive, drop the sparkline
  before dropping the counts.
- **What E needs from S6's surfacing payload is small**: storyline UUID, label,
  article count (for the bucket), status, and the span — the span only for the
  collision qualifier, so `to` alone would do. No per-day activity array, which
  is the one expensive field the strip variants wanted.
- Bucket boundaries (10 / 50 / 100) are eyeballed, not measured. Once S5's
  backfill has run, check the distribution of storyline article counts in the
  dev archive: if nine storylines in ten land in one bucket, the ramp is
  decoration and the boundaries should move.
