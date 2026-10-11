// Plays Kokoro speech. Service workers can't play audio, so the background
// opens this page as an offscreen document and sends it play requests.
import { fetchSpeech } from './lib/kokoro.js';

const MAX_CACHED_CLIPS = 30;
// Chrome mutes media played faster than 4×.
const MIN_RATE = 0.5;
const MAX_RATE = 4;

/** Generated clips by voice and text, so bubbles prepared ahead play at once. */
const clips = new Map();
/** @type {{ audio?: HTMLAudioElement, finish?: (status: string) => void } | null} */
let current = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'offscreen:play') {
    play(message).then(sendResponse, (error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'offscreen:prepare') {
    getClip(message.text, message.voice).catch(() => {}); // Reported when played.
  } else if (message.type === 'offscreen:stop') {
    stop();
  }
  sendResponse({});
  return false;
});

function getClip(text, voice) {
  const key = `${voice}\n${text}`;
  if (!clips.has(key)) {
    if (clips.size >= MAX_CACHED_CLIPS) clips.delete(clips.keys().next().value);
    const clip = fetchSpeech(text, voice);
    clip.catch(() => clips.delete(key)); // Allow a retry after failures.
    clips.set(key, clip);
  }
  return clips.get(key);
}

/** Resolves once the clip has finished or was stopped. */
async function play({ text, voice, rate }) {
  stop();
  const playback = {};
  current = playback;

  const clip = await getClip(text, voice);
  if (current !== playback) return { status: 'interrupted' };

  const url = URL.createObjectURL(clip);
  const audio = new Audio(url);
  audio.preservesPitch = true; // Faster speech without the chipmunk effect.
  audio.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  playback.audio = audio;

  return new Promise((resolve) => {
    playback.finish = (status) => {
      audio.pause();
      URL.revokeObjectURL(url);
      if (current === playback) current = null;
      resolve({ status });
    };
    audio.onended = () => playback.finish('end');
    audio.onerror = () => playback.finish('error');
    audio.play().catch(() => playback.finish('error'));
  });
}

function stop() {
  const playback = current;
  current = null;
  playback?.finish?.('interrupted');
}
