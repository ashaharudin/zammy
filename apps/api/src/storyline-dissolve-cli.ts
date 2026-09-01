import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-dissolve-command.js";

/**
 * The entrypoint `pnpm dissolve:storyline-piles` runs. The command itself is in
 * `storyline-dissolve-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
