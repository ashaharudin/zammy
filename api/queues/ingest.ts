/**
 * The §9.1 ingest consumer. Vercel discovers functions in `api/` at the PROJECT
 * root, which is why this file lives outside the workspace it serves — and why
 * it is three lines: everything real is in `apps/api/src/vercel-queue.ts`,
 * where the workspace typechecks and tests it.
 *
 * Nothing routes to this path. It is reached only by the `queue/v2beta` trigger
 * `vercel.json` declares against it, which is what makes it air-gapped: no
 * public URL, and therefore no auth code in the handler.
 */
import handler from "@zammy/api/vercel-queue";

export default handler;
