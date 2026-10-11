// Injected into a tab while reading is on. Finds comic images, asks the
// background for their OCR'd bubbles and queues each bubble for speech once
// it is fully visible in the viewport.
(() => {
  // The background re-injects on every page load; keep one instance per page.
  if (window.__mangaReaderActive) return;
  window.__mangaReaderActive = true;

  /** Rendered and natural size an image needs to count as a comic page. */
  const MIN_IMAGE_SIZE = 300;
  const SUPPORTED_URL = /^(https?|data):/;
  const LOG_PREFIX = '[Manga Reader]';
  /** Queued bubbles whose audio is generated ahead (used by Kokoro voices). */
  const PREPARE_AHEAD = 2;

  /**
   * @typedef {{ x0: number, y0: number, x1: number, y1: number }} BBox
   * @typedef {{ img: HTMLImageElement, bbox: BBox, text: string, read: boolean, prepared?: boolean }} Bubble
   * @typedef {{ url: string, status: 'pending' | 'running' | 'done' | 'failed' }} ImageEntry
   */

  /** @type {Map<HTMLImageElement, ImageEntry>} */
  const images = new Map();
  /** All known bubbles, in reading order. @type {Bubble[]} */
  let bubbles = [];
  /** @type {Bubble[]} */
  const speechQueue = [];

  let active = true;
  let ocrBusy = false;
  let speaking = false;
  let rereadOnReturn = false;

  const scheduleDiscovery = throttleToFrame(discoverImages);
  const scheduleVisibilityCheck = throttleToFrame(checkVisibility);
  const mutationObserver = new MutationObserver(scheduleDiscovery);

  start();

  function start() {
    chrome.storage.sync.get({ rereadOnReturn }).then((settings) => {
      rereadOnReturn = settings.rereadOnReturn;
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

    chrome.storage.onChanged.removeListener(onSettingsChanged);
    chrome.runtime.onMessage.removeListener(onMessage);
    mutationObserver.disconnect();
    document.removeEventListener('load', scheduleDiscovery, true);
    document.removeEventListener('scroll', scheduleVisibilityCheck, { capture: true });
    window.removeEventListener('resize', scheduleDiscovery);

    delete window.__mangaReaderActive;
  }

  function onMessage(message) {
    if (message?.type === 'reader:stop') stop();
  }

  function onSettingsChanged(changes, area) {
    if (area === 'sync' && changes.rereadOnReturn) {
      rereadOnReturn = changes.rereadOnReturn.newValue;
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
    ocrBusy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'reader:ocr', url: entry.url });
      if (response?.error) throw new Error(response.error);
      // Ignore results for images that were removed or changed meanwhile.
      if (images.get(img) === entry) addBubbles(img, response.bubbles);
      entry.status = 'done';
    } catch (error) {
      entry.status = 'failed';
      console.warn(LOG_PREFIX, 'OCR failed for', entry.url, error);
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
      const distance = distanceToViewport(img.getBoundingClientRect());
      if (distance < closestDistance) {
        closest = img;
        closestDistance = distance;
      }
    }
    return closest;
  }

  function addBubbles(img, imageBubbles) {
    for (const { bbox, text } of imageBubbles) {
      bubbles.push({ img, bbox, text, read: false });
    }
    bubbles.sort(compareReadingOrder);
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
  }

  async function speakNext() {
    if (speaking) return;
    const bubble = takeNextVisibleBubble();
    if (!bubble) return;

    speaking = true;
    prepareUpcoming();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'reader:speak', text: bubble.text });
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
      if (bubble.prepared) continue;
      bubble.prepared = true;
      chrome.runtime.sendMessage({ type: 'reader:prepare', text: bubble.text }).catch((error) => {
        console.warn(LOG_PREFIX, 'Preparing speech failed:', error);
      });
    }
  }

  /** Skips queued bubbles the user scrolled away from before they were spoken. */
  function takeNextVisibleBubble() {
    while (speechQueue.length > 0) {
      const bubble = speechQueue.shift();
      if (bubble.img.isConnected && intersectsViewport(getViewportRect(bubble))) return bubble;
      bubble.read = false; // Never spoken, so read it when it comes back.
    }
    return null;
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
