import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-label-merge-command.js";

/**
 * The entrypoint `pnpm merge:storyline-labels` runs. The command itself is in
 * `storyline-label-merge-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
