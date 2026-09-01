import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_CONFIG,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  NON_NEGATIVE_NUMBER,
  POSITIVE_INTEGER,
  POSITIVE_NUMBER,
  UsageError,
  helpText,
  parseArgs,
  runCommand,
  type CommandSpec,
} from "./operator-command.js";

/**
 * The operator-command shape, tested — which until this module existed nothing
 * was: the twelve `*-cli.ts` files did all of this at import time, so importing
 * one to test it opened a Postgres pool and could call `process.exit`.
 *
 * What is worth pinning here is the part that is a CONTRACT rather than a
 * convenience. A scheduler reads the exit code and a shell script branches on
 * it, so 64 and 78 meaning what `sysexits.h` says they mean is load-bearing;
 * and unknown-flag rejection is the behaviour this refactor added deliberately,
 * so it has to be the behaviour it keeps.
 */

/** A spec that touches nothing: no database, no labeler, no model. */
function testSpec(over: Partial<CommandSpec> = {}): CommandSpec {
  return {
    name: "test:command",
    synopsis: "[--limit=N] [--dry-run]",
    flags: {
      limit: { kind: "value", placeholder: "N", describe: "how many" },
      "dry-run": { kind: "boolean", describe: "change nothing" },
    },
    async run() {},
    ...over,
  };
}

describe("parseArgs", () => {
  it("reads `--x=v` and a bare `--x`", () => {
    const args = parseArgs(testSpec(), ["--limit=7", "--dry-run"]);
    expect(args.value("limit")).toBe("7");
    expect(args.boolean("dry-run")).toBe(true);
  });

  it("leaves an absent flag absent rather than empty", () => {
    // The difference matters: every command spells its own default, and `""`
    // would silently become 0 through `Number`.
    const args = parseArgs(testSpec(), []);
    expect(args.value("limit")).toBeUndefined();
    expect(args.boolean("dry-run")).toBe(false);
  });

  it("keeps an `=` inside the value", () => {
    const args = parseArgs(testSpec(), ["--limit=a=b"]);
    expect(args.value("limit")).toBe("a=b");
  });

  it("REFUSES a flag the spec does not declare", () => {
    // The behaviour this refactor added. Ignoring it is how `--dryrun` silently
    // ran a live merge: the misspelling parses to nothing, the default applies,
    // and the run looks fine.
    expect(() => parseArgs(testSpec(), ["--dryrun"])).toThrow(UsageError);
    expect(() => parseArgs(testSpec(), ["--dryrun"])).toThrow("unknown flag: --dryrun");
  });

  it("refuses a value handed to a boolean flag", () => {
    expect(() => parseArgs(testSpec(), ["--dry-run=false"])).toThrow("--dry-run takes no value");
  });

  it("refuses a value flag with no value", () => {
    // Rather than reading the next argument, which would make `--limit
    // --dry-run` mean a limit of "--dry-run".
    expect(() => parseArgs(testSpec(), ["--limit"])).toThrow("--limit needs a value: --limit=N");
  });

  it("refuses a positional to a command that takes none", () => {
    expect(() => parseArgs(testSpec(), ["storylines"])).toThrow("unexpected argument: storylines");
  });

  it("accepts exactly one of a declared positional's values", () => {
    const spec = testSpec({
      positional: { placeholder: "<a|b>", values: ["a", "b"] },
    });
    expect(parseArgs(spec, ["b", "--dry-run"]).positionals).toEqual(["b"]);
    expect(() => parseArgs(spec, [])).toThrow(UsageError);
    expect(() => parseArgs(spec, ["c"])).toThrow(UsageError);
    expect(() => parseArgs(spec, ["a", "b"])).toThrow(UsageError);
  });

  it("says so when a command reads a flag it never declared", () => {
    // A programming error, not an operator's — so it is an Error and not a
    // UsageError, and the first run of the command finds it.
    expect(() => parseArgs(testSpec(), []).value("nope")).toThrow(
      "test:command read --nope as a value flag, which it did not declare",
    );
  });
});

describe("Args.number", () => {
  const args = (argv: string[]) => parseArgs(testSpec(), argv);

  it("returns the fallback when the flag is absent", () => {
    expect(args([]).number("limit", POSITIVE_INTEGER, { fallback: 500 })).toBe(500);
    expect(args([]).number("limit", POSITIVE_INTEGER)).toBeUndefined();
  });

  it("keeps the three wordings the twelve commands already printed", () => {
    // Reworded, an operator's error message becomes a behaviour change nobody
    // asked for — and these are the exact strings the CLIs printed before the
    // consolidation.
    expect(() => args(["--limit=0"]).number("limit", POSITIVE_INTEGER)).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => args(["--limit=abc"]).number("limit", POSITIVE_NUMBER)).toThrow(
      "--limit must be a positive number (got 'abc')",
    );
    expect(() => args(["--limit=-1"]).number("limit", NON_NEGATIVE_NUMBER)).toThrow(
      "--limit=-1 is not a non-negative number",
    );
  });

  it("appends the note, so a default can be named in the refusal", () => {
    expect(() =>
      args(["--limit=1.5"]).number("limit", POSITIVE_INTEGER, { note: "(default 500)" }),
    ).toThrow("--limit must be a positive integer (default 500)");
  });

  it("allows zero only where the command said zero is a real answer", () => {
    expect(args(["--limit=0"]).number("limit", NON_NEGATIVE_NUMBER)).toBe(0);
    expect(() => args(["--limit=0"]).number("limit", POSITIVE_NUMBER)).toThrow(UsageError);
  });
});

describe("helpText", () => {
  it("lists every declared flag, and --help", () => {
    const text = helpText(testSpec());
    expect(text).toContain("usage: test:command [--limit=N] [--dry-run]");
    expect(text).toContain("--limit=N");
    expect(text).toContain("how many");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--help");
  });

  it("prints a command's own prose verbatim when it has some", () => {
    // `chores` and `measure:deepening-yield` explain what each pass or
    // sub-command spends, which no generated table can say.
    const text = helpText(testSpec({ details: "\n  a  the first thing" }));
    expect(text).toBe(
      "usage: test:command [--limit=N] [--dry-run]\n\n  a  the first thing\n\n  --help  print this and exit",
    );
  });
});

describe("runCommand", () => {
  const argv = process.argv;
  const env = process.env;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => void out.push(parts.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...parts) => void err.push(String(parts[0])));
    process.env = {
      DATABASE_URL: "postgres://user:pass@localhost:5432/zammy",
      REDIS_URL: "redis://localhost:6379",
      CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
    } as NodeJS.ProcessEnv;
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = argv;
    process.env = env;
    process.exitCode = undefined;
  });

  const run = async (spec: CommandSpec, flags: string[]): Promise<void> => {
    process.argv = ["node", "cli.js", ...flags];
    await runCommand(spec);
  };

  it("prints the help and exits 0 for --help, without running the command", async () => {
    const ran = vi.fn();
    await run(testSpec({ run: async () => void ran() }), ["--help"]);
    expect(process.exitCode).toBe(EXIT_OK);
    expect(ran).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("usage: test:command");
  });

  it("answers --help even when the command's positional is missing", async () => {
    // `pnpm chores --help` must say which passes exist rather than complain
    // that no pass was named, which is the reason it is checked first.
    await run(testSpec({ positional: { placeholder: "<a|b>", values: ["a", "b"] } }), ["--help"]);
    expect(process.exitCode).toBe(EXIT_OK);
  });

  it("exits 64 on a usage error, printing the message and not the help", async () => {
    await run(
      testSpec({
        run: async () => {
          throw new UsageError("--show needs --storyline=UUID");
        },
      }),
      [],
    );
    expect(process.exitCode).toBe(EXIT_USAGE);
    expect(err).toEqual(["--show needs --storyline=UUID"]);
  });

  it("exits 64 and prints the help when the usage error has nothing to add", async () => {
    await run(testSpec({ run: async () => { throw new UsageError(); } }), []);
    expect(process.exitCode).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("usage: test:command");
  });

  it("exits 64 on an unknown flag, before loading any configuration", async () => {
    process.env = {} as NodeJS.ProcessEnv; // which would be a ConfigError
    await run(testSpec(), ["--nope"]);
    expect(process.exitCode).toBe(EXIT_USAGE);
    expect(err[0]).toBe("unknown flag: --nope");
  });

  it("exits 78 when the environment is not configured", async () => {
    // EX_CONFIG, the same refusal `index.ts` makes — a scheduler branches on
    // this to tell "the deploy is wrong" from "the pass failed".
    process.env = {} as NodeJS.ProcessEnv;
    const ran = vi.fn();
    await run(testSpec({ run: async () => void ran() }), []);
    expect(process.exitCode).toBe(EXIT_CONFIG);
    expect(ran).not.toHaveBeenCalled();
  });

  it("exits 1 on anything else the command throws", async () => {
    await run(
      testSpec({
        run: async () => {
          throw new Error("upstream said no");
        },
      }),
      [],
    );
    expect(process.exitCode).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("upstream said no");
  });

  it("uses the code the command returns, so a pass can report its own outcome", async () => {
    await run(testSpec({ run: async () => EXIT_CONFIG }), []);
    expect(process.exitCode).toBe(EXIT_CONFIG);
  });

  it("leaves the code alone when the command returns nothing", async () => {
    // `process.exitCode`, never `process.exit()`: `console.log` to a pipe is
    // asynchronous and `process.exit` does not flush it, which is how
    // `pnpm chores status --limit=200 | jq` lost its tail.
    await run(testSpec(), []);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a dependency the spec did not declare", async () => {
    await run(
      testSpec({
        run: async ({ db }) => {
          void db;
        },
      }),
      [],
    );
    expect(process.exitCode).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("test:command did not declare a database handle");
  });
});

describe("an empty flag value", () => {
  // `--model=$MODEL` with `$MODEL` unset is the ordinary way this arrives, and
  // the merge in `createLabeler` uses `??` — which does not catch "" — so an
  // unset variable would otherwise read as a deliberate override.
  it("is refused, not read as an absent flag", () => {
    expect(() => parseArgs(testSpec(), ["--limit="])).toThrow(/--limit needs a value/);
  });
});
