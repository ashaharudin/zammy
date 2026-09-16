import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TimelineQuery, TrendingQuery } from "@zammy/shared";

/**
 * `apps/web/public/llms.txt` is a file whose entire content is CLAIMS about
 * this repository — these endpoints exist, they take these parameters, these
 * paths are routed. It is also the one file nothing in the app ever loads, so
 * every one of those claims is free to stop being true in complete silence,
 * and the only reader who finds out is an agent that trusted it.
 *
 * The same argument `cron-routes.test.ts` makes about `vercel.json`, and the
 * same remedy: assert the facts rather than describe them. Nothing here checks
 * prose — only the URLs, which are the part that can be wrong in a way that
 * wastes somebody's request.
 *
 * Deliberately offline. The example storyline UUID is real and may be merged
 * away or age out of the window, and that is FINE — a merged id answers 301 to
 * its survivor — so nothing here asks a database or a network whether it still
 * resolves.
 */
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

const llms = readFileSync(here("../../web/public/llms.txt"), "utf8");
const routes = readFileSync(here("./routes.ts"), "utf8");
const vercel = JSON.parse(readFileSync(here("../../../vercel.json"), "utf8")) as {
  rewrites: Array<{ source: string; destination: string }>;
};

const ORIGIN = "https://www.zammy.info";

/** Every link in the file, as a URL. */
const links = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => new URL(m[1]!));

describe("llms.txt, as a set of claims about this repo", () => {
  it("links to something", () => {
    // The guard on the guard: a rewrite of the file that broke the link syntax
    // would otherwise make every assertion below vacuously true.
    expect(links.length).toBeGreaterThan(5);
  });

  it("uses the canonical origin everywhere", () => {
    // The apex 308s to www and `render-storyline.ts`'s SITE_ORIGIN is the www
    // form. A link to the apex would work and would cost every reader of this
    // file one redirect to learn what the file could have said outright.
    for (const url of links) expect(url.origin, url.href).toBe(ORIGIN);
  });

  it("names only API paths this app actually registers", () => {
    // Matched on the first segment rather than the whole path, so
    // `/api/v1/topics/` — documented as a prefix a fingerprint is appended to —
    // checks against `/api/v1/topics/:fingerprint` without this test having to
    // know Fastify's parameter syntax.
    const apiPaths = links.filter((url) => url.pathname.startsWith("/api/v1/"));
    expect(apiPaths.length).toBeGreaterThan(0);
    for (const url of apiPaths) {
      const segment = url.pathname.split("/")[3];
      expect(routes, `${url.pathname} is not registered in routes.ts`).toContain(
        `"/api/v1/${segment}`,
      );
    }
  });

  it("gives every example query the real schema accepts", () => {
    // The claim most likely to rot and least likely to be noticed: a parameter
    // renamed or tightened leaves this file advertising a request that now
    // 400s. Parsed with the SAME Zod the route parses with, not a copy.
    const byPath: Record<string, { safeParse: (input: unknown) => { success: boolean } }> = {
      "/api/v1/timeline": TimelineQuery,
      "/api/v1/trending": TrendingQuery,
    };
    const examples = links.filter((url) => url.search !== "" && url.pathname in byPath);
    expect(examples.length).toBeGreaterThan(0);
    for (const url of examples) {
      const query = Object.fromEntries(url.searchParams);
      const result = byPath[url.pathname]!.safeParse(query);
      expect(result.success, `${url.href} does not parse as ${url.pathname}'s query`).toBe(true);
    }
  });

  it("names only page paths vercel.json routes", () => {
    // `/storyline/<uuid>/<slug>` and `/sitemap.xml` are rewrites, not Fastify
    // routes — a claim about a configuration file, which is exactly the kind
    // that stops being true quietly.
    const sources = vercel.rewrites.map((rule) => rule.source);
    const routed = links.filter(
      (url) => url.pathname.startsWith("/storyline/") || url.pathname === "/sitemap.xml",
    );
    expect(routed.length).toBeGreaterThan(0);
    for (const url of routed) {
      const matched = sources.some((source) =>
        new RegExp(`^${source.replace(/\(\.\*\)/g, ".*")}$`).test(url.pathname),
      );
      expect(matched, `${url.pathname} matches no rewrite in vercel.json`).toBe(true);
    }
  });

  it("names only static files that ship", () => {
    // `/` is the app itself; everything else flat must exist in `public/`,
    // which Vite copies to the dist root verbatim.
    const statics = links.filter(
      (url) =>
        url.pathname !== "/" &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/storyline/") &&
        url.pathname !== "/sitemap.xml",
    );
    for (const url of statics) {
      expect(() => readFileSync(here(`../../web/public${url.pathname}`)), url.pathname).not.toThrow();
    }
  });
});
