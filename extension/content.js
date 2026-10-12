// Injected into a tab while reading is on. Finds comic images, asks the
// background for their OCR'd bubbles and queues each bubble for speech once
// it is fully visible in the viewport.
(() => {
  // The background re-injects on every page load; keep one instance per page.
  // When the extension is reloaded, the old instance stays in the page but is
  // cut off from the extension (chrome.runtime.id is gone), so replace it.
  const previous = window.__mangaReader;
  if (previous?.isConnected()) return;
  previous?.stop();
  const instance = { stop, isConnected: () => Boolean(chrome.runtime?.id) };
  window.__mangaReader = instance;

  /** Rendered and natural size an image needs to count as a comic page. */
  const MIN_IMAGE_SIZE = 300;
  const SUPPORTED_URL = /^(https?|data):/;
  const LOG_PREFIX = '[Manga Reader]';
  /** Queued bubbles whose audio is generated ahead (used by Kokoro voices). */
  const PREPARE_AHEAD = 2;
  /** CSS pixels: images this close above or below each other form one strip. */
  const MAX_STRIP_GAP = 12;
  /** Give up on a stuck OCR request, so reading never waits forever. */
  const OCR_TIMEOUT_MS = 180_000;
  const MAX_OCR_ATTEMPTS = 2;
  /** Timeouts to wait through: a tall strip on the 8B model can take minutes. */
  const MAX_OCR_WAITS = 5;
  /**
   * Give up on a stuck utterance: a base plus enough per character for 0.3×
   * speed. The base outlasts Kokoro's own 20 s request timeout, so its
   * browser-voice fallback never speaks over the next bubble.
   */
  const SPEAK_TIMEOUT_BASE_MS = 30_000;
  const SPEAK_TIMEOUT_PER_CHAR_MS = 300;
  /**
   * A text spoken this recently is never spoken again, wherever it was found:
   * guards against looping model output and copies from neighbouring images.
   * With re-reading on, a bubble may be spoken again after this long.
   */
  const REPEAT_GUARD_MS = 30_000;
  const MAX_SPOKEN_HISTORY = 300;
  /** Normalized characters a text needs before matching by words alone. */
  const MIN_MATCH_LENGTH = 12;
  /**
   * Share of distinct words two reads of one bubble have in common. Copies in
   * one spot may differ by a misread word; nearby ones must match more, so
   * "Maybe Kwon Tae-joon?" (3 of 5 words shared) isn't "Or... Kwon Tae-joon?".
   */
  const WORD_MATCH = 0.75;
  const LOOSE_WORD_MATCH = 0.5;
  /** Scanlation credits and site ads, in case the model calls them dialogue. */
  const CREDIT_PATTERN =
    /\bwww\.|https?:|\w\.(com|net|org|co|io|gg)\b|discord\.gg|patreon|ko-fi|scanlat|\wscans\b|translated by|diterjemahkan/i;
  /** Role labels on a scanlation credits page ("Translator:"). The colon keeps dialogue out. */
  const CREDIT_ROLE_PATTERN =
    /\b(raw provider|translator|translation|proof ?reader|proofreading|typesetter|typesetting|redrawer|redrawing|cleaner|cleaning|quality check(er)?|editor|qc|tl|pr|ts)\s*:/i;
  /**
   * An image whose texts are this often credits is a credits page, so its
   * names, title and logo are skipped too.
   */
  const CREDITS_PAGE_MIN_COUNT = 3;
  const CREDITS_PAGE_MIN_SHARE = 0.3;
  const LATIN_CHAR = /[A-Za-z0-9À-ɏ]/;
  /** Latin letters a mixed-script text needs for its English part to be read. */
  const MIN_ENGLISH_PART = 12;

  /**
   * @typedef {{ x0: number, y0: number, x1: number, y1: number }} BBox
   * @typedef {{
   *   img: HTMLImageElement,
   *   bbox: BBox,
   *   text: string,
   *   read: boolean,
   *   language?: string,
   *   kind?: string,
   *   creditsPage?: boolean,
   *   prepared?: boolean,
   *   state?: 'spoken' | 'repeat' | 'skipped',
   *   skipReason?: string,
   * }} Bubble `read` means queued or spoken; `state` is shown by the debug boxes.
   *   `language` (ISO 639-1) and `kind` come from the OCR model.
   * @typedef {{
   *   url: string,
   *   status: 'pending' | 'running' | 'done' | 'failed',
   *   attempts?: number,
   *   waits?: number,
   * }} ImageEntry
   */

  /** @type {Map<HTMLImageElement, ImageEntry>} */
  const images = new Map();
  /** All known bubbles, in reading order. @type {Bubble[]} */
  let bubbles = [];
  /** @type {Bubble[]} */
  const speechQueue = [];
  /** Bubbles already spoken, so a copy found again isn't read twice. */
  const spoken = /** @type {{ bubble: Bubble, time: number }[]} */ ([]);

  let active = true;
  let ocrBusy = false;
  let speaking = false;
  let rereadOnReturn = false;
  let englishOnly = true;
  /** Debug option: frame every found bubble on the page. */
  let showBoxes = false;
  const overlay = createOverlay();

  const scheduleDiscovery = throttleToFrame(discoverImages);
  const scheduleVisibilityCheck = throttleToFrame(checkVisibility);
  const mutationObserver = new MutationObserver(scheduleDiscovery);

  start();

  function start() {
    chrome.storage.sync.get({ rereadOnReturn, englishOnly, showBoxes }).then((settings) => {
      rereadOnReturn = settings.rereadOnReturn;
      englishOnly = settings.englishOnly;
      showBoxes = settings.showBoxes;
      renderOverlay();
    });
    chrome.storage.onChanged.addListener(onSettingsChanged);
    chrome.runtime.onMessage.addListener(onMessage);

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });
    // `load` does not bubble, so listen in the capture phase to see lazy images.
    document.addEventListener('load', scheduleDiscovery, true);
    // Capture also catches readers that scroll an inner container.
    document.addEventListener('scroll', scheduleVisibilityCheck, { capture: true, passive: true });
    window.addEventListener('resize', scheduleDiscovery);

    discoverImages();
  }

  function stop() {
    active = false;
    speechQueue.length = 0;

    mutationObserver.disconnect();
    document.removeEventListener('load', scheduleDiscovery, true);
    document.removeEventListener('scroll', scheduleVisibilityCheck, { capture: true });
    window.removeEventListener('resize', scheduleDiscovery);
    overlay.remove();
    try {
      chrome.storage.onChanged.removeListener(onSettingsChanged);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Cut off by an extension reload: the listeners are gone already.
    }

    if (window.__mangaReader === instance) delete window.__mangaReader;
  }

  function onMessage(message) {
    if (message?.type === 'reader:stop') stop();
  }

  function onSettingsChanged(changes, area) {
    if (area !== 'sync') return;
    if (changes.rereadOnReturn) rereadOnReturn = changes.rereadOnReturn.newValue;
    if (changes.englishOnly) englishOnly = changes.englishOnly.newValue;
    if (changes.showBoxes) {
      showBoxes = changes.showBoxes.newValue;
      renderOverlay();
    }
  }

  // -------------------------------------------------------------------------
  // Image discovery and OCR
  // -------------------------------------------------------------------------

  function discoverImages() {
    for (const [img, entry] of images) {
      if (!img.isConnected || img.currentSrc !== entry.url) forgetImage(img);
    }
    for (const img of document.images) {
      if (!images.has(img) && isComicImage(img)) {
        images.set(img, { url: img.currentSrc, status: 'pending' });
      }
    }
    processNextImage();
    checkVisibility();
  }

  /**
   * Comic images directly above and below `img`, as on a webtoon strip. Of two
   * neighbours, the one read second includes the other's edge, so a bubble cut
   * by their border is read whole without reading anything twice.
   */
  function findNeighbours(img) {
    const rect = img.getBoundingClientRect();
    let above;
    let below;
    for (const other of images.keys()) {
      if (other === img) continue;
      const otherRect = other.getBoundingClientRect();
      if (!alignedInColumn(rect, otherRect)) continue;
      if (Math.abs(otherRect.bottom - rect.top) <= MAX_STRIP_GAP) above = other;
      if (Math.abs(otherRect.top - rect.bottom) <= MAX_STRIP_GAP) below = other;
    }
    return { above, below };
  }

  /**
   * Whether an image could still appear on that side of `img`: a comic image,
   * or one that hasn't loaded yet (lazy placeholders are often 1-2 px). Small
   * loaded images, like site logos and avatars, don't count. Without one, `img`
   * is the chapter's first or last page and a bubble at that end is whole.
   */
  function mayHaveNeighbour(img, side) {
    const wanted = side === 'before' ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    for (const other of document.images) {
      if (other === img || !(img.compareDocumentPosition(other) & wanted)) continue;
      if (images.has(other) || !other.complete || other.naturalWidth <= 2) return true;
    }
    return false;
  }

  function alignedInColumn(a, b) {
    const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    return overlap >= 0.9 * Math.min(a.width, b.width);
  }

  function isComicImage(img) {
    return (
      SUPPORTED_URL.test(img.currentSrc) &&
      img.naturalWidth >= MIN_IMAGE_SIZE &&
      img.getBoundingClientRect().width >= MIN_IMAGE_SIZE
    );
  }

  function forgetImage(img) {
    images.delete(img);
    bubbles = bubbles.filter((bubble) => bubble.img !== img);
  }

  /** OCRs one image at a time, always the pending one closest to the viewport. */
  async function processNextImage() {
    if (ocrBusy) return;
    const img = findClosestPendingImage();
    if (!img) return;

    const entry = images.get(img);
    entry.status = 'running';
    const { above, below } = findNeighbours(img);
    ocrBusy = true;
    try {
      const request = chrome.runtime.sendMessage({
        type: 'reader:ocr',
        url: entry.url,
        aboveUrl: above?.currentSrc,
        belowUrl: below?.currentSrc,
        closedTop: !above && !mayHaveNeighbour(img, 'before'),
        closedBottom: !below && !mayHaveNeighbour(img, 'after'),
      });
      const response = await withTimeout(request, OCR_TIMEOUT_MS, 'OCR');
      if (response?.error) throw new Error(response.error);
      // Ignore results for images that were removed or changed meanwhile.
      if (images.get(img) === entry) addBubbles(img, response.bubbles);
      entry.status = 'done';
    } catch (error) {
      // The background keeps working on a slow image and caches the result,
      // so asking again later just picks it up. Real errors are retried once.
      const timedOut = error.name === 'TimeoutError';
      if (timedOut) entry.waits = (entry.waits ?? 0) + 1;
      else entry.attempts = (entry.attempts ?? 0) + 1;
      const giveUp = (entry.attempts ?? 0) >= MAX_OCR_ATTEMPTS || (entry.waits ?? 0) >= MAX_OCR_WAITS;
      entry.status = giveUp ? 'failed' : 'pending';
      console.warn(LOG_PREFIX, timedOut ? 'OCR still running for' : 'OCR failed for', entry.url, error);
    } finally {
      ocrBusy = false;
    }

    if (!active) return;
    checkVisibility();
    processNextImage();
  }

  function findClosestPendingImage() {
    let closest = null;
    let closestDistance = Infinity;
    for (const [img, entry] of images) {
      if (entry.status !== 'pending') continue;
      const rect = img.getBoundingClientRect();
      // Readers scroll down, so images below come before images scrolled past.
      const distance = distanceToViewport(rect) * (rect.bottom < 0 ? 3 : 1);
      if (distance < closestDistance) {
        closest = img;
        closestDistance = distance;
      }
    }
    return closest;
  }

  /**
   * A bubble near an image border can be found by both images; the copy with
   * more text wins, and it keeps the other's read state.
   */
  function addBubbles(img, imageBubbles) {
    const credits = imageBubbles.filter(isCredit).length;
    const creditsPage =
      credits >= CREDITS_PAGE_MIN_COUNT && credits / imageBubbles.length >= CREDITS_PAGE_MIN_SHARE;

    for (const { bbox, text, language, kind } of imageBubbles) {
      const bubble = { img, bbox, text, language, kind, creditsPage, read: false };
      const twin = bubbles.find((other) => isSameBubble(other, bubble));
      if (twin && twin.text.length >= text.length) continue;
      if (twin) {
        bubbles.splice(bubbles.indexOf(twin), 1);
        bubble.read ||= twin.read;
        bubble.state ??= twin.state;
        bubble.skipReason ??= twin.skipReason;
        // A queued copy is replaced in the queue too, so the longer text is spoken.
        const queued = speechQueue.indexOf(twin);
        if (queued >= 0) speechQueue[queued] = bubble;
      }
      bubbles.push(bubble);
    }
    bubbles.sort(compareReadingOrder);
  }

  /**
   * Model boxes are rough: two reads of one bubble rarely match exactly, and a
   * neighbouring bubble's box can overlap it. So a copy needs similar words
   * and a box that overlaps or sits close by.
   */
  function isSameBubble(a, b) {
    const rectA = getViewportRect(a);
    const rectB = getViewportRect(b);
    // A line of a bubble only counts when the boxes overlap: a short nearby
    // bubble ("You!") must not hide a longer one that happens to contain its words.
    // In the same spot, a misread word or two is still the same bubble.
    if (overlapsMostly(rectA, rectB)) {
      return (
        similarWords(a.text, b.text, LOOSE_WORD_MATCH) ||
        isFragmentOf(a.text, b.text) ||
        isFragmentOf(b.text, a.text)
      );
    }
    if (!similarWords(a.text, b.text)) return false;
    const distance = Math.abs(rectA.top + rectA.bottom - rectB.top - rectB.bottom) / 2;
    const height = Math.max(rectA.bottom - rectA.top, rectB.bottom - rectB.top);
    return distance < 3 * height;
  }

  /**
   * A line of a bubble that was also read whole: every word of `part` is in
   * `whole`, which has more words. Same as in lib/ollama-ocr.js.
   */
  function isFragmentOf(part, whole) {
    const partWords = normalizeText(part).split(' ').filter(Boolean);
    const wholeWords = new Set(normalizeText(whole).split(' ').filter(Boolean));
    return (
      partWords.length > 0 &&
      partWords.length < wholeWords.size &&
      partWords.every((word) => wholeWords.has(word))
    );
  }

  /**
   * Why a bubble isn't worth speaking, or null if it is. Credits (watermarks,
   * site and scanlator notes) and sound effects are never read. With "Read
   * only English" on, text in another language or script is skipped too.
   */
  function skipReason({ text, language, kind, creditsPage }) {
    const letters = text.match(/[\p{L}\p{N}]/gu) ?? [];
    if (letters.length === 0) return 'no letters';
    if (creditsPage) return 'credits page';
    if (isCredit({ text, kind })) return 'credit';
    if (kind === 'sound_effect') return 'sound effect';
    if (!englishOnly) return null;
    const latin = letters.filter((char) => LATIN_CHAR.test(char)).length;
    if (latin / letters.length < 0.8) {
      // An English bubble read together with foreign text behind it (a screen,
      // a sign): speechText() keeps the English part.
      return latin >= MIN_ENGLISH_PART ? null : 'not English';
    }
    if (language && language.toLowerCase() !== 'en') return `language: ${language}`;
    return null;
  }

  /** The text to speak: with "Read only English" on, without other scripts. */
  function speechText({ text }) {
    if (!englishOnly) return text;
    return text
      .replace(/[^\p{Script=Latin}\p{N}\p{P}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Most words shared, or a long text inside the other, so a copy cut short
   * matches but "Hey!" doesn't match "Hey, you!". Same as in lib/ollama-ocr.js.
   * `minShared` is the share of all distinct words both texts have.
   */
  function similarWords(a, b, minShared = WORD_MATCH) {
    if (sameLine(a, b)) return true;
    const wordsA = new Set(normalizeText(a).split(' '));
    const wordsB = new Set(normalizeText(b).split(' '));
    const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
    return shared / new Set([...wordsA, ...wordsB]).size >= minShared;
  }

  /** The same line, maybe cut short; not just a few shared words. */
  function sameLine(a, b) {
    const textA = normalizeText(a);
    const textB = normalizeText(b);
    const [shorter, longer] = textA.length < textB.length ? [textA, textB] : [textB, textA];
    return shorter === longer || (shorter.length >= MIN_MATCH_LENGTH && longer.includes(shorter));
  }

  function isCredit({ text, kind }) {
    return kind === 'credit' || CREDIT_PATTERN.test(text) || CREDIT_ROLE_PATTERN.test(text);
  }

  function normalizeText(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function overlapsMostly(a, b) {
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const smallerHeight = Math.min(a.bottom - a.top, b.bottom - b.top);
    return overlapX > 0 && overlapY > smallerHeight / 2;
  }

  function compareReadingOrder(a, b) {
    if (a.img === b.img) return a.bbox.y0 - b.bbox.y0;
    return a.img.compareDocumentPosition(b.img) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  // -------------------------------------------------------------------------
  // Visibility and speech
  // -------------------------------------------------------------------------

  function checkVisibility() {
    for (const bubble of bubbles) {
      const rect = getViewportRect(bubble);
      if (isFullyVisible(rect)) {
        if (!bubble.read) {
          bubble.read = true;
          speechQueue.push(bubble);
        }
      } else if (rereadOnReturn && !intersectsViewport(rect)) {
        bubble.read = false;
      }
    }
    speakNext();
    prepareUpcoming();
    renderOverlay();
  }

  async function speakNext() {
    if (speaking) return;
    const bubble = takeNextVisibleBubble();
    if (!bubble) return;

    speaking = true;
    bubble.state = 'spoken';
    rememberSpoken(bubble);
    prepareUpcoming();
    renderOverlay();
    try {
      const text = speechText(bubble);
      const request = chrome.runtime.sendMessage({ type: 'reader:speak', text });
      const timeout = SPEAK_TIMEOUT_BASE_MS + SPEAK_TIMEOUT_PER_CHAR_MS * text.length;
      const response = await withTimeout(request, timeout, 'Speech');
      if (response?.error) console.warn(LOG_PREFIX, 'Speech failed:', response.error);
    } catch (error) {
      console.warn(LOG_PREFIX, 'Speech failed:', error);
    } finally {
      speaking = false;
    }

    if (active) speakNext();
  }

  function prepareUpcoming() {
    for (const bubble of speechQueue.slice(0, PREPARE_AHEAD)) {
      if (bubble.prepared || skipReason(bubble)) continue;
      bubble.prepared = true;
      chrome.runtime.sendMessage({ type: 'reader:prepare', text: speechText(bubble) }).catch((error) => {
        console.warn(LOG_PREFIX, 'Preparing speech failed:', error);
      });
    }
  }

  /**
   * Skips queued bubbles the user scrolled away from before they were spoken,
   * and copies of bubbles that were already spoken.
   */
  function takeNextVisibleBubble() {
    while (speechQueue.length > 0) {
      const bubble = speechQueue.shift();
      const reason = skipReason(bubble);
      if (reason) {
        bubble.state = 'skipped';
        bubble.skipReason = reason;
        continue;
      }
      const original = findSpokenCopy(bubble);
      if (original) {
        bubble.state = 'repeat';
        bubble.skipReason = `repeat of "${original.text.slice(0, 40)}"`;
        continue;
      }
      if (bubble.img.isConnected && intersectsViewport(getViewportRect(bubble))) return bubble;
      bubble.read = false; // Never spoken, so read it when it comes back.
    }
    return null;
  }

  function rememberSpoken(bubble) {
    spoken.push({ bubble, time: Date.now() });
    if (spoken.length > MAX_SPOKEN_HISTORY) spoken.shift();
  }

  /** The spoken bubble that `bubble` is a copy of, if any. */
  function findSpokenCopy(bubble) {
    const now = Date.now();
    const text = normalizeText(bubble.text);
    const entry = spoken.find(({ bubble: old, time }) => {
      const recent = now - time < REPEAT_GUARD_MS;
      // A long line just spoken is a repeat wherever it came from, but only
      // the same line: "Maybe Kwon Tae-joon?" isn't "Or... Kwon Tae-joon?".
      if (recent && text.length >= MIN_MATCH_LENGTH && sameLine(old.text, bubble.text)) {
        return true;
      }
      return (!rereadOnReturn || recent) && old.img.isConnected && isSameBubble(old, bubble);
    });
    return entry?.bubble;
  }

  // -------------------------------------------------------------------------
  // Debug boxes: frame every found bubble and label every image's OCR status.
  // -------------------------------------------------------------------------

  const BOX_COLORS = {
    found: '#2563eb', // not read yet
    queued: '#f59e0b', // fully visible, waiting for its turn
    spoken: '#16a34a',
    repeat: '#dc2626', // skipped as a copy of a spoken bubble
    skipped: '#6b7280', // credit, sound effect, other language or no letters
    image: '#7c3aed',
  };

  function createOverlay() {
    const element = document.createElement('div');
    element.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
    return element;
  }

  function renderOverlay() {
    if (!showBoxes || !active) {
      overlay.remove();
      return;
    }
    if (!overlay.isConnected) document.documentElement.append(overlay);

    const items = [];
    for (const [img, entry] of images) {
      const rect = img.getBoundingClientRect();
      if (!intersectsViewport(rect)) continue;
      const notes = [
        entry.attempts && `failed ${entry.attempts}×`,
        entry.waits && `slow ${entry.waits}×`,
      ].filter(Boolean);
      const label = `image: ${entry.status}${notes.length ? ` (${notes.join(', ')})` : ''}`;
      items.push(debugLabel(rect.left, Math.max(rect.top, 0), label, BOX_COLORS.image));
    }
    for (const bubble of bubbles) {
      const rect = getViewportRect(bubble);
      if (!intersectsViewport(rect)) continue;
      const state = bubble.state ?? (bubble.read ? 'queued' : 'found');
      const label = bubble.skipReason ? `skipped (${bubble.skipReason})` : state;
      items.push(debugBox(rect, BOX_COLORS[state], `${label}: ${bubble.text}`));
    }
    overlay.replaceChildren(...items);
  }

  function debugBox(rect, color, text) {
    const box = document.createElement('div');
    box.style.cssText =
      `position:absolute;left:${rect.left}px;top:${rect.top}px;` +
      `width:${rect.right - rect.left}px;height:${rect.bottom - rect.top}px;` +
      `border:3px solid ${color};box-sizing:border-box;`;
    box.append(debugLabel(0, 0, text, color));
    return box;
  }

  function debugLabel(left, top, text, color) {
    const label = document.createElement('div');
    label.textContent = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    label.style.cssText =
      `position:absolute;left:${left}px;top:${top}px;max-width:320px;padding:1px 4px;` +
      `background:${color};color:#fff;font:12px/1.3 system-ui,sans-serif;` +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    return label;
  }

  /** Rejects if `promise` hasn't settled after `ms`. */
  function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${what} timed out after ${ms / 1000} s`);
        error.name = 'TimeoutError';
        reject(error);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Maps a bubble from image pixels to viewport coordinates. */
  function getViewportRect({ img, bbox }) {
    const rect = img.getBoundingClientRect();
    const scaleX = rect.width / img.naturalWidth;
    const scaleY = rect.height / img.naturalHeight;
    return {
      top: rect.top + bbox.y0 * scaleY,
      bottom: rect.top + bbox.y1 * scaleY,
      left: rect.left + bbox.x0 * scaleX,
      right: rect.left + bbox.x1 * scaleX,
    };
  }

  function isFullyVisible(rect) {
    return (
      rect.bottom > rect.top && // Hidden images have an empty rect.
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth
    );
  }

  function intersectsViewport(rect) {
    return (
      rect.bottom > rect.top &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function distanceToViewport(rect) {
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > window.innerHeight) return rect.top - window.innerHeight;
    return 0;
  }

  /** Runs `fn` at most once per animation frame, and only while active. */
  function throttleToFrame(fn) {
    let scheduled = false;
    return () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (active) fn();
      });
    };
  }
})();
