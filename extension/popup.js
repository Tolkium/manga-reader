import { isKokoroVoice, KOKORO_VOICES, toKokoroVoiceName } from './lib/kokoro.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/settings.js';

const SAMPLE_TEXT = 'This is how the speech bubbles will sound.';

const ui = {
  toggle: document.getElementById('toggle'),
  status: document.getElementById('status'),
  ocrStatus: document.getElementById('ocr-status'),
  ttsStatus: document.getElementById('tts-status'),
  voice: document.getElementById('voice'),
  kokoroVoices: document.getElementById('kokoro-voices'),
  browserVoices: document.getElementById('browser-voices'),
  rate: document.getElementById('rate'),
  rateValue: document.getElementById('rate-value'),
  pitch: document.getElementById('pitch'),
  pitchValue: document.getElementById('pitch-value'),
  reread: document.getElementById('reread'),
  test: document.getElementById('test'),
};

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const [settings, voices, state] = await Promise.all([
  loadSettings(),
  chrome.tts.getVoices(),
  chrome.runtime.sendMessage({ type: 'popup:get-state', tabId: tab.id }),
]);

renderVoices(voices, settings.voiceName);
ui.rate.value = settings.rate;
ui.pitch.value = settings.pitch;
ui.reread.checked = settings.rereadOnReturn;
renderSliderValues();
renderReadingState(state.reading);
renderStatus(ui.ocrStatus, state.ocr);
renderStatus(ui.ttsStatus, state.tts);
renderVoiceKind();
ui.toggle.disabled = false;

ui.toggle.addEventListener('click', toggleReading);
ui.voice.addEventListener('change', () => {
  renderVoiceKind();
  saveSettings({ voiceName: ui.voice.value });
});
ui.rate.addEventListener('input', renderSliderValues);
ui.pitch.addEventListener('input', renderSliderValues);
// Save on `change` (drag end) to stay within storage.sync write quotas.
ui.rate.addEventListener('change', () => saveSettings({ rate: Number(ui.rate.value) }));
ui.pitch.addEventListener('change', () => saveSettings({ pitch: Number(ui.pitch.value) }));
ui.reread.addEventListener('change', () => saveSettings({ rereadOnReturn: ui.reread.checked }));
ui.test.addEventListener('click', speakSample);

async function toggleReading() {
  ui.toggle.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'popup:toggle', tabId: tab.id });
  ui.toggle.disabled = false;

  if (response?.error) {
    ui.status.textContent = `Can't read this page: ${response.error}`;
    return;
  }
  renderReadingState(response.reading);
}

/** Spoken by the background, so Kokoro voices work too. */
async function speakSample() {
  ui.test.disabled = true;
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
  if (response?.error) renderStatus(ui.ttsStatus, { ready: false, message: response.error });
}

function renderReadingState(reading) {
  ui.toggle.textContent = reading ? 'Stop reading' : 'Start reading';
  ui.toggle.classList.toggle('stop', reading);
  ui.status.textContent = reading
    ? 'Reading bubbles as they come fully into view.'
    : 'Open a chapter, then press Start.';
}

function renderStatus(element, { ready, message }) {
  element.textContent = message;
  element.classList.toggle('error', !ready);
}

/** Kokoro voices need the local server and have no pitch control. */
function renderVoiceKind() {
  const kokoro = isKokoroVoice(ui.voice.value);
  ui.ttsStatus.hidden = !kokoro;
  ui.pitch.disabled = kokoro;
  ui.pitch.title = kokoro ? 'Kokoro voices have a fixed pitch.' : '';
}

function renderSliderValues() {
  ui.rateValue.textContent = `${Number(ui.rate.value).toFixed(1)}×`;
  ui.pitchValue.textContent = `${Number(ui.pitch.value).toFixed(1)}×`;
}

function renderVoices(voiceList, selectedName) {
  for (const { id, label } of KOKORO_VOICES) {
    ui.kokoroVoices.append(new Option(label, toKokoroVoiceName(id)));
  }
  const sorted = [...voiceList].sort(
    (a, b) => (a.lang ?? '').localeCompare(b.lang ?? '') || a.voiceName.localeCompare(b.voiceName),
  );
  for (const { voiceName, lang } of sorted) {
    ui.browserVoices.append(new Option(lang ? `${voiceName} (${lang})` : voiceName, voiceName));
  }
  ui.voice.value = selectedName;
  // Fall back to the default if the saved voice is no longer available.
  if (ui.voice.value !== selectedName) {
    ui.voice.value = DEFAULT_SETTINGS.voiceName;
    saveSettings({ voiceName: ui.voice.value });
  }
}
