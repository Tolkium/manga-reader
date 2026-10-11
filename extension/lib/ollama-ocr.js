/**
 * Reads comic text with a local vision model served by Ollama.
 *
 * Webtoon pages are very tall strips, which vision models shrink until the
 * lettering is unreadable. So the image is cut into overlapping tiles about
 * 1.5 widths tall. Bubbles cut by a tile edge are ignored, because the overlap
 * guarantees they appear whole in the neighbouring tile.
 *
 * Sites also split a strip into several images, which can cut a bubble in two.
 * So the strip read for an image includes the edges of the images directly
 * above and below it. A bubble belongs to the image that holds its centre, and
 * its box may reach into the neighbouring image.
 */

export const OLLAMA_URL = 'http://localhost:11434';
export const OCR_MODELS = Object.freeze([
  { id: 'qwen3-vl:2b-instruct', label: 'Qwen3-VL 2B (fastest, 3 GB)' },
  { id: 'qwen3-vl:4b-instruct', label: 'Qwen3-VL 4B (balanced, 5 GB)' },
  { id: 'qwen3-vl:8b-instruct', label: 'Qwen3-VL 8B (most accurate, 7 GB)' },
]);
/** Keep the model in GPU memory between pages. */
const KEEP_ALIVE = '30m';

const TILE_HEIGHT_RATIO = 1.5;
/** Tile step relative to image width. Overlap = (1.5 - 1) * width. */
const TILE_STEP_RATIO = 1;
/** Height of the neighbouring images' edges, relative to width. */
const CONTEXT_RATIO = 0.6;
/** Pixels: a box this close to an inner tile edge is treated as cut off. */
const CUT_EDGE_MARGIN = 8;
const JPEG_QUALITY = 0.92;

// Comic lettering is ALL CAPS, which some voices spell out letter by letter.
// Asking for "sentence case" alone makes the model return all lowercase.
const PROMPT =
  'Find all dialogue and narration text in this comic image: speech bubbles, thought bubbles, ' +
  'caption boxes, and small handwritten remarks next to characters. Ignore sound effects, ' +
  'background signs and watermarks. For each one return its text with the wording and spelling ' +
  'exactly as written, but with standard English capitalization (not all caps): capitalize the ' +
  'first word of each sentence, the word I, and names. Also return its bounding box as ' +
  '[x1, y1, x2, y2] normalized to 0-1000. Order them in reading order.';

/** Structured output: Ollama constrains the model to this JSON shape. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    bubbles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          box: { type: 'array', items: { type: 'integer' } },
        },
        required: ['text', 'box'],
      },
    },
  },
  required: ['bubbles'],
};

/**
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} BBox
 * @typedef {{ text: string, bbox: BBox }} Bubble
 * @typedef {{ top: number, width: number, height: number }} Tile
 * @typedef {{ bitmap: ImageBitmap, sourceTop: number, sourceHeight: number, top: number, height: number }} StripPart
 *   A slice of an image placed in the strip, scaled to the strip width.
 */

/**
 * @param {{ url: string, aboveUrl?: string, belowUrl?: string }} images The
 *   image to read, and the images directly above and below it on the page.
 * @param {string} model Ollama vision model.
 * @returns {Promise<Bubble[]>} Bubbles top to bottom, in the image's pixels.
 */
export async function recognizeImage({ url, aboveUrl, belowUrl }, model) {
  const [bitmap, above, below] = await Promise.all([
    loadBitmap(url),
    aboveUrl && loadBitmap(aboveUrl).catch(() => null), // Read without that edge.
    belowUrl && loadBitmap(belowUrl).catch(() => null),
  ]);
  try {
    const { parts, offset, height } = planStrip(bitmap, above, below);
    const bubbles = [];
    for (const tile of planTiles(bitmap.width, height)) {
      const tileBubbles = await recognizeTile(parts, tile, model);
      bubbles.push(...tileBubbles.filter((b) => !isCutByTileEdge(b.bbox, tile, height)));
    }
    return removeDuplicates(bubbles)
      .map(({ text, bbox }) => ({
        text,
        bbox: { ...bbox, y0: bbox.y0 - offset, y1: bbox.y1 - offset },
      }))
      .filter(({ bbox }) => {
        const centre = (bbox.y0 + bbox.y1) / 2;
        return centre >= 0 && centre < bitmap.height; // Else the neighbour's bubble.
      })
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
  } finally {
    for (const b of [bitmap, above, below]) b?.close();
  }
}

/** Loads the model into GPU memory so the first page doesn't wait for it. */
export async function warmUpModel(model) {
  await ollamaRequest('/api/generate', { model, keep_alive: KEEP_ALIVE });
}

/** @returns {Promise<{ ready: boolean, message: string }>} */
export async function checkOllama(model) {
  try {
    const { models } = await ollamaRequest('/api/tags');
    const installed = models.some(({ name }) => name === model);
    return installed
      ? { ready: true, message: `OCR ready (${model})` }
      : { ready: false, message: `Model missing. Run: ollama pull ${model}` };
  } catch (error) {
    return { ready: false, message: error.message };
  }
}

async function loadBitmap(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
}

/**
 * Stacks the bottom of the image above, the image, and the top of the image
 * below. Neighbours are scaled to the image's width, as on the page.
 * @returns {{ parts: StripPart[], offset: number, height: number }} `offset` is
 *   where the image starts in the strip.
 */
function planStrip(bitmap, above, below) {
  const width = bitmap.width;
  const context = Math.round(width * CONTEXT_RATIO);
  const parts = [];
  let top = 0;

  if (above) {
    const scale = width / above.width;
    const height = Math.min(context, Math.round(above.height * scale));
    const sourceHeight = height / scale;
    parts.push({ bitmap: above, sourceTop: above.height - sourceHeight, sourceHeight, top, height });
    top += height;
  }
  const offset = top;
  parts.push({ bitmap, sourceTop: 0, sourceHeight: bitmap.height, top, height: bitmap.height });
  top += bitmap.height;
  if (below) {
    const scale = width / below.width;
    const height = Math.min(context, Math.round(below.height * scale));
    parts.push({ bitmap: below, sourceTop: 0, sourceHeight: height / scale, top, height });
    top += height;
  }
  return { parts, offset, height: top };
}

/** @returns {Tile[]} Overlapping tiles covering the strip top to bottom. */
function planTiles(width, height) {
  const tileHeight = Math.min(height, Math.round(width * TILE_HEIGHT_RATIO));
  const step = Math.round(width * TILE_STEP_RATIO);
  const tiles = [];
  for (let top = 0; ; top += step) {
    const clampedTop = Math.min(top, height - tileHeight);
    tiles.push({ top: clampedTop, width, height: tileHeight });
    if (clampedTop + tileHeight >= height) return tiles;
  }
}

/** @returns {Promise<Bubble[]>} Bubbles in strip pixels. */
async function recognizeTile(parts, tile, model) {
  const canvas = new OffscreenCanvas(tile.width, tile.height);
  const context = canvas.getContext('2d');
  for (const { bitmap, sourceTop, sourceHeight, top, height } of parts) {
    // Parts outside the tile are clipped by the canvas.
    context.drawImage(
      bitmap,
      0, sourceTop, bitmap.width, sourceHeight,
      0, top - tile.top, tile.width, height,
    ); // prettier-ignore
  }
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });

  const { message } = await ollamaRequest('/api/chat', {
    model,
    stream: false,
    think: false,
    keep_alive: KEEP_ALIVE,
    format: RESPONSE_SCHEMA,
    options: { temperature: 0 },
    messages: [{ role: 'user', content: PROMPT, images: [await toBase64(jpeg)] }],
  });

  return JSON.parse(message.content)
    .bubbles.filter(({ text, box }) => text.trim() && box.length === 4)
    .map(({ text, box }) => ({ text: toSentenceCase(text.trim()), bbox: toStripPixels(box, tile) }));
}

/** Small models sometimes ignore the prompt and keep comic lettering ALL CAPS. */
function toSentenceCase(text) {
  if (/[a-z]/.test(text) || !/[A-Z]/.test(text)) return text;
  return text
    .toLowerCase()
    .replace(/(^|[.!?…]\s+)(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase())
    .replace(/\bi\b/g, 'I');
}

/** Converts a 0-1000 normalized tile box to strip pixels. */
function toStripPixels([x0, y0, x1, y1], tile) {
  return {
    x0: (x0 / 1000) * tile.width,
    y0: tile.top + (y0 / 1000) * tile.height,
    x1: (x1 / 1000) * tile.width,
    y1: tile.top + (y1 / 1000) * tile.height,
  };
}

function isCutByTileEdge(bbox, tile, stripHeight) {
  const tileBottom = tile.top + tile.height;
  const cutAtTop = tile.top > 0 && bbox.y0 < tile.top + CUT_EDGE_MARGIN;
  const cutAtBottom = tileBottom < stripHeight && bbox.y1 > tileBottom - CUT_EDGE_MARGIN;
  return cutAtTop || cutAtBottom;
}

/** Bubbles inside a tile overlap are found twice; keep the first. */
function removeDuplicates(bubbles) {
  const kept = [];
  for (const bubble of bubbles) {
    if (!kept.some((other) => overlapsMostly(other.bbox, bubble.bbox))) kept.push(bubble);
  }
  return kept;
}

function overlapsMostly(a, b) {
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const smallerHeight = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  return overlapX > 0 && overlapY > smallerHeight / 2;
}

async function ollamaRequest(path, body) {
  let response;
  try {
    response = await fetch(OLLAMA_URL + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Ollama is not running at ${OLLAMA_URL}. Start the Ollama app.`);
  }

  if (response.status === 403) {
    throw new Error(
      'Ollama blocked the extension. Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.',
    );
  }
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw new Error(`Ollama error (HTTP ${response.status}): ${error ?? response.statusText}`);
  }
  return response.json();
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
