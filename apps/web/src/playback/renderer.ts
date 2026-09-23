import type { Point } from "./layout.js";
import { GLYPH_H, textPixels, textWidth } from "./pixelFont.js";
import { SPRITES, frameRGBA, type SpriteId } from "./sprites.js";

/**
 * The playback stage's ONLY canvas code (ADR-0029, "The canvas is decoration; the words are
 * the page"): a loop over a display list.
 *
 * Everything the stage shows is decided upstream as plain data — `drawList.ts` turns a frame
 * of the choreography into `DrawOp`s, and its tests pin what those ops say (text in ink, never
 * palette; integer coordinates; every sprite id real). This module only executes them, which
 * is why it has no test of its own beyond type-checking: there is no decision left in it to
 * get wrong, and `apps/web` tests run in node with no canvas (web-conventions: the renderer is
 * the one piece that needs a browser, so it is kept to the piece that cannot be avoided).
 *
 * Pixel-art rules it enforces: `imageSmoothingEnabled = false` on EVERY paint (resizing a
 * canvas resets its context state, so setting it once at mount is not enough), everything in
 * logical pixels under one `setTransform(backingScale)`, and coordinates rounded to whole
 * logical pixels, so a sprite never straddles a pixel boundary and blurs.
 *
 * Deliberately not here: layout, colour choice, animation timing, and any caching of a painted
 * floor. A frame is a few hundred `fillRect`s and forty-odd `drawImage`s; repainting it whole
 * is simpler than invalidation and far inside a frame's budget.
 *
 * `DrawOp` is declared HERE rather than in `drawList.ts` only because of build order: the
 * renderer was written before the display list, and `drawList.ts` imports this type and
 * re-exports it, so both halves of the display list's contract meet in the module that
 * executes it.
 */

/**
 * One instruction to the stage, in logical pixels (the layout's 320×180 or 160×240 grid).
 * - `rect`: a filled rectangle.
 * - `sprite`: a sprite frame whose top-left is (x, y) — the anchor is already applied —
 *   mirrored horizontally about its own box when `flip` (art faces right).
 * - `text`: already-normalised text (`normaliseForFont`) with its top-left at (x, y), in the
 *   pixel font; `plate`, when set, is a backing rectangle 1 px larger on every side.
 * - `dots`: single pixels, for the overview's dotted route.
 */
export type DrawOp =
  | { op: "rect"; x: number; y: number; w: number; h: number; colour: string }
  | { op: "sprite"; id: SpriteId; frame: number; x: number; y: number; flip: boolean }
  | { op: "text"; text: string; x: number; y: number; colour: string; plate: string | null }
  | { op: "dots"; points: readonly Point[]; colour: string };

/** Every sprite frame, pre-rendered once into an image the stage can `drawImage`. */
export interface SpriteAtlas {
  get(id: SpriteId, frame: number): CanvasImageSource;
}

/**
 * Builds the atlas: one small canvas per sprite frame, filled by `putImageData` from
 * `frameRGBA`, all up front (about forty canvases, a few KB of pixels) so the paint loop never
 * decodes art. `get` takes the frame modulo the sprite's frame count, so an animation can pass
 * a running counter (the oracle's glow, the belt's scroll) without knowing how many there are.
 * A canvas whose 2D context is unavailable stays blank rather than throwing; the page already
 * falls back to the step list when the stage's own context is null.
 */
export function createAtlas(doc: Document): SpriteAtlas {
  const images = new Map<SpriteId, readonly HTMLCanvasElement[]>();
  for (const id of Object.keys(SPRITES) as SpriteId[]) {
    const sprite = SPRITES[id];
    images.set(
      id,
      sprite.frames.map((_, frame) => {
        const canvas = doc.createElement("canvas");
        canvas.width = sprite.w;
        canvas.height = sprite.h;
        const ctx = canvas.getContext("2d");
        if (ctx !== null) {
          const image = ctx.createImageData(sprite.w, sprite.h);
          image.data.set(frameRGBA(sprite, frame));
          ctx.putImageData(image, 0, 0);
        }
        return canvas;
      }),
    );
  }
  return {
    get(id, frame) {
      const all = images.get(id);
      if (all === undefined || all.length === 0) throw new Error(`no sprite ${id}`);
      return all[((Math.trunc(frame) % all.length) + all.length) % all.length]!;
    },
  };
}

/**
 * Paints one frame: resets the transform to `backingScale` (logical → backing pixels), turns
 * smoothing off, clears the whole canvas to `clearColour`, then draws `ops` in order — later
 * ops on top. Text is one 1×1 `fillRect` per lit pixel of the font, after its optional plate.
 */
export function paint(
  ctx: CanvasRenderingContext2D,
  ops: readonly DrawOp[],
  atlas: SpriteAtlas,
  backingScale: number,
  clearColour: string,
): void {
  ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = clearColour;
  ctx.fillRect(0, 0, ctx.canvas.width / backingScale, ctx.canvas.height / backingScale);

  for (const op of ops) {
    switch (op.op) {
      case "rect": {
        ctx.fillStyle = op.colour;
        ctx.fillRect(Math.round(op.x), Math.round(op.y), Math.round(op.w), Math.round(op.h));
        break;
      }
      case "sprite": {
        const image = atlas.get(op.id, op.frame);
        const x = Math.round(op.x);
        const y = Math.round(op.y);
        if (op.flip) {
          ctx.save();
          ctx.translate(x + SPRITES[op.id].w, y);
          ctx.scale(-1, 1);
          ctx.drawImage(image, 0, 0);
          ctx.restore();
        } else {
          ctx.drawImage(image, x, y);
        }
        break;
      }
      case "text": {
        const x = Math.round(op.x);
        const y = Math.round(op.y);
        if (op.plate !== null) {
          ctx.fillStyle = op.plate;
          ctx.fillRect(x - 1, y - 1, textWidth(op.text) + 2, GLYPH_H + 2);
        }
        ctx.fillStyle = op.colour;
        for (const p of textPixels(op.text)) ctx.fillRect(x + p.x, y + p.y, 1, 1);
        break;
      }
      case "dots": {
        ctx.fillStyle = op.colour;
        for (const p of op.points) ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
        break;
      }
    }
  }
}
