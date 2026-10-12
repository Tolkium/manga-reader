import { fetchVoices, isKokoroVoice, KOKORO_VOICES, toKokoroVoiceName } from './lib/kokoro.js';
import { listVisionModels, OCR_MODELS } from './lib/ollama-ocr.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/settings.js';

const SAMPLE_TEXT = 'This is how the speech bubbles will sound.';
/** Status is checked again while the popup is open, e.g. after start.bat. */
const STATUS_REFRESH_MS = 4000;
/** chrome.storage.local: what the popup last showed, so it opens with it. */
const POPUP_CACHE_KEY = 'popupCache';
/** chrome.storage.session: tabs that are reading (kept by the background). */
const READING_TABS_KEY = 'readingTabs';
const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6L13.5 8z"/></svg>';
const PLAYING_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h2.5v6H3zM6.75 2.5h2.5v11h-2.5zM10.5 6h2.5v4h-2.5z"/></svg>';

const ui = {
  version: document.getElementById('version'),
  stateTag: document.getElementById('state-tag'),
  toggle: document.getElementById('toggle'),
  toggleLabel: document.getElementById('toggle-label'),
  iconPlay: document.querySelector('#toggle .icon-play'),
  iconStop: document.querySelector('#toggle .icon-stop'),
  hint: document.getElementById('hint'),
  statOcr: document.getElementById('stat-ocr'),
  statDetector: document.getElementById('stat-detector'),
  statVoice: document.getElementById('stat-voice'),
  note: document.getElementById('note'),
  noteText: document.getElementById('note-text'),
  voice: document.getElementById('voice'),
  kokoroVoices: document.getElementById('kokoro-voices'),
  browserVoices: document.getElementById('browser-voices'),
  test: document.getElementById('test'),
  rate: document.getElementById('rate'),
  rateValue: document.getElementById('rate-value'),
  pitch: document.getElementById('pitch'),
  pitchRow: document.getElementById('pitch-row'),
  pitchValue: document.getElementById('pitch-value'),
  ocrModel: document.getElementById('ocr-model'),
  englishOnly: document.getElementById('english-only'),
  reread: document.getElementById('reread'),
  showBoxes: document.getElementById('show-boxes'),
  guide: document.getElementById('guide'),
};

followSystemTheme();
ui.test.innerHTML = PLAY_ICON;

// The popup stays hidden (body.loading) until it shows the real state, so it
// never flashes its default layout. Only quick, local data is awaited here:
// settings, the reading flag, and the lists and status saved last time. Fresh
// lists and status follow once the popup is visible.
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const [settings, browserVoices, shortcut, cache, readingTabs] = await Promise.all([
  loadSettings(),
  chrome.tts.getVoices(),
  getShortcut(),
  chrome.storage.local.get(POPUP_CACHE_KEY).then((items) => items[POPUP_CACHE_KEY] ?? {}),
  chrome.storage.session.get(READING_TABS_KEY).then((items) => items[READING_TABS_KEY] ?? {}),
]);
/** Latest status from the background. */
let state = {
  reading: tab.id in readingTabs,
  ocr: cache.ocr ?? null,
  server: cache.server ?? { ready: false, detector: false },
};
/** Kokoro voices and Ollama vision models, as last shown. */
let lists = { kokoroVoices: cache.kokoroVoices ?? KOKORO_VOICES, visionModels: cache.visionModels ?? null };
/** An error from the last sample, shown until the voice changes. */
let voiceError = '';
/** An error from the last start, shown until the next start or stop. */
let toggleError = '';

ui.version.textContent = `v${chrome.runtime.getManifest().version_name}`;
renderBrowserVoices(browserVoices);
renderKokoroVoices(lists.kokoroVoices);
selectVoice(settings.voiceName, { listsAreFresh: false });
renderOcrModels(settings.ocrModel, lists.visionModels);
ui.rate.value = settings.rate;
ui.pitch.value = settings.pitch;
ui.englishOnly.checked = settings.englishOnly;
ui.reread.checked = settings.rereadOnReturn;
ui.showBoxes.checked = settings.showBoxes;
renderSliders();
renderVoiceKind();
renderReadingState();
renderStatus();
ui.toggle.disabled = false;
document.body.classList.remove('loading');

refreshLists();
refreshState();
setInterval(refreshState, STATUS_REFRESH_MS);

ui.toggle.addEventListener('click', toggleReading);
ui.voice.addEventListener('change', () => {
  voiceError = '';
  renderVoiceKind();
  renderStatus();
  saveSettings({ voiceName: ui.voice.value });
});
ui.test.addEventListener('click', speakSample);
ui.rate.addEventListener('input', renderSliders);
ui.pitch.addEventListener('input', renderSliders);
// Save on `change` (drag end) to stay within storage.sync write quotas.
ui.rate.addEventListener('change', () => saveSettings({ rate: Number(ui.rate.value) }));
ui.pitch.addEventListener('change', () => saveSettings({ pitch: Number(ui.pitch.value) }));
ui.ocrModel.addEventListener('change', async () => {
  await saveSettings({ ocrModel: ui.ocrModel.value });
  await refreshState();
});
ui.englishOnly.addEventListener('change', () => saveSettings({ englishOnly: ui.englishOnly.checked }));
ui.reread.addEventListener('change', () => saveSettings({ rereadOnReturn: ui.reread.checked }));
ui.showBoxes.addEventListener('change', () => saveSettings({ showBoxes: ui.showBoxes.checked }));
ui.guide.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('guide.html') });
  window.close();
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function refreshState() {
  try {
    state = await chrome.runtime.sendMessage({ type: 'popup:get-state', tabId: tab.id });
  } catch {
    return; // The service worker is restarting; try again on the next tick.
  }
  saveCache({ ocr: state.ocr, server: state.server });
  renderReadingState();
  renderStatus();
}

/** Fresh voice and model lists; the dropdowns only change if the lists did. */
async function refreshLists() {
  const [kokoroVoices, visionModels] = await Promise.all([fetchVoices(), listVisionModels()]);
  const fresh = { kokoroVoices, visionModels: visionModels ?? lists.visionModels };
  if (JSON.stringify(fresh.kokoroVoices) !== JSON.stringify(lists.kokoroVoices)) {
    renderKokoroVoices(fresh.kokoroVoices);
  }
  if (JSON.stringify(fresh.visionModels) !== JSON.stringify(lists.visionModels)) {
    renderOcrModels(ui.ocrModel.value || settings.ocrModel, fresh.visionModels);
  }
  lists = fresh;
  selectVoice(ui.voice.value || settings.voiceName, { listsAreFresh: true });
  renderVoiceKind();
  saveCache(lists);
}

/** Remembers what the popup showed, so it opens with it next time. */
async function saveCache(changes) {
  const { [POPUP_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(POPUP_CACHE_KEY);
  await chrome.storage.local.set({ [POPUP_CACHE_KEY]: { ...cache, ...changes } });
}

async function toggleReading() {
  ui.toggle.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'popup:toggle', tabId: tab.id });
  ui.toggle.disabled = false;

  toggleError = response?.error ? `Can't read this page: ${response.error}` : '';
  if (!response?.error) state.reading = response.reading;
  renderReadingState();
}

/** Spoken by the background, so Kokoro voices work too. */
async function speakSample() {
  ui.test.disabled = true;
  ui.test.classList.add('playing');
  ui.test.innerHTML = PLAYING_ICON;
  const response = await chrome.runtime.sendMessage({
    type: 'popup:speak-sample',
    text: SAMPLE_TEXT,
    settings: {
      voiceName: ui.voice.value,
      rate: Number(ui.rate.value),
      pitch: Number(ui.pitch.value),
    },
  });
  ui.test.disabled = false;
  ui.test.classList.remove('playing');
  ui.test.innerHTML = PLAY_ICON;
  voiceError = response?.error ?? '';
  renderStatus();
}

/** The shortcut the user actually has, which they can change in Chrome. */
async function getShortcut() {
  const commands = await chrome.commands.getAll();
  return commands.find(({ name }) => name === 'toggle-reading')?.shortcut ?? '';
}

/** The design has a light and a dark version, picked by `data-pt`. */
function followSystemTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => (document.body.dataset.pt = dark.matches ? 'dark' : 'light');
  apply();
  dark.addEventListener('change', apply);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReadingState() {
  const { reading } = state;
  ui.toggleLabel.textContent = reading ? 'Stop reading' : 'Start reading';
  ui.toggle.classList.toggle('stop', reading);
  ui.toggle.classList.toggle('start', !reading);
  ui.iconPlay.hidden = reading;
  ui.iconStop.hidden = !reading;
  ui.stateTag.textContent = reading ? 'On' : 'Off'; // 'Reading' doesn't fit next to the title.
  ui.stateTag.classList.toggle('on', reading);

  const text = document.createElement('span');
  ui.hint.classList.toggle('err', Boolean(toggleError));
  ui.hint.title = toggleError;
  if (toggleError) {
    text.textContent = toggleError;
    ui.hint.replaceChildren(text);
    return;
  }
  text.textContent = reading ? 'Bubbles are read as they come into view.' : 'Open a chapter, then press Start.';
  ui.hint.replaceChildren(text);
  if (shortcut && !reading) {
    const kbd = document.createElement('kbd');
    kbd.textContent = shortcut;
    ui.hint.append(kbd);
  }
}

/** Three status chips, plus one note explaining the most important problem. */
function renderStatus() {
  const { ocr, server } = state;
  const notes = [];

  if (!ocr) setStat(ui.statOcr, 'chk', 'Checking…');
  else if (ocr.ready) setStat(ui.statOcr, 'ok', `Text model ready: ${shortModelName(ui.ocrModel.value)}.`);
  else {
    setStat(ui.statOcr, 'err', ocr.message);
    notes.push({ level: 'err', text: ocr.message });
  }

  if (server.detector) setStat(ui.statDetector, 'ok', 'Bubble finder ready.');
  else if (server.ready) setStat(ui.statDetector, 'warn', 'Bubble finder is still loading.');
  else setStat(ui.statDetector, 'warn', 'Local server not found. Reading will be slower and less exact.');

  const kokoro = isKokoroVoice(ui.voice.value);
  if (voiceError) {
    setStat(ui.statVoice, 'err', voiceError);
    notes.push({ level: 'err', text: voiceError });
  } else if (kokoro && !server.ready) {
    setStat(ui.statVoice, 'warn', 'AI voices need the local server. Using a browser voice.');
  } else {
    setStat(ui.statVoice, 'ok', kokoro ? 'Kokoro voice ready.' : 'Browser voice ready.');
  }

  if (!server.ready) {
    notes.push({ level: 'warn', code: true });
  }
  renderNote(notes[0]);
}

/** @param {'ok' | 'warn' | 'err' | 'chk'} level */
function setStat(stat, level, tip) {
  stat.classList.remove('ok', 'warn', 'err', 'chk');
  stat.classList.add(level);
  stat.dataset.tip = tip;
}

function renderNote(note) {
  ui.note.hidden = !note;
  if (!note) return;
  ui.note.classList.toggle('err', note.level === 'err');
  if (note.code) {
    const code = document.createElement('code');
    code.textContent = 'tts-server\\start.bat';
    ui.noteText.replaceChildren('Run ', code, ' for faster, more exact reading and the AI voices.');
  } else {
    ui.noteText.textContent = note.text;
  }
}

function shortModelName(id) {
  return OCR_MODELS.find((model) => model.id === id)?.label.split(' (')[0] ?? id;
}

/** Kokoro voices have a fixed pitch, so the pitch row only shows for browser voices. */
function renderVoiceKind() {
  ui.pitchRow.hidden = isKokoroVoice(ui.voice.value);
}

/** Value labels, and the filled part of each track (the design's --p). */
function renderSliders() {
  for (const [slider, output] of [
    [ui.rate, ui.rateValue],
    [ui.pitch, ui.pitchValue],
  ]) {
    const value = Number(slider.value);
    const share = (value - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    slider.style.setProperty('--p', `${share * 100}%`);
    output.textContent = `${value.toFixed(1)}×`;
  }
}

/**
 * Recommended models first, marked when not installed, then every other
 * installed vision model, so a model pulled with `ollama pull` shows up here.
 * @param {string[] | null} installed Null when Ollama couldn't be asked.
 */
function renderOcrModels(selectedModel, installed) {
  ui.ocrModel.replaceChildren();
  const recommended = document.createElement('optgroup');
  recommended.label = 'Recommended';
  for (const { id, label } of OCR_MODELS) {
    const missing = installed && !installed.includes(id);
    recommended.append(new Option(missing ? `${label} · not installed` : label, id));
  }
  ui.ocrModel.append(recommended);

  const known = new Set(OCR_MODELS.map(({ id }) => id));
  const others = (installed ?? []).filter((name) => !known.has(name));
  // Keep a saved model selectable even if it's no longer installed.
  if (selectedModel && !known.has(selectedModel) && !others.includes(selectedModel)) others.push(selectedModel);
  if (others.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Other installed models';
    for (const name of others) group.append(new Option(name, name));
    ui.ocrModel.append(group);
  }

  ui.ocrModel.value = selectedModel;
  if (ui.ocrModel.value !== selectedModel) ui.ocrModel.value = DEFAULT_SETTINGS.ocrModel;
}

/** @param {readonly { id: string, label: string }[]} kokoroList From tts-server/settings.json. */
function renderKokoroVoices(kokoroList) {
  const selected = ui.voice.value;
  ui.kokoroVoices.replaceChildren(
    ...kokoroList.map(({ id, label }) => new Option(label, toKokoroVoiceName(id))),
  );
  if (selected) ui.voice.value = selected;
}

function renderBrowserVoices(voiceList) {
  const sorted = [...voiceList].sort(
    (a, b) => (a.lang ?? '').localeCompare(b.lang ?? '') || a.voiceName.localeCompare(b.voiceName),
  );
  ui.browserVoices.replaceChildren(
    new Option('System default', ''),
    ...sorted.map(({ voiceName, lang }) => new Option(lang ? `${voiceName} (${lang})` : voiceName, voiceName)),
  );
}

/**
 * Selects the saved voice. If it's no longer offered, the default is used, and
 * only saved as the new choice once the lists are fresh rather than last
 * time's, so a stale list can't overwrite the user's voice.
 */
function selectVoice(selectedName, { listsAreFresh }) {
  ui.voice.value = selectedName;
  if (ui.voice.value === selectedName) return;
  ui.voice.value = DEFAULT_SETTINGS.voiceName;
  if (listsAreFresh) saveSettings({ voiceName: ui.voice.value });
}
