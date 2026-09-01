import { spec } from "./label-words-backfill-command.js";
import { runCommand } from "./operator-command.js";

/**
 * The entrypoint `pnpm backfill:label-words` runs. The command itself is in
 * `label-words-backfill-command.ts`, which imports without connecting to
 * anything — see `operator-command.ts`.
 */
await runCommand(spec);
