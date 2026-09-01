import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-summary-command.js";

/**
 * The entrypoint `pnpm summaries:storylines` runs. The command itself is in
 * `storyline-summary-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
