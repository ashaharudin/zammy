import { spec } from "./deepening-yield-command.js";
import { runCommand } from "./operator-command.js";

/**
 * The entrypoint `pnpm measure:deepening-yield` runs. The command itself is in
 * `deepening-yield-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
