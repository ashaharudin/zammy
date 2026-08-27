const GLYPH_SIDE = 4;
// Diagonal stagger (row+col) so the ripple travels corner-to-corner rather than
// row-by-row — reads as one wave instead of a scan line.
const GLYPH_CELLS = Array.from({ length: GLYPH_SIDE * GLYPH_SIDE }, (_, i) => ({
  key: i,
  delay: (Math.floor(i / GLYPH_SIDE) + (i % GLYPH_SIDE)) * 0.09,
}));

/**
 * The app's one "still working" mark: a 4×4 relative of `SizeGlyph`
 * (StorylinePills) — same currentColor squares on a CSS grid — but animated
 * rather than a static fill level, since there is nothing yet to count.
 *
 * Sizeless and colorless by default (`currentColor`, no positioning): callers
 * set `cell`/`gap` for the footprint they need and wrap it for placement,
 * rather than this component guessing where it will be dropped.
 */
export function LoadingGlyph({ cell = 8, gap = 3 }: { cell?: number; gap?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${GLYPH_SIDE}, ${cell}px)`,
        gridTemplateRows: `repeat(${GLYPH_SIDE}, ${cell}px)`,
        gap: `${gap}px`,
      }}
    >
      {GLYPH_CELLS.map((c) => (
        <span
          key={c.key}
          className="cloud-loading-cell"
          style={{
            background: "currentColor",
            borderRadius: "2px",
            animationDelay: `${c.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
