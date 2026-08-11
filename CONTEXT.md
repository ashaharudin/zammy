# Zammy

A news aggregator. Users search keywords and get a time-ordered timeline of headlines;
a landing-page cloud shows what the day's news is mostly about. All content comes from
the Currents API, which re-emits the same story many times over — a quirk that shapes
most of the language below.

## Language

### Content

**Sighting**:
One emission of an article by the upstream API. Upstream re-emits the same story under
fresh identifiers — one page arrived 50 times in 100 results — so a sighting is an
observation, not a story.
_Avoid_: emission, raw article, row

**Article**:
A single real-world news story, identified by its canonical URL. An article has one or
more sightings. This is the unit users see and the unit anything countable counts.
_Avoid_: cluster, story, item, post

**Source**:
The outlet that published an article, identified by its registrable domain. Two sources
covering the same story yield two articles, deliberately.
_Avoid_: publisher, feed, provider

### Discovery

**Topic**:
A canonicalized search — keywords plus optional language, country and category — that
accumulates articles over time and is shared by everyone who searches the same thing.
_Avoid_: search, query, feed, tag

**Keyword**:
A word a user types in. Keywords are input to a topic.
_Avoid_: term, tag, phrase

**Term**:
A proper noun or two-word phrase extracted from article headlines and ranked for the
landing-page cloud. Generic single words never qualify, however frequent. Terms are output,
keywords are input; clicking a term opens a topic. A term is a surface form, not a concept:
"China" and "Chinese" are two terms and both may appear.
_Avoid_: topic, keyword, trend, tag

**Fingerprint**:
The stable identity of a topic, derived from its canonicalized keywords and filters and
deliberately excluding any time window — so the same search always finds the same topic.
_Avoid_: hash, key, topic id

**Coverage**:
The time spans for which a topic's articles have actually been fetched. Coverage is what
separates "nothing was published then" from "we never asked".
_Avoid_: history, range, window
