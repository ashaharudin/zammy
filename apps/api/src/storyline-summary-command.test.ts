import type { Config } from "@zammy/config";
import { loadConfig } from "@zammy/config";
import type { Database } from "@zammy/storage";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UsageError,
  parseArgs,
  type CommandContext,
} from "./operator-command.js";
import { spec } from "./storyline-summary-command.js";

/**
 * A `run` body, tested directly — which is the point of the split the operator
 * command refactor made.
 *
 * Nothing here loads configuration, opens a pool or reaches `process`. The run
 * body takes a `CommandContext`, so the test hands it one: a config built from
 * a literal environment, and a database that answers the single query `--show`
 * makes. Before the split none of this was reachable — `storyline-summary-cli.ts`
 * did `loadConfig()` and `createConfiguredDb()` at import time, so a test that
 * imported it connected to Postgres.
 *
 * `--show` is the branch worth pinning because its output has a convention in
 * it: `DAY*` means "summarised without segments, past the Google News pubDate
 * cliff", which is the difference between "that day had no evening" and "we
 * could not tell when that day's coverage landed".
 */

const BASE = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/zammy",
  REDIS_URL: "redis://localhost:6379",
  CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
};

/**
 * A Kysely stand-in for the ONE read `--show` makes
 * (`readStorylineSummaries`): a chain that ignores every builder call and
 * resolves `execute()` to the rows it was given.
 *
 * Narrow on purpose. It is not a Postgres; the moment a command asks it
 * anything else the answer is an empty array, which is a wrong answer rather
 * than an error — so this belongs to the two branches that make exactly one
 * known query, and everything else in this repo that touches the database
 * still tests against a real one (`test-support.ts`).
 */
function rowsDb(rows: readonly unknown[]): Kysely<Database> {
  const chain: unknown = new Proxy(() => undefined, {
    get: (_target, property) =>
      property === "execute" ? async () => rows : property === "then" ? undefined : chain,
    apply: () => chain,
  });
  return chain as Kysely<Database>;
}

/** What `runCommand` would hand the run body, with the fakes standing in. */
function context(argv: string[], db: Kysely<Database>, config: Config): CommandContext {
  return {
    args: parseArgs(spec, argv),
    config,
    db,
    get labeler(): never {
      throw new Error("summaries:storylines declares no labeler");
    },
  };
}

describe("summaries:storylines --show", () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => void out.push(parts.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  const config = loadConfig(BASE as NodeJS.ProcessEnv);
  const uuid = "11111111-2222-3333-4444-555555555555";

  it("marks a day summarised WITHOUT segments, and explains the marker", () => {
    const db = rowsDb([
      {
        day_key: "2026-08-18",
        segment: "day",
        summary: "Floods cut the valley road.",
        article_count: 12,
        attempts: 1,
        segmented: false,
        model_id: "gemma-9",
        label: "Nepal Flash Floods",
        generated_at: new Date("2026-08-19T00:00:00Z"),
      },
      {
        day_key: "2026-08-19",
        segment: "morning",
        summary: "Rescue teams reached the last village.",
        article_count: 4,
        attempts: 1,
        segmented: true,
        model_id: "gemma-9",
        label: "Nepal Flash Floods",
        generated_at: new Date("2026-08-20T00:00:00Z"),
      },
    ]);

    return spec.run(context([`--storyline=${uuid}`, "--show"], db, config)).then(() => {
      expect(out[0]).toContain("2026-08-18");
      expect(out[0]).toContain("DAY*");
      expect(out[1]).toContain("morning");
      expect(out.at(-1)).toBe(
        "\n* day summarised without segments (past the pubDate cliff)",
      );
    });
  });

  it("says so plainly when an arc has nothing preserved", async () => {
    await spec.run(context([`--storyline=${uuid}`, "--show"], rowsDb([]), config));
    expect(out).toEqual(["no summaries for that storyline"]);
  });

  it("refuses --show without an arc to show", async () => {
    // A usage error, so `runCommand` exits 64 — and it is raised before the
    // database is touched, which is why the fake below would never be asked.
    await expect(spec.run(context(["--show"], rowsDb([]), config))).rejects.toThrow(
      new UsageError("--show needs --storyline=UUID"),
    );
  });

  it("refuses a --storyline that is not a UUID", async () => {
    await expect(
      spec.run(context(["--storyline=nepal-floods", "--show"], rowsDb([]), config)),
    ).rejects.toThrow("--storyline must be a storyline UUID (got 'nepal-floods')");
  });

  it("refuses a --from that is not a day", async () => {
    // The day flags are parsed before any model or lock, so a typo costs
    // nothing — which matters most on the backfill this command exists for.
    await expect(
      spec.run(context(["--from=18-08-2026"], rowsDb([]), config)),
    ).rejects.toThrow("--from must be YYYY-MM-DD (got '18-08-2026')");
  });
});
