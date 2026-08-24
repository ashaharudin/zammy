/**
 * The Vercel request function. Vercel discovers functions in `api/` at the
 * PROJECT root, which is why this file lives outside the workspace it serves —
 * and why it is three lines: everything real is in `apps/api/src/vercel.ts`,
 * where the workspace typechecks and tests it. This file is the only source in
 * the repository no `tsc` covers, so it must stay small enough to read.
 *
 * Routing to it is `vercel.json`'s two rewrites, not this filename. The scope
 * doc originally specified `api/[...path].ts`; the spike found Vercel parses
 * that as ONE dynamic segment literally named `...path`, which 404ed every
 * `/api/v1/<something>/<more>` before the function ever ran.
 */
import handler from "@zammy/api/vercel";

export default handler;
