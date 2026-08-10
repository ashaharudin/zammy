---
status: accepted
---

# Postgres is the archive beyond the upstream 30-day lookback

Currents API refuses any `start_date` older than 30 days (verified: 29 days returns
200, 31 days returns `400 "Max lookback is 30 days"`). Articles we stored more than
30 days ago therefore cannot be re-fetched from anywhere, which makes production
Postgres a **system of record** for that window, not a cache that can be rebuilt.
Local development is explicitly exempt: its data is disposable and archiving is
enabled only on RDS.

## Considered options

Treating the whole store as a rebuildable cache was the simpler model and is what the
rest of the design assumes about Redis. It was rejected because it is only true for
the most recent 30 days; beyond that, "rebuild from upstream" silently means "lose the
history".

## Consequences

- Production needs real backups and point-in-time recovery on RDS. This is a data-loss
  concern, not merely an availability one.
- `RETENTION_DAYS` may be widened freely but narrowed only deliberately — shortening it
  destroys history nothing can supply again. `@zammy/config` already refuses to boot
  when `RETENTION_DAYS < CURRENTS_MAX_LOOKBACK_DAYS`.
- **The retention job ships report-only: it logs what it would delete and deletes nothing.**
  Point-in-time recovery protects against accidents, not against the job doing exactly what
  it was told — a legitimate prune noticed three months later is outside any recovery window.
  The dataset is a few hundred MB at 90 days, so there is no pressure to reclaim space yet,
  and deletion is the one operation this ADR says cannot be undone. Enabling deletion is a
  later, deliberate decision. Do not "finish" this job without making that decision.
- Local dev data is disposable by design. `pnpm infra:reset` deleting the volume is
  expected, and no local backup story is owed. A laptop must never be mistaken for the
  archive.
- Redis keeps its cache semantics unchanged: a full flush costs latency and quota,
  never correctness.
