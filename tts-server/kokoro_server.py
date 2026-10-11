"""Local Kokoro-82M TTS server for the Manga Reader extension.

    python kokoro_server.py            # serves http://127.0.0.1:5005

GET  /health                  -> {"ready": bool, "message": str}
POST /tts {"text", "voice"}   -> audio/wav, 24 kHz mono
"""
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from kokoro import KModel, KPipeline

HOST, PORT = "127.0.0.1", 5005
REPO_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24_000
# The first letter of a voice is its accent: a = American, b = British.
VOICES = (
    "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_nova",
    "af_sky", "bf_emma", "bf_isabella", "am_michael", "am_fenrir", "am_puck", "bm_george",
    "bm_fable",
)  # fmt: skip

device = "cuda" if torch.cuda.is_available() else "cpu"
model = KModel(repo_id=REPO_ID).to(device).eval()
pipelines = {lang: KPipeline(lang_code=lang, repo_id=REPO_ID, model=model) for lang in "ab"}
model_lock = threading.Lock()


def synthesize(text, voice):
    with model_lock, torch.inference_mode():
        parts = [r.audio.cpu().numpy() for r in pipelines[voice[0]](text, voice=voice)
                 if r.audio is not None]  # fmt: skip
    return to_wav(np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32))


def to_wav(audio):
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


def warm_up():
    """Loads every voice and runs the GPU once, so the first bubble isn't slow."""
    for voice in VOICES:
        pipelines[voice[0]].load_voice(voice)
    synthesize("Ready.", VOICES[0])


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ready": True, "message": f"Kokoro ready ({device.upper()})"})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/tts":
            return self.send_json(404, {"error": "Not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            text = str(body.get("text", "")).strip()
            voice = body.get("voice", VOICES[0])
            if not text:
                return self.send_json(400, {"error": "No text"})
            if voice not in VOICES:
                return self.send_json(400, {"error": f"Unknown voice {voice!r}"})
            wav = synthesize(text, voice)
        except Exception as error:  # Report any failure to the extension.
            return self.send_json(500, {"error": str(error)})

        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        pass  # Keep the console quiet; errors are returned to the extension.


if __name__ == "__main__":
    warm_up()
    print(f"Kokoro TTS server on http://{HOST}:{PORT} ({device})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
