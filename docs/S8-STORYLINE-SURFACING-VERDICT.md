# S8 verdict — how search surfaces storylines

The prototype round ADR-0011 left open ("Left open: the surfacing UX awaits the
prototype round"). Three variants, one dev-only route, mock data:
`apps/web/src/prototype/storylines/`, run with `pnpm prototype:storylines` (or
`/prototype/storylines?variant=A|B|C` while `pnpm dev:web` runs). The variant
code is throwaway and stays on the `claude/s8-implementation-25f41f` branch; this
note is the part that survives.

Universal gutter labels were the baseline in all three — settled, not under
test — so what was compared is only the extra layer a *search* adds.

The three cases each variant was judged on, all in the mock corpus:

- `iran` — three matched storylines, one wide, all recent
- `fort hood` — two storylines sharing the label "Fort Hood Crash", one of them
  dormant since March: the collision case
- `∅` / `army` — searches that surface nothing or one thing, i.e. the common case

## Verdict

**S7 builds A, the top strip.** B is refused. C is recorded as a deferred
accelerator, not part of S7.

### A — top strip (ships)

A row of matched-storyline cards above the first day divider: label, date span,
article/day counts, an activity sparkline, dormant marked.

It won on the case the other two cannot do at all: **comparison**. Two
storylines called "Fort Hood Crash" are only separable when they are adjacent —
side by side, "Fort Hood Crash · Aug 2026, 9 articles, 3 days" against "Fort
Hood Crash · Mar 2026, 2 articles, 1 day · dormant" answers "which one do I
mean?" in one glance. That is also exactly the disambiguation ADR-0011 promises,
so the strip is where the promise is actually keepable.

It is also the only variant whose behaviour is a function of the search alone:
the strip is the answer to "what stories are your words about", and it is
positionally stable regardless of how old the matched storylines' latest
coverage is.

Costs accepted, and what S7 should do about them:

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
