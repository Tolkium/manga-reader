/**
 * The local server in `tts-server/` (local_server.py): Kokoro voices and the
 * speech-bubble detector.
 */

export const LOCAL_SERVER_URL = 'http://127.0.0.1:5005';
const DETECT_TIMEOUT_MS = 60_000;

/** @returns {Promise<{ ready: boolean, message: string, detector?: boolean }>} */
export async function checkLocalServer() {
  try {
    const response = await fetch(`${LOCAL_SERVER_URL}/health`);
    return await response.json();
  } catch {
    return { ready: false, message: 'Local server is not running. Run tts-server\\start.bat' };
  }
}

/**
 * Finds speech bubbles and caption boxes in a strip.
 * @param {{ top: number, image: string }[]} tiles Base64 JPEG tiles of the
 *   strip with their y offset in it.
 * @returns {Promise<{ x0: number, y0: number, x1: number, y1: number }[]>}
 *   One region per bubble, in strip pixels.
 */
export async function detectRegions(tiles) {
  const response = await fetch(`${LOCAL_SERVER_URL}/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tiles }),
    signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw new Error(`Bubble detector error (HTTP ${response.status}): ${error ?? response.statusText}`);
  }
  return (await response.json()).regions;
}
