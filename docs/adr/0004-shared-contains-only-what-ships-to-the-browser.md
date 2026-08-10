---
status: accepted
---

# `@zammy/shared` contains only what ships to the browser

`@zammy/shared` holds the wire contract and nothing else — the shapes the API sends and the
browser renders. Server-side concerns live elsewhere: configuration and the API key in
`@zammy/config`, upstream shapes in `@zammy/currents-client`. The web app may import
`shared`; it may never import the other two.

## Considered options

The convenient alternative is one "shared types" package that everything imports. It was
rejected because the boundary is the safety mechanism: keeping the API key's home in a
package the browser bundle cannot legitimately reach is what makes leaking it a structural
error rather than a review catch.

The rule was already being broken when it was written. `NormalizedArticle` sat in `shared`
carrying `dedupKey` — a URL hash used only to collapse sightings server-side — so every
browser bundle shipped a field the UI has no use for. Harmless in itself, but it is the
shape of the mistake that matters: a field lands in `shared` because that was the easy
import, and the boundary erodes one convenience at a time.

## Consequences

- The sighting→article collapse belongs to the storage layer, not the client. Collapsing
  needs state across responses that a single upstream page cannot have, so
  `@zammy/currents-client` stays stateless and returns `Sighting[]`; articles are born in
  storage.
- `Sighting` lives in `@zammy/currents-client`. `Article` is the wire type in `shared`,
  carrying `sightingCount` and `latestSeen` — and not `dedupKey`.
- Adding a type to `shared` requires asking whether the browser needs it. If the answer is
  no, it belongs in the package that owns the concern.
