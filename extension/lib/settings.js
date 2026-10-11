/** User settings, synced across the user's browsers. */

export const DEFAULT_SETTINGS = Object.freeze({
  /** A `kokoro:` voice, a browser voice, or '' for the system default voice. */
  voiceName: 'kokoro:af_heart',
  rate: 1,
  pitch: 1,
  /** Read a bubble again after it scrolled fully out of view and back in. */
  rereadOnReturn: false,
});

/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
export function loadSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

/** @param {Partial<typeof DEFAULT_SETTINGS>} changes */
export function saveSettings(changes) {
  return chrome.storage.sync.set(changes);
}

/** @param {typeof DEFAULT_SETTINGS} settings */
export function toTtsOptions({ voiceName, rate, pitch }) {
  return voiceName ? { voiceName, rate, pitch } : { rate, pitch };
}
