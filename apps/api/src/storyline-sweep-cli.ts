import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-sweep-command.js";

/**
 * The entrypoint `pnpm measure:storylines-v2` runs. The command itself is in
 * `storyline-sweep-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
