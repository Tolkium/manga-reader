# Manga Reader TTS

Chrome/Edge extension that reads manga, manhwa and manhua speech bubbles aloud as
you scroll. Comic sites serve the dialogue as part of the page images. The
extension sends each image to a vision model running on your own PC (Qwen3-VL
via [Ollama](https://ollama.com)), which returns every bubble's text and position.
Each bubble is then spoken once it is **fully** visible on screen, either with
the browser's built-in text-to-speech or with Kokoro-82M, a natural-sounding AI
voice that also runs on your PC. Nothing leaves your computer.

## Requirements

- Ollama, plus a GPU with about 8 GB of free VRAM. Qwen3-VL 8B uses about 6 GB.
- For Kokoro voices: Python 3.10+ and under 1 GB more VRAM. Without a GPU it
  runs on the CPU, more slowly.

## Setup

1. Install Ollama and download the model:

   ```powershell
   ollama pull qwen3-vl:8b-instruct
   ```

2. Allow browser extensions to call Ollama. This is a one-time, user-level setting:

   ```powershell
   [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'chrome-extension://*', 'User')
   ```

   Then quit Ollama from the system tray and start it again.

3. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**,
   click **Load unpacked** and select the `extension` folder.

The popup shows **OCR ready** when Ollama and the model are reachable. Otherwise
it says what is missing.

### Kokoro voices

1. Install the Python packages. RTX 50-series cards need the CUDA 12.8 build of
   PyTorch:

   ```powershell
   pip install torch --index-url https://download.pytorch.org/whl/cu128
   pip install -r tts-server\requirements.txt
   ```

2. Start the server with `tts-server\start.bat` and leave its window open while
   reading. It listens on `http://127.0.0.1:5005` only. The first start downloads
   the model and voices (about 350 MB).

3. In the popup, pick a voice under **Kokoro (local AI)**. Heart is the default.
   The line under the voice list shows **Kokoro ready** when the server is
   reachable. If the server isn't running, bubbles are read with the browser's
   default voice instead.

## Use

1. Open a chapter page.
2. Click the extension icon and press **Start reading**, or press `Alt+Shift+R`.
   The icon shows an `ON` badge while reading is on.
3. Scroll at your own pace. Each bubble is read once it is completely on screen.

Reading stays on when you go to the next chapter on the same site. It turns off
when the tab leaves that site.

### Settings (popup)

| Setting | Effect |
| --- | --- |
| Voice | **Kokoro (local AI)**: 10 female voices (US and UK) and 5 male voices. **Browser voices**: any voice installed in the browser/OS. In Chrome this includes the free "Google US English" and "Google UK English" voices. |
| Speech rate | 0.3× – 6×. How fast it really gets depends on the voice; some cap at about 3×. Kokoro voices play at 0.5× – 4× and keep their natural pitch when sped up. |
| Pitch | 0× – 2× (2× is the browser's maximum). How strongly pitch changes the sound depends on the voice. Not available for Kokoro voices. |
| Re-read text when scrolling back | Off: a bubble is read only once per page load. On: a bubble is read again after it has left the screen completely and comes back. |

## How it works

```
content.js (page)            background.js (service worker)        Ollama (localhost:11434)
  find comic images  ──ocr──▶  fetch image, cut into tiles  ──tile──▶  qwen3-vl:8b-instruct
  map bubbles to screen ◀──────  merge tiles, cache per URL  ◀─JSON──  text + box per bubble
  queue fully visible ──speak─▶ chrome.tts (rate, pitch, voice)
                               or offscreen.js ──text──▶ tts-server (localhost:5005)
                                  plays WAV  ◀──audio──  Kokoro-82M (PyTorch)
```

- **content.js** tracks images at least 300 px wide and OCRs them one at a time,
  starting with the one closest to the viewport. It maps bubble boxes onto the
  screen on every scroll frame and queues bubbles that are fully visible. A queued
  bubble that has scrolled out of view before its turn is skipped, and it stays
  unread until it comes back into view.
- **lib/ollama-ocr.js** cuts tall webtoon strips into overlapping tiles (1.5×
  the image width tall). Each tile is sent to the model, which is constrained to
  return JSON. Bubbles cut by a tile edge are dropped, because they appear whole
  in the neighbouring tile, and duplicates from the overlap are merged.
- On an RTX 5080 a tile takes about 1 second. A typical chapter (18 tall images)
  takes about 3 minutes, which keeps well ahead of normal reading.
- **Kokoro voices**: `tts-server/kokoro_server.py` turns a bubble's text into a
  WAV file. The background plays it in an offscreen document, because a service
  worker can't play audio. While one bubble plays, the next two queued bubbles
  are generated ahead. On an RTX 5080 a bubble takes about 0.1 seconds.

To try another Ollama vision model, change `MODEL` in `lib/ollama-ocr.js`.

## Limitations

- The first image of a chapter takes about 10 seconds before its first bubble can
  be read, because an image is processed in full before any of its bubbles are
  read.
- A bubble taller than half the image width can be cut by every tile and missed.
- Images from hosts that block requests without the page's referrer can't be
  fetched, so they are skipped. The reason is logged in the page console.
