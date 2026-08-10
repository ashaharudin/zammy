---
status: accepted
---

# Kysely and hand-written SQL instead of an ORM

Data access uses **Kysely** — a typed query builder over SQL we author — rather than
Drizzle, Prisma, or any ORM that owns schema definition. The schema's hard parts are not
CRUD: coverage is a `tstzrange` with a GiST index queried by range difference, and the
timeline is keyset pagination over a composite `(published, id)` tuple. Those are the
queries that decide whether the product works, and they are written by hand.

## Considered options

Drizzle was the alternative carried in the architecture draft. It wants to own schema
definition and migration generation, which fights hand-written range types and gives no
help with the two queries that actually matter. Raw `pg` alone was rejected for losing
type safety across multi-table joins.

## Consequences

- A future reader will notice there is no ORM and may assume it was an oversight. It was
  not: the range and keyset queries are the point, and an ORM would hide them.
- Migrations are hand-written rather than generated from a schema definition, so the
  schema in the migrations is the source of truth. They use Kysely's own `Migrator` with
  its `sql` template tag, which handles `tstzrange` and GiST without ceremony.
- **Migrations run as a discrete deploy step, never on application boot.** Booting into a
  migration is the convenient default and would race itself the moment two Fargate tasks
  deploy together. A Postgres advisory lock guards the migration runner as a backstop for
  anyone who wires it into boot regardless. Locally the same path is `pnpm db:migrate`.
