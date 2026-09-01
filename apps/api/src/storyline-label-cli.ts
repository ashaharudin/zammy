import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-label-command.js";

/**
 * The entrypoint `pnpm label:storylines` runs. The command itself is in
 * `storyline-label-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
