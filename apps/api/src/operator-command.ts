import { ConfigError, loadConfig, type Config } from "@zammy/config";
import type { Database } from "@zammy/storage";
import type { Kysely } from "kysely";
import { createConfiguredDb, createLabeler, type Labeler, type LabelerOverrides } from "./wiring.js";

/**
 * The shape every operator command has, owned once.
 *
 * There are twelve `*-cli.ts` entrypoints and until this module existed there
 * were twelve copies of the same forty lines: `process.argv.slice(2)`, a local
 * `flag()` that understood `--x=v` and nothing else, `loadConfig()`,
 * `createConfiguredDb`, and a `try/finally` that closed the pool. Copies drift,
 * and these had:
 *
 *   - **three exit-code vocabularies.** A bad `--days` was 1 in `regroup` and 64
 *     in `chores`, for the same class of mistake, against schedulers and shell
 *     scripts that read the number.
 *   - **five hand-rolled Gemini clients**, disagreeing with each other and with
 *     `wiring.createLabeler`. One of them (`storyline-label-merge`) omitted the
 *     pacing arguments entirely and silently took `createGeminiClient`'s literal
 *     defaults — 30 rpm against a deployment configured for 15, on the key the
 *     server is also spending (STORYLINE-LABELS, "The pacer's scope").
 *   - **no `--help` anywhere**, so the only way to learn a command's flags was
 *     to read its source.
 *   - **no tests at all**, because every one of those forty lines ran at import
 *     time: importing a command to test it opened a Postgres pool.
 *
 * This module is the seam that fixes the last one, and the first three follow
 * from it. A command declares what it wants — its flags, whether it needs a
 * database handle and at which pooling, whether it needs a labeler — and hands
 * over a `run` body that receives them. `runCommand` does the rest, so the
 * `*-cli.ts` file is a two-line entrypoint and the `run` body is an ordinary
 * importable function with no side effects at import time.
 *
 * ## What it deliberately does NOT own
 *
 * `chores` and `measure:deepening-yield` build their own database handle and
 * declare no `db` here. That is not an oversight: their handle comes from a
 * deeper module that owns more than the connection — `choreDepsFromConfig`
 * pins the session-mode URL and the pool size **together with** the linker bar
 * and the labeler pacing (`wiring.ts`'s header says why those must not be
 * spelled twice), and `buildServices` builds the whole server. Re-declaring
 * `{ session: true, max: 4 }` in a command spec would be exactly the second
 * copy `wiring.ts` exists to prevent. Those two close what they opened, inside
 * their own `run`.
 *
 * ## Exit codes
 *
 * One vocabulary, the three `chores-cli.ts` and `deepening-yield-cli.ts`
 * already used:
 *
 *     0   it ran
 *     1   it failed
 *    64   usage (EX_USAGE): a flag this command does not have, or a bad value
 *    78   configuration (EX_CONFIG): the refusal `index.ts` makes
 *
 * `process.exitCode`, never `process.exit()` — `chores-cli.ts` learned this the
 * expensive way and the reasoning generalises: `console.log` to a pipe is
 * asynchronous in Node and `process.exit` does not flush what is queued, so
 * `pnpm chores status --limit=200 | jq` silently lost its tail. Setting the code
 * and returning lets the process end once stdout has drained.
 */

/** It ran. */
export const EXIT_OK = 0;
/** It failed — the message above says how. */
export const EXIT_FAILED = 1;
/** EX_USAGE: the command line was wrong. */
export const EXIT_USAGE = 64;
/** EX_CONFIG: the environment was wrong. */
export const EXIT_CONFIG = 78;

/**
 * A flag the command declares.
 *
 * Two forms, which are the two the twelve commands actually use: `--x=value`
 * and a bare `--x`. There is deliberately no `--x value` form — nothing in this
 * repo has ever accepted one, and adding it would make `--limit --dry-run` mean
 * something (a limit of "--dry-run") rather than being rejected.
 */
export type FlagSpec =
  | {
      readonly kind: "boolean";
      readonly describe: string;
    }
  | {
      readonly kind: "value";
      /** What the value is called in `--x=NAME`, for the help table. */
      readonly placeholder: string;
      readonly describe: string;
    };

/**
 * How a numeric flag is judged, and what it says when the answer is no.
 *
 * Three of these, because the twelve commands print exactly three wordings
 * between them and a refactor that silently reworded an operator's error
 * message would be a behaviour change nobody asked for. They are values rather
 * than a `kind: "number"` on `FlagSpec` because the bar is the COMMAND's
 * decision: `--grace` may be zero and `--batch` may not, and which one applies
 * is not something a parser can infer from the flag's name.
 */
export interface NumberCheck {
  valid(value: number): boolean;
  message(name: string, raw: string): string;
}

/** `--days=0` is a mistake; `--days=1.5` is a mistake. */
export const POSITIVE_INTEGER: NumberCheck = {
  valid: (value) => Number.isInteger(value) && value >= 1,
  message: (name) => `--${name} must be a positive integer`,
};

/** A rate or a ceiling: fractional is fine, zero and negative are not. */
export const POSITIVE_NUMBER: NumberCheck = {
  valid: (value) => Number.isFinite(value) && value > 0,
  message: (name, raw) => `--${name} must be a positive number (got '${raw}')`,
};

/**
 * A bar an operator may deliberately set to zero — `--grace=0` is "no grace",
 * which is a real thing to ask for.
 */
export const NON_NEGATIVE_NUMBER: NumberCheck = {
  valid: (value) => Number.isFinite(value) && value >= 0,
  message: (name, raw) => `--${name}=${raw} is not a non-negative number`,
};

/**
 * The command line was wrong.
 *
 * With a message, that message is printed and nothing else — which is what a
 * bad `--days` has always done, and printing a page of help under a one-line
 * complaint buries it. With no message the full help is printed instead, which
 * is what `chores` and `measure:deepening-yield` have always done when the
 * thing missing is the command name itself: there the help IS the answer.
 */
export class UsageError extends Error {
  /** Print the command's help beneath the message (or instead of it). */
  readonly withHelp: boolean;

  constructor(message = "", options: { help?: boolean } = {}) {
    super(message);
    this.name = "UsageError";
    this.withHelp = options.help ?? message === "";
  }
}

/** The command line, parsed against the spec that declared it. */
export interface Args {
  /** Everything that is not a `--flag`, in the order it was typed. */
  readonly positionals: readonly string[];
  /** A declared `kind: "boolean"` flag: was it typed? */
  boolean(name: string): boolean;
  /** A declared `kind: "value"` flag: the raw text after the `=`, or absent. */
  value(name: string): string | undefined;
  /**
   * A declared `kind: "value"` flag as a number, judged by the command's own
   * bar. Fails with a `UsageError` rather than returning NaN, because NaN is
   * the failure mode that matters here: it fails the comparison it lands in,
   * which for `--grace` fails safe and for `--max-component` fails OPEN — the
   * anti-swallow valve stops guarding on the one run where the operator typed
   * the flag wrong, and a merge has no inverse.
   */
  number(name: string, check: NumberCheck, options: NumberOptions & { fallback: number }): number;
  number(name: string, check: NumberCheck, options?: NumberOptions): number | undefined;
}

export interface NumberOptions {
  /** Used when the flag is absent. Absent itself means "return undefined". */
  readonly fallback?: number;
  /** Appended to the refusal, e.g. `(default 500)`. */
  readonly note?: string;
}

/** What `runCommand` built, as the `run` body receives it. */
export interface CommandContext {
  readonly args: Args;
  readonly config: Config;
  /**
   * The handle the spec's `db` asked for, at the pooling it asked for.
   *
   * Reaching for one the spec did not declare throws immediately rather than
   * handing back `undefined` for a query to fail on later — it is a
   * programming error, and the first run of the command finds it.
   */
  readonly db: Kysely<Database>;
  /** The labeler the spec's `labeler` asked for. Same rule as `db`. */
  readonly labeler: Labeler;
}

export interface CommandSpec {
  /** The `pnpm` script name, as `apps/api/package.json` spells it. */
  readonly name: string;
  /** Everything after the name on the usage line. May be several lines. */
  readonly synopsis: string;
  /** Every flag the command accepts. Anything else is refused. */
  readonly flags: Readonly<Record<string, FlagSpec>>;
  /**
   * The positional argument, for the two commands that take one. Checked
   * BEFORE `loadConfig`, so `pnpm chores nonsense` in an unconfigured shell
   * still says which passes exist rather than complaining about the
   * environment.
   */
  readonly positional?: {
    readonly placeholder: string;
    /** The names accepted. */
    readonly values: readonly string[];
  };
  /**
   * Help text printed in place of the generated flag table.
   *
   * For the two commands whose usage text is a document rather than a list —
   * `chores` explains what each pass does, `measure:deepening-yield` explains
   * what each sub-command spends. Reproduced verbatim so `--help` and the
   * usage refusal say what they have always said.
   */
  readonly details?: string;
  /**
   * A database handle, at this pooling. `session: true` asks for
   * `DATABASE_SESSION_URL` and only a caller holding a SESSION-scoped advisory
   * lock may (`wiring.createConfiguredDb` has the argument).
   */
  readonly db?: { readonly max?: number; readonly session?: boolean };
  /**
   * A labeler, from `wiring.createLabeler` and from nowhere else — which is the
   * property this whole module exists to make true, because pacing declared per
   * command is pacing that drifts per command.
   *
   * `true` takes the configured pacing. A function returns the fields this one
   * command overrides, with the reason in a comment beside it: an operator
   * watching a terminal is the one caller that would rather wait than take a
   * bigram label, and `measure:storyline-coherence` continues on a sibling
   * model's quota once one is spent. It is a function of the parsed flags
   * because those reasons are flags (`--model`, `--rate`).
   */
  readonly labeler?: true | ((args: Args, config: Config) => LabelerOverrides);
  /**
   * The command itself. Returns an exit code, or nothing for 0.
   *
   * This is the half that is worth testing, and it is testable because
   * `runCommand` — not this — is what touches `process`, the environment and
   * the network.
   */
  run(context: CommandContext): Promise<number | void>;
}

/**
 * Run one operator command: parse, configure, connect, run, close, exit.
 *
 * Called from a `*-cli.ts` file and from nowhere else. The filenames are load
 * bearing — `apps/api/package.json`'s scripts and `docs/chores.md` name them —
 * so the split is spec-and-`run` in `<name>-command.ts`, top-level await in
 * `<name>-cli.ts`.
 */
export async function runCommand(spec: CommandSpec): Promise<void> {
  const argv = process.argv.slice(2);

  // Before anything else, including the positional check: `pnpm chores --help`
  // must print the help rather than complain that no pass was named.
  if (argv.includes("--help")) {
    console.log(helpText(spec));
    process.exitCode = EXIT_OK;
    return;
  }

  let db: Kysely<Database> | undefined;
  try {
    const args = parseArgs(spec, argv);
    const config = loadConfig();
    if (spec.db) db = createConfiguredDb(config, spec.db);
    const labeler = spec.labeler
      ? createLabeler(
          config,
          undefined,
          undefined,
          spec.labeler === true ? {} : spec.labeler(args, config),
        )
      : undefined;

    const code = await spec.run(context(spec, args, config, db, labeler));
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    process.exitCode = report(spec, error);
  } finally {
    // The pool, always. Held open it keeps the process alive past the last line
    // of output, which is the cron contract `chores-cli.ts` states: run one
    // thing and exit, holding nothing.
    await db?.destroy();
  }
}

/** Stderr and an exit code, for whatever came out of the run. */
function report(spec: CommandSpec, error: unknown): number {
  if (error instanceof UsageError) {
    if (error.message !== "") console.error(error.message);
    if (error.withHelp) console.error(helpText(spec));
    return EXIT_USAGE;
  }
  if (error instanceof ConfigError) {
    console.error(error.message);
    return EXIT_CONFIG; // EX_CONFIG, as index.ts does
  }
  // The whole object, stack included. This is what an unhandled rejection at
  // the top level of these files already printed, and the stack is the entire
  // diagnostic for the failures that reach here.
  console.error(error);
  return EXIT_FAILED;
}

/**
 * The context, with `db` and `labeler` as getters.
 *
 * Getters rather than fields so a command that reaches for a dependency it did
 * not declare says so, instead of handing a `run` body `undefined` and letting
 * it surface three calls later as a null dereference inside Kysely.
 */
function context(
  spec: CommandSpec,
  args: Args,
  config: Config,
  db: Kysely<Database> | undefined,
  labeler: Labeler | undefined,
): CommandContext {
  return {
    args,
    config,
    get db(): Kysely<Database> {
      if (!db) throw new Error(`${spec.name} did not declare a database handle`);
      return db;
    },
    get labeler(): Labeler {
      if (!labeler) throw new Error(`${spec.name} did not declare a labeler`);
      return labeler;
    },
  };
}

/**
 * The command line against the spec.
 *
 * Unknown flags are refused rather than ignored, which is the one behaviour
 * here that is new. Ignoring them is how `--dryrun` silently ran a live merge
 * and how a renamed flag keeps "working" for a year: the old spelling parses to
 * nothing, the default applies, and the run looks fine.
 */
export function parseArgs(spec: CommandSpec, argv: readonly string[]): Args {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    // `runCommand` has already acted on it; every command has it, and no
    // command declares it.
    if (arg === "--help") continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const declared = spec.flags[name];
    if (!declared) {
      throw new UsageError(`unknown flag: --${name}`, { help: true });
    }
    if (declared.kind === "boolean") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      booleans.add(name);
    } else {
      // An empty value is refused for the same reason a missing one is, and it
      // is the likelier of the two: `--model=$MODEL` with `$MODEL` unset is a
      // wrapper script's ordinary failure, and it arrives here as `--model=`.
      // Kept as a refusal rather than treated as absent because the merge below
      // it uses `??`, which does not catch the empty string — an unset variable
      // would otherwise become a DELIBERATE override of the configured value,
      // and `createLabeler` would build a client on a model named "".
      if (eq === -1 || body.length === eq + 1) {
        throw new UsageError(`--${name} needs a value: --${name}=${declared.placeholder}`);
      }
      values.set(name, body.slice(eq + 1));
    }
  }

  if (spec.positional) {
    const [only] = positionals;
    const named = positionals.length === 1 && only !== undefined;
    if (!named || !spec.positional.values.includes(only)) throw new UsageError();
  } else if (positionals.length > 0) {
    throw new UsageError(`unexpected argument: ${positionals[0]}`, { help: true });
  }

  const declaredOf = (name: string, kind: FlagSpec["kind"]): void => {
    const flag = spec.flags[name];
    if (!flag || flag.kind !== kind) {
      throw new Error(`${spec.name} read --${name} as a ${kind} flag, which it did not declare`);
    }
  };

  // One implementation behind the two overloads `Args.number` declares — the
  // cast is where "a fallback means it always returns a number" is asserted,
  // and it is asserted once rather than at every call site.
  const number = ((name: string, check: NumberCheck, options: NumberOptions = {}) => {
    declaredOf(name, "value");
    const raw = values.get(name);
    if (raw === undefined) return options.fallback;
    const value = Number(raw);
    if (!check.valid(value)) {
      throw new UsageError(check.message(name, raw) + (options.note ? ` ${options.note}` : ""));
    }
    return value;
  }) as Args["number"];

  return {
    positionals,
    boolean(name) {
      declaredOf(name, "boolean");
      return booleans.has(name);
    },
    value(name) {
      declaredOf(name, "value");
      return values.get(name);
    },
    number,
  };
}

/** `--help`, and the usage text a refusal prints. Generated from the spec. */
export function helpText(spec: CommandSpec): string {
  const lines = [`usage: ${spec.name} ${spec.synopsis}`];
  if (spec.details !== undefined) {
    lines.push(spec.details);
  } else {
    const names = Object.keys(spec.flags);
    if (names.length > 0) {
      const shown = names.map((name) => {
        const flag = spec.flags[name] as FlagSpec;
        return flag.kind === "boolean" ? `--${name}` : `--${name}=${flag.placeholder}`;
      });
      const width = Math.max(...shown.map((text) => text.length));
      lines.push("");
      for (const [index, name] of names.entries()) {
        const flag = spec.flags[name] as FlagSpec;
        lines.push(`  ${(shown[index] as string).padEnd(width)}  ${flag.describe}`);
      }
    }
  }
  // Last, and for every command including the two that write their own table:
  // an operator who has just been refused should learn from the refusal that
  // there is a fuller answer, and `chores` and `measure:deepening-yield` have
  // been printing a usage block without one for as long as they have existed.
  lines.push("");
  lines.push("  --help  print this and exit");
  return lines.join("\n");
}
