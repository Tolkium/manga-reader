import { checkOllama, recognizeImage, warmUpModel } from './lib/ollama-ocr.js';
import { checkTtsServer, isKokoroVoice, kokoroVoiceId } from './lib/kokoro.js';
import { loadSettings, toTtsOptions } from './lib/settings.js';

/** chrome.storage.session key: { [tabId]: origin the reader was started on } */
const READING_TABS_KEY = 'readingTabs';
const FINAL_TTS_EVENTS = new Set(['end', 'interrupted', 'cancelled', 'error']);
const MAX_CACHED_IMAGES = 300;
const KEEP_ALIVE_INTERVAL_MS = 20_000;
const OFFSCREEN_URL = 'offscreen.html';

// ---------------------------------------------------------------------------
// Reading state per tab. Kept in session storage because the service worker
// can be suspended at any time.
// ---------------------------------------------------------------------------

async function getReadingTabs() {
  const { [READING_TABS_KEY]: tabs = {} } = await chrome.storage.session.get(READING_TABS_KEY);
  return tabs;
}

function setReadingTabs(tabs) {
  return chrome.storage.session.set({ [READING_TABS_KEY]: tabs });
}

async function isReading(tabId) {
  return tabId in (await getReadingTabs());
}

async function startReading(tab) {
  const { ocrModel } = await loadSettings();
  warmUpModel(ocrModel).catch((error) => console.warn('Loading the OCR model failed:', error));
  await injectReader(tab.id);
  const tabs = await getReadingTabs();
  tabs[tab.id] = new URL(tab.url).origin;
  await setReadingTabs(tabs);
}

async function stopReading(tabId) {
  const tabs = await getReadingTabs();
  delete tabs[tabId];
  await setReadingTabs(tabs);

  await stopSpeech();
  // The tab may be closed or showing a page without the reader.
  await chrome.tabs.sendMessage(tabId, { type: 'reader:stop' }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

async function toggleReading(tab) {
  if (await isReading(tab.id)) await stopReading(tab.id);
  else await startReading(tab);
  return { reading: await isReading(tab.id) };
}

async function injectReader(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.action.setBadgeText({ tabId, text: 'ON' });
}

// Keep reading across chapter navigation on the same site.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const tabs = await getReadingTabs();
  if (!(tabId in tabs)) return;

  if (tab.url && new URL(tab.url).origin === tabs[tabId]) {
    await injectReader(tabId).catch((error) => console.warn('Re-injecting reader failed:', error));
  } else {
    await stopReading(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (await isReading(tabId)) await stopReading(tabId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-reading' && tab) {
    toggleReading(tab).catch((error) => console.warn('Toggling reader failed:', error));
  }
});

// ---------------------------------------------------------------------------
// OCR via the local Ollama vision model. Results are cached per image, its
// neighbours and model, so scrolling back or re-reading never repeats the work.
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<import('./lib/ollama-ocr.js').Bubble[]>>} */
const ocrCache = new Map();

async function recognize({ url, aboveUrl, belowUrl }) {
  const { ocrModel } = await loadSettings();
  const key = JSON.stringify([ocrModel, url, aboveUrl, belowUrl]);
  if (!ocrCache.has(key)) {
    if (ocrCache.size >= MAX_CACHED_IMAGES) ocrCache.delete(ocrCache.keys().next().value);
    const result = keepAliveWhile(recognizeImage({ url, aboveUrl, belowUrl }, ocrModel));
    result.catch(() => ocrCache.delete(key)); // Allow a retry after failures.
    ocrCache.set(key, result);
  }
  return { bubbles: await ocrCache.get(key) };
}

/**
 * Chrome stops a service worker after 30 s without extension events, and a
 * tall page takes longer than that to OCR. Calling an extension API resets
 * the idle timer (the approach recommended in Chrome's docs).
 */
async function keepAliveWhile(promise) {
  const timer = setInterval(chrome.runtime.getPlatformInfo, KEEP_ALIVE_INTERVAL_MS);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

// ---------------------------------------------------------------------------
// Text to speech. Resolves once the utterance has finished, so the content
// script can speak bubbles one at a time. Kokoro voices play in an offscreen
// document, because a service worker can't play audio.
// ---------------------------------------------------------------------------

async function speak(text, settings) {
  settings ??= await loadSettings();
  if (!isKokoroVoice(settings.voiceName)) return speakWithBrowser(text, settings);

  const result = await speakWithKokoro(text, settings);
  if (!result?.error) return result;
  // Keep reading with the browser's default voice when the server is down.
  console.warn('Kokoro failed, using the browser voice:', result.error);
  return speakWithBrowser(text, { ...settings, voiceName: '' });
}

async function speakWithKokoro(text, { voiceName, rate }) {
  await ensureOffscreenDocument();
  const voice = kokoroVoiceId(voiceName);
  return keepAliveWhile(
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:play', text, voice, rate }),
  );
}

/** Generates an upcoming bubble's audio while the current one plays. */
async function prepareSpeech(text) {
  const { voiceName } = await loadSettings();
  if (!isKokoroVoice(voiceName)) return {};
  await ensureOffscreenDocument();
  const voice = kokoroVoiceId(voiceName);
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:prepare', text, voice });
}

async function stopSpeech() {
  chrome.tts.stop();
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:stop' });
  }
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

/** Chrome closes an audio offscreen document after 30 s of silence. */
let creatingOffscreenDocument = null;
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  creatingOffscreenDocument ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays speech generated by the local Kokoro voice model.',
    })
    .finally(() => {
      creatingOffscreenDocument = null;
    });
  await creatingOffscreenDocument;
}

function speakWithBrowser(text, settings) {
  const options = toTtsOptions(settings);
  return new Promise((resolve) => {
    chrome.tts.speak(
      text,
      {
        ...options,
        onEvent: (event) => {
          if (event.type === 'error') resolve({ error: event.errorMessage });
          else if (FINAL_TTS_EVENTS.has(event.type)) resolve({ status: event.type });
        },
      },
      () => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const messageHandlers = {
  'reader:ocr': (message) => recognize(message),
  'reader:speak': ({ text }) => speak(text),
  'reader:prepare': ({ text }) => prepareSpeech(text),
  'popup:get-state': async ({ tabId }) => ({
    reading: await isReading(tabId),
    ocr: await checkOllama((await loadSettings()).ocrModel),
    tts: await checkTtsServer(),
  }),
  'popup:speak-sample': async ({ text, settings }) => {
    await stopSpeech();
    return speak(text, settings);
  },
  'popup:toggle': async ({ tabId }) => toggleReading(await chrome.tabs.get(tabId)),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = messageHandlers[message?.type];
  if (!handler) return false;

  handler(message).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true; // Keep the channel open for the async response.
});
