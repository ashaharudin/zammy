import type { RedisKeyClass, Station } from "@zammy/shared/request-trace";
import type { Point } from "./layout.js";
import { PALETTE, PALETTE_KEYS } from "./palette.js";

/**
 * The playback floor's art (ADR-0029, "It is the one exception to ARCHITECTURE §8.3's visual
 * rules"): every robot, parcel and machine the depot draws, as string literals — no image
 * files, no sprite-sheet request, no build step, and a diff of the art is a diff of text.
 *
 * **Format.** A frame is `h` strings of `w` characters. Each character is a `PALETTE_KEYS`
 * digit (`palette.ts`: `0` the outline, `9` blue, `3` orange, …) or `.` for transparent, so
 * the picture is visible in this file with a squint. `decodeFrame` is the only reader, and it
 * throws on a ragged row or an unknown character rather than drawing a wrong pixel.
 *
 * **Geometry is pinned, not chosen here.** Sizes and frame counts are the `PINNED` table in
 * `sprites.test.ts`, because `layout.ts` places stations by footprint (`STATION_FOOTPRINT`)
 * without importing this file, and `drawList.test.ts` checks `SPRITES[STATION_SPRITE[s]]`
 * against `STATION_FOOTPRINT[s]`: a sprite redrawn at another size fails both. Every
 * anchor is bottom-centre, `{ x: floor(w / 2), y: h }`: an actor's anchor is its feet and a
 * station's is the middle of its base, so `layout.ts` can think in floor positions alone.
 *
 * **Style**: the look of an SNES-era sim rather than a diagram. One dark outline colour
 * around every silhouette so it reads on the light floor and the dark one alike; light from
 * the top-left, so each material has one highlight and one shadow tone (blue metal `a/9/8`,
 * steel `d/e/f`, orange `4/3/2`, green `5/6/7`, red `3/2/1`); dithering only for the oracle's
 * glow. Art faces RIGHT; `drawList` flips it for `facing: -1`.
 *
 * **How it was drawn.** The robots, props and the rack's bin tile are hand-placed pixels. The
 * larger machines were blocked in with a scratch painter (rects, discs, an auto-outline pass)
 * and then pasted here as literals, so what ships is plain text an editor can touch up by hand.
 * A few sprites are COMPOSED at load from literal parts where the repetition is the point:
 * walk frames (one body, four leg poses), the rack (one bin tile, ten colours), the belt (one
 * cleat pattern, four offsets). That costs a few hundred string operations once per chunk load.
 *
 * Deliberately not here: any colour that is not the palette (text is `Ink`, never a sprite),
 * any canvas code (`renderer.ts` turns frames into images), and any knowledge of WHEN a frame
 * shows — which walk frame, which glow — beyond the frame order documented on each sprite.
 */

/** Every sprite the floor can draw. Stations map onto these through `STATION_SPRITE`. */
export type SpriteId =
  | "runner"
  | "helper"
  | "worker"
  | "ticket"
  | "parcel"
  | "crate"
  | "padlock"
  | "door"
  | "awning"
  | "turnstile"
  | "rack"
  | "vault"
  | "mast"
  | "hatch"
  | "kiosk"
  | "oracle"
  | "belt"
  | "stamp_ok"
  | "stamp_fail"
  | "dust"
  | "gear";

/**
 * One sprite: its size, its anchor (bottom-centre, see above), and its frames. A frame is an
 * array of `h` rows of `w` palette characters; `frames.length` is the frame count.
 */
export interface Sprite {
  w: number;
  h: number;
  anchor: Point;
  frames: readonly (readonly string[])[];
}

type Rows = readonly string[];

/** A sprite with the pinned bottom-centre anchor. */
function sprite(w: number, h: number, frames: readonly Rows[]): Sprite {
  return { w, h, anchor: { x: Math.floor(w / 2), y: h }, frames };
}

const blank = (w: number): string => ".".repeat(w);

// ── the robots ──────────────────────────────────────────────────────────────
//
// Both are 12×16 with the same skeleton — a 9-row head, a 4-row torso with an arm on each
// side, 3 rows of legs — so their walk cycles line up, and different everywhere a reader
// looks first: the runner is blue with an antenna and a visor, the worker orange with a hard
// hat and goggles. Frame 0 stands; frames 1–4 walk (left foot up, both down, right foot up,
// both down). On the "both down" frames the whole upper body drops one pixel — the bob —
// and each arm swings opposite its leg.

const RUNNER_HEAD: Rows = [
  ".....00.....",
  "....0440....",
  ".....00.....",
  "..00000000..",
  ".0caaaaaa90.",
  ".0a99000000.",
  ".0a9900cb00.",
  ".0888888880.",
  "..00000000..",
];

const RUNNER_TORSO: Rows = [
  "..0a999980..",
  "..0a944980..",
  "..0a888880..",
  "..00000000..",
];

const WORKER_HEAD: Rows = [
  "............",
  "...000000...",
  "..0c444440..",
  "..044444430.",
  ".00000000000",
  "..03333330..",
  "..0300b0b00.",
  "..03333320..",
  "..02222220..",
];

const WORKER_TORSO: Rows = [
  "..04333320..",
  "..043dd320..",
  "..03222220..",
  "..00000000..",
];

/** Legs, per pose. Three rows standing or with a foot lifted; two when both are planted. */
interface LegSet {
  stand: Rows;
  leftUp: Rows;
  down: Rows;
  rightUp: Rows;
}

const RUNNER_LEGS: LegSet = {
  stand: ["..0de0.0de0.", "..0ef0.0ef0.", "..0000.00000"],
  leftUp: ["..0de0.0de0.", "..0000.0ef0.", ".......00000"],
  down: ["..0ef0.0ef0.", "..0000.00000"],
  rightUp: ["..0de0.0de0.", "..0ef0.0000.", "..0000......"],
};

const WORKER_LEGS: LegSet = {
  stand: ["..0fe0.0fe0.", "..0ef0.0ef0.", ".00000.00000"],
  leftUp: ["..0fe0.0fe0.", "..0000.0ef0.", ".......00000"],
  down: ["..0ef0.0ef0.", ".00000.00000"],
  rightUp: ["..0fe0.0fe0.", "..0ef0.0000.", ".00000......"],
};

/**
 * Paints one arm onto a robot's upper body: a dark cap over the shoulder, then shoulder,
 * forearm and hand, each an outline pixel outside a steel one. `shoulder` is the row the arm
 * hangs from — the torso's top row, plus one to swing it back or minus one to swing it forward.
 */
function paintArm(cells: string[][], shoulder: number, outer: number, inner: number): void {
  const put = (y: number, x: number, ch: string): void => {
    const row = cells[y];
    if (row !== undefined) row[x] = ch;
  };
  put(shoulder - 1, inner, "0");
  put(shoulder, outer, "0");
  put(shoulder, inner, "d");
  put(shoulder + 1, outer, "0");
  put(shoulder + 1, inner, "e");
  put(shoulder + 2, outer, "0");
  put(shoulder + 2, inner, "0");
}

/**
 * One robot frame: head and torso, an arm down each side (`leftDy`/`rightDy` swing them), and
 * the legs. A two-row leg set means "both feet down", so the whole upper body drops a pixel.
 */
function robotFrame(head: Rows, torso: Rows, legs: Rows, leftDy: number, rightDy: number): Rows {
  const cells = [...head, ...torso].map((row) => [...row]);
  paintArm(cells, head.length + leftDy, 0, 1);
  paintArm(cells, head.length + rightDy, 11, 10);
  const upper = cells.map((row) => row.join(""));
  return legs.length === 3 ? [...upper, ...legs] : [blank(12), ...upper, ...legs];
}

/** Frame 0 standing, then the four-frame walk cycle. */
function robotFrames(head: Rows, torso: Rows, legs: LegSet): Rows[] {
  return [
    robotFrame(head, torso, legs.stand, 0, 0),
    robotFrame(head, torso, legs.leftUp, 1, -1),
    robotFrame(head, torso, legs.down, 0, 0),
    robotFrame(head, torso, legs.rightUp, -1, 1),
    robotFrame(head, torso, legs.down, 0, 0),
  ];
}

/**
 * How many pixels the runner's and worker's body sits BELOW its standing height in each
 * frame — the bob. A carried ticket, parcel or crate drawn above the head should add this to
 * ride with the robot instead of floating still while it walks.
 */
export const WALK_BOB: readonly number[] = [0, 0, 1, 0, 1];

// The helper: a hovering drone, a green pod with one lens and a rotor, for calls still open
// alongside the runner. Frame 0 low with the rotor blade broadside, frame 1 a pixel higher
// with the blade edge-on; its shadow stays put on the floor, which is what sells the hover.

const HELPER_POD: Rows = [
  "...0000...",
  "..055660..",
  ".05566670.",
  ".0560cb70.",
  ".0660bb70.",
  ".06677770.",
  "..077770..",
  "...0000...",
];

const HELPER_FRAMES: readonly Rows[] = [
  [blank(10), ".0dddddd0.", "....00....", ...HELPER_POD, "...ffff..."],
  ["...0dd0...", "....00....", ...HELPER_POD, blank(10), "...ffff..."],
];

// ── things that get carried ─────────────────────────────────────────────────

/** The request, carried in: a paper ticket with an orange stub. */
const TICKET: Rows = ["000000", "03ccc0", "03eec0", "02ddd0", "000000"];

/** The response, carried out: a paper-wrapped parcel tied with red string. */
const PARCEL: Rows = [
  ".000000.",
  "0cc2ccd0",
  "0cc2cdd0",
  "02222220",
  "0dd2dde0",
  "0dd1dee0",
  ".000000.",
];

/** A job, riding the belt: a wooden crate with a diagonal brace. */
const CRATE: Rows = [
  "00000000",
  "04444420",
  "04333420",
  "04334220",
  "04342320",
  "04423320",
  "02222220",
  "00000000",
];

/** Hung on a lock bin while a single-flight lock is acquired or held: brass, steel shackle. */
const PADLOCK: Rows = [".000.", "0d0e0", "00000", "0c440", "04030", "03330", "00000"];

// ── marks and effects ───────────────────────────────────────────────────────

/** A job run's ✓ at the bay. */
const STAMP_OK: Rows = [
  ".00000.",
  "0566660",
  "06666c0",
  "0c66c60",
  "06cc660",
  "0677770",
  ".00000.",
];

/** A job run's ✗ at the bay. */
const STAMP_FAIL: Rows = [
  ".00000.",
  "0322220",
  "02c2c20",
  "022c220",
  "02c2c20",
  "0211110",
  ".00000.",
];

/** A puff kicked up by a robot's feet: frame 0 the puff, frame 1 the ring it spreads into. */
const DUST: readonly Rows[] = [
  ["....", ".dd.", "dccd", ".ee."],
  [".dc.", "d..c", "e..d", ".ee."],
];

/** "Thinking": a cog shown over an actor during a `think` step. */
const GEAR: Rows = ["..d.d..", ".ddddd.", "dd...de", ".d...e.", "dd...ee", ".eeeee.", "..e.e.."];

/**
 * One conveyor tile: a steel rail, the rubber belt with a cleat every 4 px, and the rollers.
 * Frame k shifts the cleats and rollers k pixels to the RIGHT, so cycling 0→3 runs the belt
 * toward the bay. Period 4 with a 1-px step, so all four frames are distinct and the motion
 * is smooth rather than a two-frame shuffle.
 */
function beltFrame(offset: number): Rows {
  const at = (i: number): number => (((i - offset) % 4) + 4) % 4;
  const cleats = (on: string, off: string): string =>
    Array.from({ length: 8 }, (_, i) => (at(i) === 0 ? on : off)).join("");
  const rollers = Array.from({ length: 8 }, (_, i) => (at(i) < 2 ? "e" : "0")).join("");
  return ["00000000", "dddddddd", cleats("d", "f"), cleats("e", "f"), "eeeeeeee", rollers];
}

// ── the Redis rack ──────────────────────────────────────────────────────────

/** A plastic bin's three tones, light to shadow. */
type Material = readonly [light: string, base: string, shadow: string];

const GREEN: Material = ["5", "6", "7"];
const BLUE: Material = ["a", "9", "8"];
const AQUA: Material = ["b", "a", "9"];
const RED: Material = ["3", "2", "1"];
const YELLOW: Material = ["c", "4", "3"];
const ORANGE: Material = ["4", "3", "2"];
const GREY: Material = ["d", "e", "f"];

/**
 * The rack's ten bins, left to right, in `RedisKeyClass.options` order — the order
 * `layout.ts` puts each class's `bins[key]` spot under (pinned by `sprites.test.ts`).
 * Colour-coded by what the key is FOR, so the four single-flight locks read as one red run
 * and the caches as blues; decorative only, the step list says which bin is which.
 */
const RACK_BINS: Readonly<Record<RedisKeyClass, Material>> = {
  reference: GREEN,
  page_cache: BLUE,
  trending_cache: AQUA,
  sample_lock: RED,
  fill_lock: RED,
  deepen_lock: RED,
  summarize_lock: RED,
  topic_budget: YELLOW,
  pending_ledger: ORANGE,
  other: GREY,
};

/** The bin order, exported so a test (and anyone placing things on the rack) can use it. */
export const RACK_BIN_ORDER: readonly RedisKeyClass[] = Object.keys(RACK_BINS) as RedisKeyClass[];

/** Each bin is 12 px wide, after a 2-px frame; bin i spans x ∈ [2 + 12i, 14 + 12i). */
export const RACK_BIN_WIDTH = 12;
export const RACK_FRAME_WIDTH = 2;

/**
 * One bin's 12-px column of the rack's middle band: a divider, a dark cubby, and a plastic
 * parts bin with a rim, its open top, a white label, and a shadowed base; then the shelf.
 * Interior columns 1–11 centre on column 6, which is `rackLeft + 8 + 12i` on the floor.
 */
function binColumn([light, base, shadow]: Material): Rows {
  const face = (inner: string): string => `0f0${light}${inner}${shadow}0f`;
  return [
    "0fffffffffff",
    "0f000000000f",
    `0f0${light.repeat(7)}0f`,
    `0f0${shadow.repeat(7)}0f`,
    face(base.repeat(5)),
    face("ccccc"),
    face("ceeec"),
    face("ccccc"),
    face(base.repeat(5)),
    face(base.repeat(5)),
    face(base.repeat(5)),
    face(base.repeat(5)),
    `0f0${shadow.repeat(7)}0f`,
    "0f000000000f",
    "0fffffffffff",
    "000000000000",
    "0ddddddddddd",
    "0eeeeeeeeeee",
    "000000000000",
  ];
}

/** 124 × 30: a steel top beam, ten bins between a lit left post and a shaded right one, feet. */
function rackRows(): Rows {
  const inner = 124 - 2;
  const top = [
    `.${"0".repeat(inner)}.`,
    `0c${"d".repeat(inner - 1)}0`,
    `0${"d".repeat(inner)}0`,
    `0${"e".repeat(inner)}0`,
    `0${"f".repeat(inner)}0`,
    "0".repeat(124),
  ];
  const columns = RACK_BIN_ORDER.map((key) => binColumn(RACK_BINS[key]));
  const middle = columns[0]!.map((_, y) => `0d${columns.map((c) => c[y]).join("")}f0`);
  const foot = "0".repeat(10);
  const base = [
    "0".repeat(124),
    `0${"e".repeat(inner)}0`,
    "0".repeat(124),
    `.${foot}${".".repeat(102)}${foot}.`,
    `.${foot}${".".repeat(102)}${foot}.`,
  ];
  return [...top, ...middle, ...base];
}

// ── the stations ────────────────────────────────────────────────────────────

/**
 * The rate limiter (16 × 24): a ticket-gate turnstile — a steel head unit with a lamp on a
 * post, and a bar across the lane. 0 idle (bar across, green lamp), 1 turning (the bar swung
 * diagonal), 2 blocked (the bar and the lamp red): the frame a 429 bounces off.
 */
const TURNSTILE: readonly Rows[] = [
  [
    "....00000000....",
    "...0ccdddddd0...",
    "...0dddddddd0...",
    "...0deeeeeef0...",
    "...0de0550ef0...",
    "...0de0660ef0...",
    "...0de0000ef0...",
    "...0deeeeeef0...",
    "...0ffffffff0...",
    "....000de000....",
    "......0de0......",
    ".000000de000000.",
    "0ccccccdecccccc0",
    "0ddddddeedddddd0",
    ".000000de000000.",
    "......0de0......",
    "......0de0......",
    "......0de0......",
    "......0de0......",
    "......0de0......",
    "...0000de0000...",
    "..0cddddddddd0..",
    "..0eeeeeeeeee0..",
    "...0000000000...",
  ],
  [
    "....00000000....",
    "...0ccdddddd0...",
    "...0dddddddd0...",
    "...0deeeeeef0...",
    "...0de0550ef0...",
    "...0de0660ef0...",
    "...0de0000ef0.0.",
    "...0deeeeeef00c0",
    "...0ffffffff0cd0",
    "....000de00ccd0.",
    "......0de0cdd0..",
    "......0decd00...",
    "......0ded0.....",
    ".....0cee0......",
    "...00cdde0......",
    "..0ccd0de0......",
    ".0cdd00de0......",
    "0cd00.0de0......",
    "0d0...0de0......",
    ".0....0de0......",
    "...0000de0000...",
    "..0cddddddddd0..",
    "..0eeeeeeeeee0..",
    "...0000000000...",
  ],
  [
    "....00000000....",
    "...0ccdddddd0...",
    "...0dddddddd0...",
    "...0de2ee2ef0...",
    "...0d203302f0...",
    "...0de0220ef0...",
    "...0de0000ef0...",
    "...0deeeeeef0...",
    "...0ffffffff0...",
    "....000de000....",
    "......0de0......",
    ".000000de000000.",
    "0333333de3333330",
    "0222222ee2222220",
    ".000000de000000.",
    "......0de0......",
    "......0de0......",
    "......0de0......",
    "......0de0......",
    "......0de0......",
    "...0000de0000...",
    "..0cddddddddd0..",
    "..0eeeeeeeeee0..",
    "...0000000000...",
  ],
];

/**
 * The reader's door (16 × 28): 0 closed, a blue door with a wired-glass window and a push
 * bar; 1 open, the leaf swung back against the jamb and daylight outside.
 */
const DOOR: readonly Rows[] = [
  [
    "0000000000000000",
    "0dddddddddddddd0",
    "0d000000000000f0",
    "0d0aaaaaaaaaa0f0",
    "0d0a9999999980f0",
    "0d0a9000000980f0",
    "0d0a90ccbb0980f0",
    "0d0a90cbbb0980f0",
    "0d0a90bbaa0980f0",
    "0d0a90bbaa0980f0",
    "0d0a9000000980f0",
    "0d0a9999999980f0",
    "0d0a9999999980f0",
    "0d0a9999999980f0",
    "0d0a0000000080f0",
    "0d0acddddddd80f0",
    "0d0a0000000080f0",
    "0d0a9999999980f0",
    "0d0a9999999980f0",
    "0d0a9999999980f0",
    "0d0a0000000080f0",
    "0d0a0eeeeee080f0",
    "0d0a0eeeeee080f0",
    "0d0a0000000080f0",
    "0d0a8888888880f0",
    "0d000000000000f0",
    "0ffffffffffffff0",
    "0000000000000000",
  ],
  [
    "0000000000000000",
    "0dddddddddddddd0",
    "0d000000000000f0",
    "0d0a990aaaaaa0f0",
    "0d0a980aaaaaa0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0a980bbbbbb0f0",
    "0d0ad80cccccc0f0",
    "0d0a980cccccc0f0",
    "0d0a980dddddd0f0",
    "0d0a980dddddd0f0",
    "0d0a980dddddd0f0",
    "0d0a980eeeeee0f0",
    "0d0a980dddddd0f0",
    "0d0a980dddddd0f0",
    "0d0a980dddddd0f0",
    "0d0a980eeeeee0f0",
    "0d000000000000f0",
    "0ffffffffffffff0",
    "0000000000000000",
  ],
];

/**
 * The queue's hatch in the partition wall (16 × 24): a roller shutter half up over a dark
 * pass-through, an amber lamp above, hazard stripes on the sill.
 */
const HATCH: Rows = [
  "0000000000000000",
  "0dddddddddddddd0",
  "0deeee0000eeeef0",
  "0deeee0430eeeef0",
  "0deeee0000eeeef0",
  "0deeeeeeeeeeeef0",
  "0d000000000000f0",
  "0d0cddddddddd0f0",
  "0d0eeeeeeeeee0f0",
  "0d0dddddddddd0f0",
  "0d0eeeeeeeeee0f0",
  "0d0dddddddddd0f0",
  "0d0eeee00eeee0f0",
  "0d000000000000f0",
  "0d000000000000f0",
  "0d000000000000f0",
  "0d000000000000f0",
  "0d088888888880f0",
  "0d088888888880f0",
  "0000000000000000",
  "0400440044004400",
  "0004400440044000",
  "0044004400440040",
  "0000000000000000",
];

/**
 * The CDN edge (32 × 24), outside the building: a striped shop awning over a counter
 * with pre-packed parcels on the shelf behind it — an answer served without coming inside.
 */
const AWNING: Rows = [
  ".000000000000000000000000000000.",
  "0333cccc3333cccc3333cccc3333ccc0",
  "0333cccc3333cccc3333cccc3333ccc0",
  ".000000000000000000000000000000.",
  "0222cccc2222cccc2222cccc2222ccc0",
  "0222cccc2222cccc2222cccc2222ccc0",
  "0222cccc2222cccc2222cccc2222ccc0",
  "0221dccd1221dccd1221dccd1221dcc0",
  "01100dd001100dd001100dd001100dd0",
  "0de0ffffffffffffffffffffffff0de0",
  "0de0f000000f000000f000000fff0de0",
  "0de0f0c2cd0f0c2cd0f0c2cd0f4f0de0",
  "0de0f0d1dd0f0d1dd0f0d1dd0f3f0de0",
  "0de0f000000f000000f000000fff0de0",
  "0de0ffffffffffffffffffffffff0de0",
  "0de00000000000000000000000000de0",
  "0de44444444444444444444444444de0",
  "0de33333333333333333333333333de0",
  "0de00000000000000000000000000de0",
  "0de43333323333332333333233333de0",
  "0de43333323333332333333233333de0",
  "0de42222222222222222222222222de0",
  "0de00000000000000000000000000de0",
  ".00..........................00.",
];

/**
 * Google News (32 × 32): a news kiosk under a four-colour roof, today's front page and a
 * second sheet pinned in the window, stacks of folded papers on the counter.
 */
const KIOSK: Rows = [
  ".000000000000000000000000000000.",
  "0aaaaaaa33333333cccccccc55555550",
  "0aaaaaaa33333333cccccccc55555550",
  ".000000000000000000000000000000.",
  "09999999222222224444444466666660",
  "09999999222222224444444466666660",
  "08888888111111113333333377777770",
  "08800880011001100330033007700770",
  ".000000000000000000000000000080.",
  ".0b7777777777777777777777777780.",
  ".0b7000000020000000000000000780.",
  ".0b70fcccccccccccfffff2ffff0780.",
  ".0b70fc000000002dffcccccccf0780.",
  ".0b70fccccccccccdffc00000df0780.",
  ".0b70fccaaacdddddffccccccdf0780.",
  ".0b70fcaaaaceeeedffceeeeedf0780.",
  ".0b70fc6666cdddddffccccccdf0780.",
  ".0b70fccccccccccdffceeeeedf0780.",
  ".0b70fcddddddddddffcddddddf0780.",
  ".0b70ffffffffffffffffffffff0780.",
  ".0b7700000007000000070000000780.",
  ".0b770ceeec070ceeec070ceeec0780.",
  ".0b770ddddd070ddddd070ddddd0780.",
  ".000000000000000000000000000000.",
  "04444444444444444444444444444440",
  "03333333333333333333333333333330",
  ".000000000000000000000000000000.",
  ".0a9999999999999999999999999990.",
  ".0a9999999999999999999999999990.",
  ".0a9999999999999999999999999990.",
  ".088888888888888888888888888880.",
  "..0000000000000000000000000000..",
];

/**
 * Gemini (32 × 40): a crystal ball on a gilded pedestal with a four-point sparkle inside.
 * 0 → 2 a rising glow: the sparkle grows, the mist inside turns, and a dithered aura and
 * twinkles gather around the glass.
 */
const ORACLE: readonly Rows[] = [
  [
    "................................",
    "................................",
    ".............000000.............",
    "....b.....000bbbbaa000..........",
    "...bcb...0bbbbbbbaaaaa0.........",
    "....b...0bbbbbbbbaaaa990........",
    ".......0bccbbbbbbaaaa9990.......",
    "......0bbcbbbabbbaaaa99990......",
    ".....0bbbbbbbbbbbaaaa999980.....",
    ".....0bbbbabbbbbbaaa9999980.....",
    ".....0bbbbbbbbbbaaaa9999880.....",
    "....0bbbbbbbbbbcaaaa99998880....",
    "....0bbbbbbbbbbcaaaa99988880....",
    "....0bbbabbbbccccca999988880....",
    "....0bbbbbbbaaacaaa9b9888880....",
    "....0aaaaaaaaaacaa9b99888880....",
    "....0aaaaaaaaaaaa99998888880....",
    ".....0aaaaaaaaa999b98888880.....",
    ".....0aaaaa9b99b99988888880.....",
    ".....0a99999999999888888880b....",
    "......09999999998888888880bcb...",
    ".......099999988888888880..b....",
    "........0999888888888880........",
    ".........08888888888880.........",
    ".........00008888880000.........",
    "........0c44444444444440........",
    "........0333333333333330........",
    ".........00a99999999800.........",
    "..........0a9999999980..........",
    "..........0a9999999980..........",
    "..........044444444440..........",
    "..........033333333330..........",
    "..........0a9999999980..........",
    "..........0a9999999980..........",
    ".......0000a9999999980000.......",
    "......0c444444444444444440......",
    "......03333333333333333330......",
    ".....0999999999999999999990.....",
    ".....0888888888888888888880.....",
    "......00000000000000000000......",
  ],
  [
    "................................",
    ".............7.7.7.7......b.....",
    "..........7.7000000.7....bcb....",
    ".........7000bbbbba000.7..b.....",
    "........70bbbbbbbbaaaa0.7.......",
    ".......70bbbbbbbbbaaaa90.7......",
    "......70bccbbbbbbbaaaa990.7.....",
    ".....70bbcbbbbbbbbaaaa9990......",
    "....70bbbbbbbbbbaaaaa999980.....",
    ".....0bbbbbbbbbbbaaaa9999807....",
    "....70bbbbbbbbbcbaaaa999980.7...",
    "...70bbbbbbbbbbcbaaa999a8880....",
    "....0bbbbbbbbbbcbaaa999988807...",
    "...70bbbbbbbccccccca99988880....",
    "....0bbbbbbbbbbcbaa9999888807...",
    "...70bbbbbaabaacaa999988a880....",
    "....0aaaaaaaaabca999998888807...",
    "...7.0aaaaaaaaaa999998888807....",
    "....70aaaaaaa99999998888880.....",
    "....b0aaaa999999999888888807....",
    "...bcb099999999998888888807.....",
    "....b7.0999999988888888807......",
    "......7.09999888888888807.......",
    ".......7.088888888888807........",
    "........700008888880000.........",
    "........0c44444444444440........",
    "........0333333333333330........",
    ".........00a99999999800.........",
    "..........0a9999999980..........",
    "..........0a9999999980..........",
    "..........044444444440..........",
    "..........033333333330..........",
    "..........0a9999999980..........",
    "..........0a9999999980..........",
    ".......0000a9999999980000.......",
    "......0c444444444444444440......",
    "......03333333333333333330......",
    ".....0999999999999999999990.....",
    ".....0888888888888888888880.....",
    "......00000000000000000000......",
  ],
  [
    "............7.7.7.7.............",
    ".........7.7bbbbbbbb.7..........",
    "........7.bbb000000bbb7.........",
    ".......7bb000bbbbbb000bb.7......",
    "......7bb0bbbbbbbbbaaa0bb.7.b...",
    ".....7bb0bbbbbbbbbbaaaa0bb.bcb..",
    "....7bb0bccbbbbbbbbaaa990bb.b...",
    "...7.b0bbcbbbbbbbbaaaa9990b7....",
    "....b0bbbbbbbbbbbbaaaa99990b7...",
    "..b7b0bbbbbbbbbcbbaaaa99990b....",
    ".bcbb0bbbbbbbbbcbbbaa999980bb...",
    "..bb0bbbbbbbbbbcbbaaa9999880b7..",
    "..7b0bbbbbbbbbbcbaaaab998880b...",
    "...b0bbbbbbcccc5cccc99998880b7..",
    "..7b0bbbbbbbbbbcbaaa99b88880b...",
    "...b0bbbbbbbbbacaaa999988880b7..",
    "..7b0bbbbaaaaaacaa9999888880b...",
    "...bb0aaaaaaaaaca9999a88880bb7..",
    "....b0aaaaaaaaa999998888880b7...",
    "...7b0aaaaaa999999a88888880b....",
    "....7b0a999999a99988888880b.7...",
    ".....bb099999999888888880bbb....",
    ".....bbb0999998888888880bbbcb...",
    "....bcbbb09988888888880bb7.b....",
    ".....b..b00008888880000b........",
    "........0c44444444444440........",
    "........0333333333333330........",
    ".........00a99999999800.........",
    "..........0a9999999980..........",
    "..........0a9999999980..........",
    "..........044444444440..........",
    "..........033333333330..........",
    "..........0a9999999980..........",
    "..........0a9999999980..........",
    ".......0000a9999999980000.......",
    "......0c444444444444444440......",
    "......03333333333333333330......",
    ".....0999999999999999999990.....",
    ".....0888888888888888888880.....",
    "......00000000000000000000......",
  ],
];

/**
 * Currents (32 × 48): a red-and-white lattice radio mast with a beacon and a dish,
 * standing on the loading dock where the day's articles arrive.
 */
const MAST: Rows = [
  "..............0000..............",
  ".............034220.............",
  ".............022220.............",
  "..............0de0..............",
  "............000de000............",
  "...........0dddddddd0...........",
  "...........0eeeeeeee0...........",
  "............032ff210............",
  "............032ee210............",
  "............032ee210............",
  ".00........032feef210...........",
  "0330.....000cdeffede0...........",
  ".040...00cd0cdeffede0...........",
  "..0e0.0ccddecdddddde0...........",
  "...0e0ccddeefdeffede0...........",
  "....0ecddeeffffeeff210..........",
  "...0ccedeeef2ffeeff210..........",
  "..0ccddeeeff2feffef210..........",
  "..0cddeeeff32effffe210..........",
  ".0cddeeeff0cdddddddde0..........",
  ".0ddeeefffcdfeffffefde0.........",
  "..0eefff0efdffeeeeffde0.........",
  "...0ff00.0edfffeefffde0.........",
  "....00...0e2ffeffeff210.........",
  ".........032eeffffee210.........",
  ".........032dddddddd210.........",
  "........032feeffffeef210........",
  "........0cdfffeeeefffde0........",
  "........0cdfffeeeefffde0........",
  "........0cdfeeffffeefde0........",
  "........0cdeffffffffede0........",
  ".......032eeeddddddeee210.......",
  ".......032fffeeeeeefff210.......",
  ".000000032dddddddddddd210000000.",
  "0eeeeeeeeeeeeeeeeeeeeeeeeeeeeee0",
  "0ffffffffffffffffffffffffffffff0",
  ".0cccccccccccccccccccccccccccc0.",
  ".0cddddddddd43ddddddddddddddde0.",
  ".0cdd000000000000000ddddddddde0.",
  ".0cdd0ddddddddddddd0dd00000dde0.",
  ".0cdd0fffffffffffff0dd0c440dde0.",
  ".0cdd0eeeeeeeeeeeee0dd04440dde0.",
  ".0cdd0fffffffffffff0dd00000dde0.",
  ".0cdd0eeeeeeeeeeeee0ddddddddde0.",
  ".0cdd0fffffffffffff0ddddddddde0.",
  ".0cdd0eeeeeeeeeeeee0ddddddddde0.",
  ".0cdd000440044004400ddddddddde0.",
  "..000...00..00..00..0000000000..",
];

/**
 * Postgres (56 × 40): the archive — a steel cabinet of labelled index drawers beside a
 * glass-fronted column of three stacked disk cylinders with status lights.
 */
const VAULT: Rows = [
  ".000000000000000000000000000000000000000000000000000000.",
  "0cccccccccccccccccccccccccccccccccccccccccccccccccccccc0",
  "0dddddddddddddddddddddddddddddddddddddddddddddddddddddd0",
  "0dddddddddddddddddddddddddddddddddddddddddddddddddddddd0",
  "0eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0",
  "00000000000000000000000000000000000000000000000000000000",
  "0deeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef0",
  "0de00000000000e00000000000e00000000000e00000000000000ef0",
  "0de0ccccccccc0e0ccccccccc0e0ccccccccc0e08888888888880ef0",
  "0de0ddcfffcde0e0ddcfffcde0e0ddcfffcde0e08800000000880ef0",
  "0de0ddcccccde0e0ddcccccde0e0ddcccccde0e080abbbbbba080ef0",
  "0de0ddd000dde0e0ddd000dde0e0ddd000dde0e08a99999999880ef0",
  "0de0eeeeeeeee0e0eeeeeeeee0e0eeeeeeeee0e08a99999999880ef0",
  "0de00000000000e00000000000e00000000000e08a95969599880ef0",
  "0deeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee08a99999999880ef0",
  "0de00000000000e00000000000e00000000000e08099999999080ef0",
  "0de0ccccccccc0e0ccccccccc0e0ccccccccc0e08800000000880ef0",
  "0de0ddcfffcde0e0ddcfffcde0e0ddcfffcde0e08888888888880ef0",
  "0de0ddcccccde0e0ddcccccde0e0ddcccccde0e08800000000880ef0",
  "0de0ddd000dde0e0ddd000dde0e0ddd000dde0e080abbbbbba080ef0",
  "0de0eeeeeeeee0e0eeeeeeeee0e0eeeeeeeee0e08a99999999880ef0",
  "0de00000000000e00000000000e00000000000e08a99999999880ef0",
  "0deeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee08a95969599880ef0",
  "0de00000000000e00000000000e00000000000e08a99999999880ef0",
  "0de0ccccccccc0e0ccccccccc0e0ccccccccc0e08099999999080ef0",
  "0de0ddcfffcde0e0ddcfffcde0e0ddcfffcde0e08800000000880ef0",
  "0de0ddcccccde0e0ddcccccde0e0ddcccccde0e08888888888880ef0",
  "0de0ddd000dde0e0ddd000dde0e0ddd000dde0e08800000000880ef0",
  "0de0eeeeeeeee0e0eeeeeeeee0e0eeeeeeeee0e080abbbbbba080ef0",
  "0de00000000000e00000000000e00000000000e08a99999999880ef0",
  "0deeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee08a99999999880ef0",
  "0de00000000000e00000000000e00000000000e08a95969599880ef0",
  "0de0ccccccccc0e0ccccccccc0e0ccccccccc0e08a99999999880ef0",
  "0de0ddcfffcde0e0ddcfffcde0e0ddcfffcde0e08099999999080ef0",
  "0de0ddcccccde0e0ddcccccde0e0ddcccccde0e08800000000880ef0",
  "0de0ddd000dde0e0ddd000dde0e0ddd000dde0e08888888888880ef0",
  "0de0eeeeeeeee0e0eeeeeeeee0e0eeeeeeeee0e00000000000000ef0",
  "0de00000000000e00000000000e00000000000eeeeeeeeeeeeeeeef0",
  "00000000000000000000000000000000000000000000000000000000",
  "..0000000000000000000000000000000000000000000000000000..",
];

// ── the sheet ───────────────────────────────────────────────────────────────

/**
 * Every sprite, at its pinned size and frame count (`sprites.test.ts`'s `PINNED`). Frame
 * meanings:
 * - `runner`, `worker`: 0 standing; 1–4 the walk cycle, advanced by distance (`1 + walkFrame`),
 *   with `WALK_BOB` saying how far the body dropped in each.
 * - `helper`: 0 and 1 alternate as its rotor spins.
 * - `door`: 0 closed, 1 open. `turnstile`: 0 idle, 1 turning, 2 blocked (red arm, red lamp).
 * - `oracle`: 0 → 1 → 2 a rising glow; cycle 0,1,2,1 to breathe.
 * - `belt`: 0 → 3 runs the belt one pixel to the right per frame.
 * - `dust`: 0 the puff, 1 its spreading ring.
 * - everything else: a single frame.
 */
export const SPRITES: Readonly<Record<SpriteId, Sprite>> = {
  runner: sprite(12, 16, robotFrames(RUNNER_HEAD, RUNNER_TORSO, RUNNER_LEGS)),
  helper: sprite(10, 12, HELPER_FRAMES),
  worker: sprite(12, 16, robotFrames(WORKER_HEAD, WORKER_TORSO, WORKER_LEGS)),
  ticket: sprite(6, 5, [TICKET]),
  parcel: sprite(8, 7, [PARCEL]),
  crate: sprite(8, 8, [CRATE]),
  padlock: sprite(5, 7, [PADLOCK]),
  door: sprite(16, 28, DOOR),
  awning: sprite(32, 24, [AWNING]),
  turnstile: sprite(16, 24, TURNSTILE),
  rack: sprite(124, 30, [rackRows()]),
  vault: sprite(56, 40, [VAULT]),
  mast: sprite(32, 48, [MAST]),
  hatch: sprite(16, 24, [HATCH]),
  kiosk: sprite(32, 32, [KIOSK]),
  oracle: sprite(32, 40, ORACLE),
  belt: sprite(8, 6, [0, 1, 2, 3].map(beltFrame)),
  stamp_ok: sprite(7, 7, [STAMP_OK]),
  stamp_fail: sprite(7, 7, [STAMP_FAIL]),
  dust: sprite(4, 4, DUST),
  gear: sprite(7, 7, [GEAR]),
};

/**
 * Which machine stands for which station; each machine's size is its station's
 * `STATION_FOOTPRINT` in `layout.ts`.
 */
export const STATION_SPRITE: Readonly<Record<Station, SpriteId>> = {
  edge: "awning",
  rate_limit: "turnstile",
  redis: "rack",
  postgres: "vault",
  queue: "hatch",
  currents: "mast",
  google_news: "kiosk",
  gemini: "oracle",
};

/**
 * A frame as palette indices, row-major: 0 is transparent and `i + 1` is `PALETTE[i]` (the
 * offset keeps 0 free for "nothing here"). Throws — rather than drawing a wrong pixel — on a
 * frame that does not exist, a frame with the wrong number of rows, a row of the wrong width,
 * or a character that is neither `.` nor a `PALETTE_KEYS` digit.
 */
export function decodeFrame(sprite: Sprite, frame: number): Uint8Array {
  const rows = sprite.frames[frame];
  if (rows === undefined) {
    throw new Error(`sprite has ${sprite.frames.length} frames; there is no frame ${frame}`);
  }
  if (rows.length !== sprite.h) {
    throw new Error(`frame ${frame} has ${rows.length} rows; the sprite is ${sprite.h} tall`);
  }
  const out = new Uint8Array(sprite.w * sprite.h);
  rows.forEach((row, y) => {
    if (row.length !== sprite.w) {
      throw new Error(`frame ${frame} row ${y} is ${row.length} wide; the sprite is ${sprite.w}`);
    }
    for (let x = 0; x < sprite.w; x++) {
      const ch = row[x]!;
      if (ch === ".") continue;
      const index = PALETTE_KEYS.indexOf(ch);
      if (index < 0) {
        throw new Error(`frame ${frame} row ${y} has ${JSON.stringify(ch)}, not a palette key`);
      }
      out[y * sprite.w + x] = index + 1;
    }
  });
  return out;
}

/**
 * A frame as RGBA bytes (`w·h·4`), ready for `new ImageData(…, w, h)`: transparent pixels are
 * all-zero, every other pixel is its palette colour at full opacity. `palette` is injectable
 * for tests and defaults to `PALETTE`; there is deliberately no per-theme palette.
 */
export function frameRGBA(
  sprite: Sprite,
  frame: number,
  palette: readonly string[] = PALETTE,
): Uint8ClampedArray {
  const indices = decodeFrame(sprite, frame);
  const rgb = palette.map((hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]);
  const out = new Uint8ClampedArray(indices.length * 4);
  indices.forEach((value, i) => {
    if (value === 0) return;
    const colour = rgb[value - 1];
    if (colour === undefined) throw new Error(`palette has no colour ${value - 1}`);
    out.set([colour[0]!, colour[1]!, colour[2]!, 255], i * 4);
  });
  return out;
}
