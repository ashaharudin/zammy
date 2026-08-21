import { loadConfig } from "@zammy/config";
import { rebuildStoryDf, readStoryDf } from "@zammy/storage";
import { storyDfDay, trailingWindow } from "./story-df.js";
import { createConfiguredDb } from "./wiring.js";

/**
 * `pnpm story:df [--rebuild] [--days=N] [--language=en]` — the trailing
 * corpus's operator command (ADR-0011).
 *
 * `--rebuild` recomputes the span's day buckets from `articles`, which is what
 * fills the table over an archive that predates it and what repairs a window
 * whose increments were interrupted. Without it the command is READ-ONLY and
 * reports the window as the linker would see it: corpus size, vocabulary size,
 * and the df of the tokens rarity decisions actually turn on.
 *
 * The report is the point. A df table nobody has looked at is a threshold
 * nobody has measured, and this repo's rule is that no threshold ships
 * unmeasured (§14.3's post-mortem).
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const rebuild = args.includes("--rebuild");

const days = Number(flag("days") ?? 31);
if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

const config = loadConfig();
const language = flag("language") ?? config.DEFAULT_LANGUAGE;
const dfConfig = {
  windowDays: config.STORYLINE_DF_WINDOW_DAYS,
  timeZone: config.APP_TIMEZONE,
};
const db = createConfiguredDb(config);

try {
  const now = new Date();

  if (rebuild) {
    const from = new Date(now.getTime() - days * 86_400_000);
    const startedAt = Date.now();
    const result = await rebuildStoryDf(db, {
      from,
      to: new Date(now.getTime() + 86_400_000),
      timeZone: config.APP_TIMEZONE,
    });
    console.log(
      `rebuilt ${result.days} day-language buckets, ${result.tokens} token rows, ` +
        `${result.articles} articles counted, in ${Date.now() - startedAt}ms`,
    );
  }

  // ---- the window as the linker will see it ----
  const window = trailingWindow(now, dfConfig);
  console.log(
    `\ntrailing window (${dfConfig.windowDays}d, ${config.APP_TIMEZONE}, language=${language}): ` +
      `${window.from} … ${window.to}`,
  );

  const corpus = await db
    .selectFrom("story_corpus_days")
    .select(["day", "articles"])
    .where("language", "=", language)
    .where("day", ">=", window.from)
    .where("day", "<=", window.to)
    .orderBy("day")
    .execute();
  const total = corpus.reduce((sum, row) => sum + row.articles, 0);
  console.log(`corpus: ${total} articles over ${corpus.length} days`);
  for (const row of corpus) console.log(`  ${row.day}  ${row.articles}`);

  const vocabulary = await db
    .selectFrom("story_token_days")
    .select((eb) => [
      eb.fn.countAll<string>().as("rows"),
      eb.fn.count<string>("token").distinct().as("tokens"),
    ])
    .where("language", "=", language)
    .where("day", ">=", window.from)
    .where("day", "<=", window.to)
    .executeTakeFirstOrThrow();
  console.log(
    `vocabulary: ${vocabulary.tokens} distinct tokens in ${vocabulary.rows} day rows`,
  );

  // The head of the distribution: what a token has to beat to be beat
  // vocabulary rather than a name. ADR-0009's benchmark was "trump" at ~20% of
  // any day; the trailing corpus should say something similar.
  const head = await db
    .selectFrom("story_token_days")
    .select(["token", (eb) => eb.fn.sum<string>("df").as("df")])
    .where("language", "=", language)
    .where("day", ">=", window.from)
    .where("day", "<=", window.to)
    .groupBy("token")
    .orderBy("df", "desc")
    .orderBy("token")
    .limit(20)
    .execute();
  console.log("\nmost common tokens (df, share of corpus):");
  for (const row of head) {
    const df = Number(row.df);
    console.log(`  ${row.token.padEnd(24)} ${String(df).padStart(6)}  ${share(df, total)}`);
  }

  // Stability: the same lookup over each of the last `windowDays` days'
  // windows. A df that swings wildly as the window slides is a threshold that
  // cannot be pinned, so this is the number S3's sweep depends on.
  const probes = (flag("tokens") ?? "leavitt,epstein,trump,ukraine,tariff")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  console.log(`\nprobe tokens across sliding windows (df / corpus = share):`);
  console.log(`  window ending      corpus  ${probes.map((t) => t.padStart(12)).join("")}`);
  for (let back = 0; back < Math.min(days, 14); back += 1) {
    const at = new Date(now.getTime() - back * 86_400_000);
    const slice = trailingWindow(at, dfConfig);
    const read = await readStoryDf(db, {
      language,
      from: slice.from,
      to: slice.to,
      tokens: probes,
    });
    const cells = probes
      .map((token) => share(read.df.get(token) ?? 0, read.size).padStart(12))
      .join("");
    console.log(`  ${storyDfDay(at, dfConfig)}      ${String(read.size).padStart(6)}${cells}`);
  }

  // What the lookup costs, since it runs once per arriving group (~1,200/day).
  const sample = await db
    .selectFrom("articles")
    .select("story_tokens")
    .where("language", "=", language)
    .orderBy("published", "desc")
    .limit(1)
    .executeTakeFirst();
  const probe = sample?.story_tokens ?? probes;
  const runs = 20;
  const startedAt = Date.now();
  for (let i = 0; i < runs; i += 1) {
    await readStoryDf(db, {
      language,
      from: window.from,
      to: window.to,
      tokens: probe,
    });
  }
  console.log(
    `\nlookup: ${probe.length} tokens over the window, ` +
      `${((Date.now() - startedAt) / runs).toFixed(1)}ms mean over ${runs} runs`,
  );
} finally {
  await db.destroy();
}

function share(df: number, size: number): string {
  if (size === 0) return "—";
  return `${df} (${((df / size) * 100).toFixed(2)}%)`;
}
