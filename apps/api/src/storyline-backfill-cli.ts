import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-backfill-command.js";

/**
 * The entrypoint `pnpm backfill:storylines` runs. The command itself is in
 * `storyline-backfill-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
