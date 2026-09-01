import { runCommand } from "./operator-command.js";
import { spec } from "./story-df-command.js";

/**
 * The entrypoint `pnpm story:df` runs. The command itself is in
 * `story-df-command.ts` — see `operator-command.ts` for why the two are split.
 */
await runCommand(spec);
