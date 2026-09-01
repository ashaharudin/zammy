import { runCommand } from "./operator-command.js";
import { spec } from "./storyline-coherence-command.js";

/**
 * The entrypoint `pnpm measure:storyline-coherence` runs. The command itself is
 * in `storyline-coherence-command.ts` — see `operator-command.ts` for the split.
 */
await runCommand(spec);
