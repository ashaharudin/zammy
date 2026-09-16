/**
 * The pretty half of a storyline URL: `/storyline/<uuid>/<slug>`.
 *
 * The UUID is identity — everything that resolves a storyline (`resolveStoryline`,
 * `merged_into`) works from it alone, and nothing here changes that. The slug
 * exists only so the URL a reader shares says something before they click it,
 * which is also why nothing in this repo TREATS it as identity: the browser
 * (`apps/web/src/route.ts`) and the server (`apps/api/src/render-storyline.ts`)
 * both parse a storyline path by taking the UUID segment and ignoring whatever
 * follows it. A slug minted from a label that has since changed, or a slug this
 * function's next version spells differently, still opens the same storyline.
 *
 * Shared between the two rather than reimplemented on each side so a link the
 * browser builds and the one the sitemap or the render function builds for the
 * same storyline usually agree — "usually" because neither side needs them to,
 * only because it would be a strange link to share otherwise.
 */

/**
 * `label` folded to `[a-z0-9-]+`, or `"storyline"` when nothing is left to fold.
 *
 * NFKD-then-strip-combining-marks before the fold, so an accented label
 * (`"Niño"`) survives as letters (`nino`) rather than being thrown out by the
 * `[^a-z0-9]` pass that follows it — which would otherwise fold every accented
 * word to nothing, the same way a non-Latin label already does. That second
 * case (Arabic, CJK, …) has no Latin letters to fall back to, and "storyline"
 * is what a route matcher reads as a real segment rather than a path one level
 * short — an empty segment in `/storyline/<uuid>/` is not obviously the same
 * URL as `/storyline/<uuid>/storyline` to a reader comparing the two by eye.
 */
export function slugifyStoryline(label: string | null): string {
  const slug = (label ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "storyline";
}

/** `/storyline/<uuid>/<slug>` — the one place the shape is written down. */
export function storylinePath(id: string, label: string | null): string {
  return `/storyline/${id}/${slugifyStoryline(label)}`;
}
