import { runCommand } from "./operator-command.js";
import { spec } from "./regroup-command.js";

/**
 * The entrypoint `pnpm regroup` runs. The command itself is in
 * `regroup-command.ts` — see `operator-command.ts` for why the two are split.
 */
await runCommand(spec);
