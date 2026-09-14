import { spec } from "./storyline-profiles-backfill-command.js";
import { runCommand } from "./operator-command.js";

/**
 * The entrypoint `pnpm backfill:storyline-profiles` runs. The command itself is
 * in `storyline-profiles-backfill-command.ts`, which imports without connecting
 * to anything — see `operator-command.ts`.
 */
await runCommand(spec);
