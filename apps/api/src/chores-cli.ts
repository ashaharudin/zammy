import { spec } from "./chores-command.js";
import { runCommand } from "./operator-command.js";

/**
 * The entrypoint `pnpm chores` runs, and the one Compose and a laptop invoke.
 * The chore itself is in `chores-command.ts` — see `operator-command.ts` for
 * why the two are split, and for the exit codes this file's contract with the
 * scheduler fixed.
 */
await runCommand(spec);
