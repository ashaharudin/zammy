/**
 * @zammy/representative — which article's headline a card shows.
 *
 * One rule with four clauses (CONTEXT.md, Representative), stated once. It used
 * to be stated four times: a SQL join in `@zammy/storage`, `leadBeats` and
 * `chooseRepresentative` in `apps/api`, and `earliestIndex` in `apps/web` — no
 * module naming the rule, and no test able to assert the four agreed.
 *
 * **Why a package of its own, and not `@zammy/shared`** (ADR-0024).
 * `TIER_1_SOURCES` is an
 * editorial stance, not a wire shape, and ADR-0004 reserves `shared` for the
 * shapes the API sends and the browser renders. Its closing rule is the one
 * followed here: what the browser needs but `shared` must not hold "belongs in
 * the package that owns the concern". This is that package. It is dependency-
 * free and generic over the four fields the rule reads, so it drags neither the
 * wire contract nor zod behind it, and it can hold no secret — ADR-0004's
 * safety mechanism is about `@zammy/config` and the API key, and nothing here
 * goes near either.
 */
export {
  chooseRepresentative,
  isTier1,
  TIER_1_SOURCES,
  type Attributable,
} from "./source-authority.js";
export {
  chooseHeading,
  LATER_PART_RULE,
  type Grouped,
  type Heading,
  type Within,
} from "./heading.js";
