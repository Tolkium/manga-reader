/**
 * Reads comic text in two steps when the local server runs: its speech-bubble
 * detector finds exact bubble and caption boxes, then a local vision model
 * served by Ollama reads each box cut out on its own. Without the server, the
 * vision model does both on whole tiles, which is slower and its boxes are
 * rough.
 *
 * Webtoon pages are very tall strips, which models shrink until the lettering
 * is unreadable. So the strip is cut into overlapping tiles: squares for the
 * detector, 1.5 widths tall for the vision model alone. Bubbles cut by a tile
 * edge are ignored or merged, because the overlap shows them whole elsewhere.
 *
 * Sites also split a strip into several images, which can cut a bubble in two.
 * So the strip read for an image includes the edges of the images directly
 * above and below it, and the strip's own top and bottom count as cut edges
 * too. Whichever of two neighbours is read second sees a split bubble whole.
 * Both images may report the same bubble; the reader merges copies by position.
 */
import { detectRegions } from './local-server.js';

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
/** Pixels: a box this close to a tile edge is treated as cut off. */
const CUT_EDGE_MARGIN = 8;
const JPEG_QUALITY = 0.92;
/** A tile's answer is a few hundred tokens; more means the model is looping. */
const MAX_TILE_TOKENS = 1024;
/** Retry a failed tile with some randomness, which usually breaks a loop. */
const TILE_TEMPERATURES = [0, 0.4];
/** Normalized characters a text needs before it counts as a repeat. */
const MIN_REPEAT_LENGTH = 12;

/** Detector tiles are squares; this step (relative to width) halves their overlap. */
const DETECT_TILE_STEP_RATIO = 0.5;
/** Margin around a cut-out bubble, relative to its size, so no letter is clipped. */
const CROP_PADDING = 0.06;
/** Small cut-outs are enlarged so their shorter side has at least this many pixels. */
const MIN_CROP_SIDE = 200;
const MAX_CROP_SCALE = 3;
/** One bubble's text is short; more tokens means the model is looping. */
const MAX_CROP_TOKENS = 256;

/**
 * What a text is, so the reader can skip what isn't story: credits and
 * sound effects always, other languages when "Read only English" is on.
 */
const TEXT_KINDS = ['dialogue', 'narration', 'sign', 'sound_effect', 'credit'];
const KIND_AND_LANGUAGE_PROMPT =
  "Also give the text's language as a two-letter ISO 639-1 code (en for English), and what " +
  'kind of text it is: dialogue (a speech or thought bubble), narration (a caption box), sign ' +
  '(text drawn in the scene, such as a sign, screen or letter), sound_effect, or credit (a ' +
  'watermark, website address, translator or scanlation group credit, or advertisement).';
const KIND_AND_LANGUAGE_PROPERTIES = {
  language: { type: 'string' },
  kind: { type: 'string', enum: TEXT_KINDS },
};

// The cut-out is read as written (usually ALL CAPS); toSentenceCase fixes it.
const CROP_PROMPT =
  'Read all the text in this cut-out from a comic exactly as written, joining its lines with ' +
  'spaces. If it has no readable text, return an empty string. ' +
  KIND_AND_LANGUAGE_PROMPT;
const CROP_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, ...KIND_AND_LANGUAGE_PROPERTIES },
  required: ['text', 'language', 'kind'],
};

// Comic lettering is ALL CAPS, which some voices spell out letter by letter.
// Asking for "sentence case" alone makes the model return all lowercase.
const PROMPT =
  'Find all dialogue and narration text in this comic image: speech bubbles, thought bubbles, ' +
  'caption boxes, and small handwritten remarks next to characters. Ignore sound effects, ' +
  'background signs and watermarks. For each one return its text with the wording and spelling ' +
  'exactly as written, but with standard English capitalization (not all caps): capitalize the ' +
  'first word of each sentence, the word I, and names. Return each bubble or box as one entry ' +
  'with all its lines joined into one text; never return its lines as separate entries. ' +
  'Also return its bounding box as [x1, y1, x2, y2] normalized to 0-1000. ' +
  'Order them in reading order. ' +
  KIND_AND_LANGUAGE_PROMPT;

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
          ...KIND_AND_LANGUAGE_PROPERTIES,
        },
        required: ['text', 'box', 'language', 'kind'],
      },
    },
  },
  required: ['bubbles'],
};

/**
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} BBox
 * @typedef {{ text: string, bbox: BBox, language?: string, kind?: string }} Bubble
 *   `language` is an ISO 639-1 code; `kind` one of TEXT_KINDS.
 * @typedef {{ top: number, width: number, height: number }} Tile
 * @typedef {{ left: number, top: number, width: number, height: number }} Area
 *   A rectangle of the strip, in strip pixels.
 * @typedef {{ bitmap: ImageBitmap, sourceTop: number, sourceHeight: number, top: number, height: number }} StripPart
 *   A slice of an image placed in the strip, scaled to the strip width.
 * @typedef {{ parts: StripPart[], width: number, height: number, offset: number, imageHeight: number }} Strip
 *   `offset` is where the image being read starts in the strip.
 */

/**
 * @param {{
 *   url: string,
 *   aboveUrl?: string,
 *   belowUrl?: string,
 *   closedTop?: boolean,
 *   closedBottom?: boolean,
 * }} images The image to read, and the images directly above and below it on
 *   the page. `closedTop`/`closedBottom`: no image can ever appear on that side
 *   (the chapter's first or last page), so a bubble touching that edge is whole.
 * @param {string} model Ollama vision model.
 * @returns {Promise<Bubble[]>} Bubbles top to bottom, in the image's pixels.
 */
export async function recognizeImage({ url, aboveUrl, belowUrl, closedTop, closedBottom }, model) {
  const [bitmap, above, below] = await Promise.all([
    loadBitmap(url),
    aboveUrl ? loadBitmap(aboveUrl).catch(() => null) : null, // Read without that edge.
    belowUrl ? loadBitmap(belowUrl).catch(() => null) : null,
  ]);
  try {
    const strip = {
      ...planStrip(bitmap, above, below),
      // A neighbour's edge is always cut, so only an image's own end can be closed.
      closedTop: Boolean(closedTop && !above),
      closedBottom: Boolean(closedBottom && !below),
    };
    let regions;
    try {
      regions = await detectStripRegions(strip);
    } catch (error) {
      console.warn('Bubble detector unavailable, reading whole tiles instead:', error.message);
    }
    // Only a detector failure falls back to tiles; Ollama errors while reading
    // the regions are reported as they are.
    const bubbles = regions
      ? await readRegions(strip, regions, model)
      : await recognizeWithTiles(strip, model);
    return bubbles
      .map(({ bbox, ...rest }) => ({
        ...rest,
        bbox: { ...bbox, y0: bbox.y0 - strip.offset, y1: bbox.y1 - strip.offset },
      }))
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
  } finally {
    for (const b of [bitmap, above, below]) b?.close();
  }
}

/** The detector finds the boxes, in strip pixels. */
async function detectStripRegions(strip) {
  const tiles = await Promise.all(
    planDetectionTiles(strip.width, strip.height).map(async (tile) => ({
      top: tile.top,
      image: await toBase64(await renderJpeg(strip, { left: 0, ...tile })),
    })),
  );
  return detectRegions(tiles);
}

/**
 * The vision model reads each detected box cut out.
 * @param {Strip} strip
 * @returns {Promise<Bubble[]>} In strip pixels.
 */
async function readRegions(strip, regions, model) {
  const imageEnd = strip.offset + strip.imageHeight;
  const bubbles = [];
  for (const region of regions) {
    if (region.x1 - region.x0 < 4 || region.y1 - region.y0 < 4) continue;
    // Cut by the strip's end; the neighbouring image's read sees it whole.
    if (isCutByStripEnd(region, strip)) continue;
    // Wholly in a neighbour's edge: that image reads it itself.
    if (region.y1 <= strip.offset || region.y0 >= imageEnd) continue;
    const reading = await readRegion(strip, region, model);
    const { x0, y0, x1, y1 } = region;
    if (reading.text) bubbles.push({ ...reading, bbox: { x0, y0, x1, y1 } });
  }
  return removeRepeatedTexts(bubbles);
}

/** @returns {Tile[]} Overlapping squares covering the strip top to bottom. */
function planDetectionTiles(width, height) {
  const size = Math.min(width, height);
  const step = Math.round(width * DETECT_TILE_STEP_RATIO);
  const tiles = [];
  for (let top = 0; ; top += step) {
    const clampedTop = Math.min(top, height - size);
    tiles.push({ top: clampedTop, width, height: size });
    if (clampedTop + size >= height) return tiles;
  }
}

/**
 * Reads one detected bubble, cut out with a small margin. Other text reaching
 * into the cut-out (`cover`, such as a watermark on the bubble's edge) is
 * painted over; the bubble's own text (`keep`) never is.
 * @returns {Promise<{ text: string, language?: string, kind?: string }>} Empty
 *   text if it couldn't be read.
 */
async function readRegion(strip, { x0, y0, x1, y1, keep = [], cover = [] }, model) {
  const padX = (x1 - x0) * CROP_PADDING;
  const padY = (y1 - y0) * CROP_PADDING;
  const left = Math.max(0, x0 - padX);
  const top = Math.max(0, y0 - padY);
  const area = {
    left,
    top,
    width: Math.min(strip.width, x1 + padX) - left,
    height: Math.min(strip.height, y1 + padY) - top,
  };
  const scale = Math.min(MAX_CROP_SCALE, Math.max(1, MIN_CROP_SIDE / Math.min(area.width, area.height)));
  const image = await toBase64(await renderJpeg(strip, area, scale, { keep, cover }));

  const reading = await askModel(
    { model, prompt: CROP_PROMPT, schema: CROP_SCHEMA, image, maxTokens: MAX_CROP_TOKENS },
    `bubble at y=${Math.round(y0)}`,
    ({ text, language, kind }) => ({ text: cleanText(text, language), language, kind }),
  );
  return reading ?? { text: '' };
}

/** Answers a model gives for a cut-out of plain artwork instead of an empty text. */
const NO_TEXT_ANSWERS = new Set(['none', 'no text', 'empty', 'n a', 'null', 'unreadable', 'blank']);

/**
 * Tidies a model's text. Returns '' when there is no real text: with nothing
 * to read, small models fill the text field with the language code ("en") or
 * a placeholder ("none").
 */
function cleanText(text, language) {
  const plain = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (plain === (language ?? '').trim().toLowerCase() || NO_TEXT_ANSWERS.has(plain)) return '';
  return collapseRepeats(toSentenceCase(text.trim()));
}

/**
 * Asks the vision model about one image, retrying with some randomness when
 * the answer is cut off or unusable.
 * @returns {Promise<any>} `parse` of the answer, or null if none was usable.
 */
async function askModel({ model, prompt, schema, image, maxTokens }, what, parse) {
  for (const temperature of TILE_TEMPERATURES) {
    const { message, done_reason: doneReason } = await ollamaRequest('/api/chat', {
      model,
      stream: false,
      think: false,
      keep_alive: KEEP_ALIVE,
      format: schema,
      options: { temperature, num_predict: maxTokens },
      messages: [{ role: 'user', content: prompt, images: [image] }],
    });
    try {
      if (doneReason === 'length') throw new Error('the answer was cut off');
      return parse(JSON.parse(message.content));
    } catch (error) {
      console.warn(`OCR of ${what} unusable (temperature ${temperature}):`, error.message);
    }
  }
  return null;
}

/**
 * Without the detector, the vision model finds and reads bubbles on tiles.
 * @param {Strip} strip
 * @returns {Promise<Bubble[]>} In strip pixels.
 */
async function recognizeWithTiles(strip, model) {
  const bubbles = [];
  for (const tile of planTiles(strip.width, strip.height)) {
    const tileBubbles = await recognizeTile(strip, tile, model);
    bubbles.push(...tileBubbles.filter((b) => !isCutByTileEdge(b.bbox, tile, strip)));
  }
  return removeRepeatedTexts(mergeLines(removeFragments(removeDuplicates(bubbles))));
}

/**
 * Draws an area of the strip, optionally enlarged, as a JPEG.
 * @param {Strip} strip
 * @param {Area} area
 * @param {{ keep?: BBox[], cover?: BBox[] }} masks Boxes in strip pixels:
 *   `cover` is painted white, then `keep` is drawn again on top.
 */
function renderJpeg(strip, area, scale = 1, { keep = [], cover = [] } = {}) {
  const canvas = new OffscreenCanvas(Math.round(area.width * scale), Math.round(area.height * scale));
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.translate(-area.left, -area.top); // Draw in strip pixels.
  drawStrip(context, strip);

  if (cover.length > 0) {
    context.fillStyle = 'white';
    for (const box of cover) context.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    if (keep.length > 0) {
      context.save();
      context.beginPath();
      for (const box of keep) context.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      context.clip(); // Union of the kept boxes.
      drawStrip(context, strip);
      context.restore();
    }
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}

/** Parts outside the canvas are clipped by it. */
function drawStrip(context, { parts, width }) {
  for (const { bitmap, sourceTop, sourceHeight, top, height } of parts) {
    context.drawImage(bitmap, 0, sourceTop, bitmap.width, sourceHeight, 0, top, width, height);
  }
}

/** Loads the model into GPU memory so the first page doesn't wait for it. */
export async function warmUpModel(model) {
  await ollamaRequest('/api/generate', { model, keep_alive: KEEP_ALIVE });
}

/**
 * Installed Ollama models that can read images, so any vision model pulled
 * with `ollama pull` can be picked in the popup without changing code.
 * @returns {Promise<string[] | null>} Model names, or null if Ollama is unreachable.
 */
export async function listVisionModels() {
  let models;
  try {
    ({ models } = await ollamaRequest('/api/tags'));
  } catch {
    return null;
  }
  const checks = await Promise.all(
    models.map(async ({ name }) => {
      try {
        const { capabilities } = await ollamaRequest('/api/show', { model: name });
        // Older Ollama versions don't report capabilities; offer those models anyway.
        return !capabilities || capabilities.includes('vision') ? name : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter(Boolean).sort();
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
 * @returns {Strip}
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
  return { parts, width, height: top, offset, imageHeight: bitmap.height };
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
async function recognizeTile(strip, tile, model) {
  const image = await toBase64(await renderJpeg(strip, { left: 0, ...tile }));

  const bubbles = await askModel(
    { model, prompt: PROMPT, schema: RESPONSE_SCHEMA, image, maxTokens: MAX_TILE_TOKENS },
    `tile at y=${tile.top}`,
    (answer) =>
      answer.bubbles
        .filter(({ text, box }) => text.trim() && box.length === 4)
        .map(({ text, box, language, kind }) => ({
          text: cleanText(text, language),
          bbox: toStripPixels(box, tile),
          language,
          kind,
        }))
        .filter(({ text }) => text),
  );
  return bubbles ?? []; // Skip this tile rather than lose the whole image.
}

/**
 * Small models sometimes loop and repeat a bubble's text ("A. B. A. B. A.").
 * Keeps one copy. Only long parts repeated three or more times count, so
 * shouts like "Run! Run!" or "No, no, no!" stay as they are.
 */
function collapseRepeats(text) {
  return collapseRepeatsOf(text, /[^.!?…]+(?:[.!?…]+|$)/g) ??
    collapseRepeatsOf(text, /[^.!?…,]+(?:[.!?…,]+|$)/g) ??
    text; // prettier-ignore
}

function collapseRepeatsOf(text, pattern) {
  const parts = (text.match(pattern) ?? []).map((part) => part.trim()).filter(Boolean);
  const keys = parts.map(normalizeText);
  // At least three copies: a line said twice can be real dialogue.
  for (let period = 1; 2 * period < parts.length; period++) {
    if (keys.slice(0, period).join(' ').length < MIN_REPEAT_LENGTH) continue;
    // The last copy may be cut off, so it only has to be the start of one.
    const repeats = keys.every((key, i) =>
      i < keys.length - 1 ? key === keys[i % period] : keys[i % period].startsWith(key),
    );
    if (repeats) return parts.slice(0, period).join(' ');
  }
  return null;
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A looping model can also list one bubble many times with different boxes. */
function removeRepeatedTexts(bubbles) {
  const seen = new Set();
  return bubbles.filter(({ text }) => {
    const key = normalizeText(text);
    if (key.length < MIN_REPEAT_LENGTH) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * Every tile edge counts, including the strip's ends: there the strip either
 * cuts a neighbour's edge or meets an image that may not have loaded yet.
 * Only a closed end (the chapter's first or last page) can't cut a bubble.
 */
function isCutByTileEdge(bbox, tile, strip) {
  const tileBottom = tile.top + tile.height;
  const openTop = !(tile.top === 0 && strip.closedTop);
  const openBottom = !(tileBottom >= strip.height && strip.closedBottom);
  const cutAtTop = openTop && bbox.y0 < tile.top + CUT_EDGE_MARGIN;
  const cutAtBottom = openBottom && bbox.y1 > tileBottom - CUT_EDGE_MARGIN;
  return cutAtTop || cutAtBottom;
}

/** Same rule for detector regions, which can only be cut by the strip's ends. */
function isCutByStripEnd(region, strip) {
  return isCutByTileEdge(region, { top: 0, height: strip.height }, strip);
}

/**
 * Bubbles inside a tile overlap are found twice; keep the first. Boxes are
 * rough, so neighbouring bubbles can overlap too; those differ in their words.
 */
function removeDuplicates(bubbles) {
  const kept = [];
  for (const bubble of bubbles) {
    const duplicate = kept.some(
      (other) => overlapsMostly(other.bbox, bubble.bbox) && similarWords(other.text, bubble.text),
    );
    if (!duplicate) kept.push(bubble);
  }
  return kept;
}

/**
 * Models sometimes return a bubble whole and also some of its lines on their
 * own, often with boxes beside the bubble. Drops those lines.
 */
function removeFragments(bubbles) {
  return bubbles.filter(
    (part) =>
      !bubbles.some(
        (whole) => isFragmentOf(part.text, whole.text) && isNear(part.bbox, whole.bbox),
      ),
  );
}

/** Every word of `part` is in `whole`, which has more words. Same as in content.js. */
function isFragmentOf(part, whole) {
  const partWords = normalizeText(part).split(' ').filter(Boolean);
  const wholeWords = new Set(normalizeText(whole).split(' ').filter(Boolean));
  return (
    partWords.length > 0 &&
    partWords.length < wholeWords.size &&
    partWords.every((word) => wholeWords.has(word))
  );
}

function isNear(a, b) {
  const height = Math.max(a.y1 - a.y0, b.y1 - b.y0);
  const width = Math.max(a.x1 - a.x0, b.x1 - b.x0);
  const distanceY = Math.abs(a.y0 + a.y1 - b.y0 - b.y1) / 2;
  const distanceX = Math.abs(a.x0 + a.x1 - b.x0 - b.x1) / 2;
  return distanceY < 3 * height && distanceX < width;
}

/**
 * Models also return each line of a bubble as its own entry, mostly with
 * stylized lettering. Joins lines stacked right below an unfinished sentence.
 */
function mergeLines(bubbles) {
  const merged = [];
  for (const bubble of [...bubbles].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const above = merged.find((other) => continuesInto(other, bubble));
    if (above) {
      above.text = `${above.text} ${lowerFirstWord(bubble.text)}`;
      above.bbox = {
        x0: Math.min(above.bbox.x0, bubble.bbox.x0),
        y0: Math.min(above.bbox.y0, bubble.bbox.y0),
        x1: Math.max(above.bbox.x1, bubble.bbox.x1),
        y1: Math.max(above.bbox.y1, bubble.bbox.y1),
      };
    } else {
      merged.push({ ...bubble });
    }
  }
  return merged;
}

function continuesInto(above, below) {
  if (/[.!?…][\s"'”’)\]]*$/.test(above.text)) return false; // The sentence ended.
  const lineHeight = below.bbox.y1 - below.bbox.y0;
  const gap = below.bbox.y0 - above.bbox.y1;
  const overlapX = Math.min(above.bbox.x1, below.bbox.x1) - Math.max(above.bbox.x0, below.bbox.x0);
  const narrower = Math.min(above.bbox.x1 - above.bbox.x0, below.bbox.x1 - below.bbox.x0);
  return Math.abs(gap) < 0.75 * lineHeight && overlapX > 0.5 * narrower;
}

/** "Orchestra of this" continuing a sentence becomes "orchestra of this"; I stays I. */
function lowerFirstWord(text) {
  return /^I\b/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** Most words shared, or one long text inside the other. Same as in content.js. */
function similarWords(a, b) {
  const textA = normalizeText(a);
  const textB = normalizeText(b);
  const [shorter, longer] = textA.length < textB.length ? [textA, textB] : [textB, textA];
  if (shorter === longer || (shorter.length >= MIN_REPEAT_LENGTH && longer.includes(shorter))) {
    return true;
  }
  const wordsA = new Set(textA.split(' '));
  const wordsB = new Set(textB.split(' '));
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  return shared / new Set([...wordsA, ...wordsB]).size >= 0.6;
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
