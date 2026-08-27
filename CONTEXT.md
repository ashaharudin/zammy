# Zammy

A news aggregator. Users search keywords and get a time-ordered timeline of headlines; a
landing-page cloud names the storylines the rolling window updated. Content comes from the Currents
API — which re-emits the same story many times over, a quirk that shapes most of the language
below — and optionally from GNews alongside it.

## Language

### Content

**Sighting**:
One emission of an article by an upstream API. Upstream re-emits the same story under fresh
identifiers — one page arrived 50 times in 100 results — so a sighting is an observation, not a
story. Two providers reporting one URL is two sightings of one article, not a duplicate to resolve.
_Avoid_: emission, raw article, row

**Provider**:
An upstream news API we fetch from — Currents, and optionally GNews. Providers are not equals: one
is **coverage-bearing** and alone decides when a time window has been fully fetched; any other is
best-effort breadth whose absence is never recorded as coverage (ADR-0012). Distinct from
**source**, the outlet that published an article: one provider reports many sources, and two
providers report many of the same.
_Avoid_: upstream (as a countable noun), API, feed, source

**Article**:
A single real-world news story, identified by its canonical URL, with one or more sightings. The
unit users see and the unit anything countable counts.
_Avoid_: cluster, story, item, post

**Group**:
One story as several outlets ran it: the same piece syndicated at different URLs, kept as separate
articles and joined rather than merged. Groups attach to storylines; a timeline slot is one
storyline's coverage on one day. Most groups hold a single article, and a group never spans two
calendar days.
_Avoid_: cluster, duplicate, merge, story

**Storyline**:
One specific event or evolving situation — "Trump Iran War", never bare "Donald Trump" — as a
persistent collection of groups, identified by UUID and unbounded in time: an ongoing story holds
its whole arc. Paged by day regardless: each day it has coverage takes one timeline slot holding
that day's articles, its earliest as the hero. A group may belong to several storylines. Every group
is born a provisional storyline of one, invisible as such; a second group's attachment promotes it.
Formation errs narrow, and storylines merge automatically — bridged (K independent groups qualifying
for both) or label-agreement (two model labels agreeing, grounded, spans overlapping or
near-touching) — the loser's UUID kept as an alias.
_Avoid_: cluster, thread, saga, topic

**Representative**:
The article whose headline a timeline slot shows. Chosen per topic from the slot's lead group — the
largest the storyline shows that day — among the members that matched that search, by source
authority; never by how often upstream re-emitted it. It heads the part of the day the slot's own
time falls in; a card the rail cut out of a LATER part is headed by the earliest article that part
holds, the wire carrying no group structure below the slot to choose within.
_Avoid_: primary, canonical, best, winner

**Seed**:
The article a group started from, and its identity — what `group_id` names. Fixed for the group's
life but not privileged when matching: a newcomer is compared against any member, and the calendar
day bounds a group's drift. The seed is neither the representative nor necessarily the group's
earliest article.
_Avoid_: parent, root, head

**Source**:
The outlet that published an article, identified by its registrable domain. Two sources covering the
same story yield two articles, deliberately.
_Avoid_: publisher, feed, provider

### Discovery

**Topic**:
A canonicalized search — keywords plus optional language, country and category — that accumulates
articles over time and is shared by everyone who searches the same thing.
_Avoid_: search, query, feed, tag

**Keyword**:
A word a user types in. Keywords are input to a topic.
_Avoid_: term, tag, phrase

**Term**:
A proper noun, or a two-word phrase containing one, extracted from article headlines. Generic words
never qualify, however frequent, and neither does anything containing a verb: a term names
something, it does not state something. A surface form, not a concept: "China" and "Chinese" are two
terms. **No longer a cloud unit** — the cloud draws storyline labels (ADR-0013) — so a term is
internal vocabulary: what the shared headline tokenizer emits, read by article grouping and by the
bigram label that names a storyline when the model cannot.
_Avoid_: topic, keyword, trend, tag

**Fingerprint**:
The stable identity of a topic, derived from its canonicalized keywords and filters, deliberately
excluding any time window — so the same search always finds the same topic.
_Avoid_: hash, key, topic id

**Coverage**:
The time spans for which a topic's articles have actually been fetched — what separates "nothing was
published then" from "we never asked".
_Avoid_: history, range, window

**Segment**:
A part of the reader's own local day, dividing one day's slots on the rail: Night (00:00–06:00),
Morning, Afternoon, Evening (18:00–24:00). Non-wrapping, so a segment never crosses midnight and
always nests inside exactly one day. Presentation only — a coarser timestamp, never a unit anything
is counted, paged or fetched by, and never a claim about when a story happened. A segment CUTS a
slot rather than filing it: a storyline covered from breakfast to midnight draws a card in each part
of the day its coverage reached, headed by the storyline's own representative where the day begins
and by that part's earliest article elsewhere. Same-story copies never move; coverage that crossed
the reader's midnight is drawn under the day it actually ran in, which for a reader west of
`APP_TIMEZONE` is most of it. Cut in the reader's own zone, which is not
`APP_TIMEZONE` (that bounds group drift on the write path) and not the country chip's (that answers
whose news). A day with coverage in only one of them shows no segment at all.
_Avoid_: slot, block, bucket, period, part of day

**Storyline label**:
Two to five words naming a storyline at a glance — a proper noun plus what happened: "Fort Hood
Crash". Generated by an LLM at promotion, regenerated on merge or drift. Presentation, never
identity: labels are deliberately non-unique — two storylines may share one, told apart by date
span. Also the landing-page cloud's word (ADR-0013), busiest and freshest first. Wherever a label
is clicked — the cloud, the timeline, surfaced pills — it opens the storyline by UUID; a label's
words are never executed as a search (ADR-0011, ADR-0016). `cloudQuery` still grounds a label
against the arc's own coverage, at most two words (ADR-0014), but only to feed the search box's
placeholder text, not the click. Agreement between two
labels is also merge evidence: storylines independently given the same grounded label, with
overlapping or near-touching spans, merge on that alone — a big running story can outgrow the token
bridge's reach. A label is also a **match** surface, which is not the same as being an identity: a
search surfaces storylines whose profile tokens *or* label words contain every keyword (ADR-0011,
amended), so a label the cloud showed can be typed back in and find its story.
_Avoid_: term, keyword, phrase, tag, title
