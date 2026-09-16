import path from "node:path";
import { readFile } from "node:fs/promises";
import { bootOnce, configOrExplain } from "./cron-route.js";
import { renderStorylinePage, type StorylinePageDeps } from "./render-storyline.js";
import { createConfiguredDb } from "./wiring.js";
import type { VercelHandler } from "./vercel.js";

/**
 * The Vercel entrypoint for `/storyline/<uuid>/<slug>` (Tier 2 SEO,
 * `docs/SEO.md`). `api/storyline.ts` is the three-line file Vercel discovers;
 * everything real is here, the same split `vercel.ts` uses for the Fastify
 * surface and for the same reason — this is the one source in `api/` no `tsc`
 * covers.
 *
 * A raw handler rather than a Fastify route, and deliberately not a route
 * added to the existing app `vercel.ts` boots: that app's whole shape is built
 * around `emit("request")` handing a socket to Fastify, and everything this
 * page needs — a database and a clock — is a strict subset of what booting
 * Fastify would pull in (the labeler, the ingest queue, a Currents client, the
 * rate limiter). Booting the smaller thing is also booting the cheaper thing,
 * which matters more here than on `/api/v1/*`: this is the entrypoint a
 * crawler's very first, unauthenticated request to the site is likeliest to
 * hit.
 */

interface Ready {
  deps: StorylinePageDeps;
  /** `apps/web/dist/index.html`, read once per warm instance and never again. */
  template: string;
}

/**
 * `apps/web/dist/index.html`, as `vercel.json`'s `includeFiles: "apps/web/dist/**"`
 * bundles it alongside this function.
 *
 * `process.cwd()` is the project root in that bundle, the same convention
 * `FIXTURES_DIR`'s own default (`"./fixtures"`) already relies on for
 * `includeFiles: "fixtures/**"` — both are read relative to where Vercel
 * actually runs the function, which is not where a local `pnpm dev` would run
 * this same source from.
 */
function templatePath(): string {
  return path.join(process.cwd(), "apps/web/dist/index.html");
}

async function bootFromEnvironment(): Promise<Ready> {
  // Same message on the same failure as every other entrypoint
  // (`configOrExplain`'s own comment): every problem at once, not one 401 per
  // missing variable.
  const config = configOrExplain();
  return {
    deps: {
      // A small pool: this function reads one storyline per request and
      // nothing here fans out, unlike the request path's pool sized for the
      // planner's own concurrent work. `keepalive.ts` makes the same call for
      // the same reason.
      db: createConfiguredDb(config, { max: 2 }),
      now: () => new Date(),
      config: { grouping: { timeZone: config.APP_TIMEZONE } },
    },
    template: await readFile(templatePath(), "utf8"),
  };
}

export function createStorylineHandler(boot: () => Promise<Ready>): VercelHandler {
  // Once per instance, forgetting a failure so the next request tries again —
  // `bootOnce`'s own comment has the argument, and it applies unchanged here:
  // what fails at boot (Postgres reachable, the built `dist/index.html`
  // present) is transient or a bad deploy, not a reason to wedge an instance
  // that will serve requests for hours.
  const ready = bootOnce(boot);

  return async (request, response) => {
    let state: Ready;
    try {
      state = await ready();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("storyline render: boot failed:", message);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "unavailable" }));
      return;
    }

    try {
      const page = await renderStorylinePage(state.deps, {
        path: request.url ?? "/",
        template: state.template,
      });
      response.writeHead(page.status, page.headers);
      response.end(page.body);
    } catch (error) {
      // A throw here is a live-request failure (the database dropped a
      // connection mid-read), not a boot problem — `bootOnce` already forgot
      // nothing, because nothing about the BOOT failed. A plain 500 with no
      // page body: the alternative is serving a half-built HTML document,
      // which is a worse thing for a crawler to index than an honest error.
      const message = error instanceof Error ? error.message : String(error);
      console.error("storyline render: request failed:", message);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "internal error" } }));
    }
  };
}

export default createStorylineHandler(bootFromEnvironment);
