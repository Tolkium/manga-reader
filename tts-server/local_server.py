"""Local AI server for the Manga Reader extension: Kokoro-82M voices and a
comic speech-bubble detector, both on the GPU.

    python local_server.py            # serves http://127.0.0.1:5005

GET  /health                          -> {"ready": bool, "message": str, "detector": bool}
GET  /voices                          -> {"voices": [{"id", "label"}]}, from settings.json
POST /tts {"text", "voice"}           -> audio/wav, 24 kHz mono
POST /detect {"tiles": [{"top", "image"}]}
                                      -> {"regions": [{"x0", "y0", "x1", "y1"}]}

/detect takes JPEG tiles (base64) of one image strip, each with its y offset in
the strip, and returns one region per bubble or caption box in strip pixels.
"""
import base64
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from kokoro import KModel, KPipeline
from PIL import Image
from transformers import RTDetrImageProcessor, RTDetrV2ForObjectDetection

HOST, PORT = "127.0.0.1", 5005
REPO_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24_000
SETTINGS_FILE = Path(__file__).with_name("settings.json")
# Kokoro accents this server supports: the first letter of a voice id.
ACCENTS = {"a": "American English", "b": "British English"}


def load_voices():
    """Voices from settings.json, so they can be changed without editing code."""
    settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    voices = []
    for entry in settings.get("voices", []):
        voice_id = str(entry.get("id", "")).strip()
        if len(voice_id) < 4 or voice_id[0] not in ACCENTS or voice_id[2] != "_":
            print(f"settings.json: skipping {voice_id!r}, not an English Kokoro voice id like af_heart")
            continue
        voices.append({"id": voice_id, "label": str(entry.get("label") or voice_id)})
    if not voices:
        raise SystemExit("settings.json lists no usable voices.")
    return voices


VOICE_LIST = load_voices()
VOICES = tuple(voice["id"] for voice in VOICE_LIST)

# RT-DETR-v2 trained on manga, webtoon, manhua and western comics (Apache-2.0).
DETECTOR_ID = "ogkalu/comic-text-and-bubble-detector"
BUBBLE, TEXT_IN_BUBBLE, FREE_TEXT = 0, 1, 2
DETECTION_THRESHOLD = 0.4
FREE_TEXT_THRESHOLD = 0.6
DETECTION_BATCH = 16
# Copies of one box from overlapping tiles: intersection over union.
SAME_BOX_IOU = 0.5
# A box cut by a tile edge belongs to the whole one covering this much of it.
CUT_BOX_COVERED = 0.5
# Pixels: a box this close to an inner tile edge was cut by it.
CUT_EDGE_MARGIN = 3
# Other text this close to a region (share of its size) is painted over in its
# cut-out. Covers the extension's crop margin with room to spare.
MASK_REACH = 0.1

device = "cuda" if torch.cuda.is_available() else "cpu"
model = KModel(repo_id=REPO_ID).to(device).eval()
pipelines = {lang: KPipeline(lang_code=lang, repo_id=REPO_ID, model=model) for lang in "ab"}
detector_processor = RTDetrImageProcessor.from_pretrained(DETECTOR_ID)
detector = RTDetrV2ForObjectDetection.from_pretrained(DETECTOR_ID).to(device).eval()
gpu_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Text to speech
# ---------------------------------------------------------------------------


def synthesize(text, voice):
    with gpu_lock, torch.inference_mode():
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


# ---------------------------------------------------------------------------
# Bubble detection
# ---------------------------------------------------------------------------


def detect(tiles):
    """Returns bubble regions in strip pixels, top to bottom.

    Text inside a bubble becomes the whole bubble, so lettering that spills
    past the text box is still read. Free text (captions, narration) keeps its
    own box. Overlapping tiles find the same box twice; those are merged, but
    a box that merely lies inside another (a bubble over a screen full of
    text) stays separate.
    """
    strip_height = max(top + image.size[1] for top, image in tiles)
    bubbles, texts = [], []
    for start in range(0, len(tiles), DETECTION_BATCH):
        batch = tiles[start : start + DETECTION_BATCH]
        images = [image for _, image in batch]
        inputs = detector_processor(images=images, return_tensors="pt").to(device)
        with gpu_lock, torch.inference_mode():
            outputs = detector(**inputs)
        sizes = torch.tensor([image.size[::-1] for image in images], device=device)
        results = detector_processor.post_process_object_detection(
            outputs, threshold=DETECTION_THRESHOLD, target_sizes=sizes
        )
        for (top, image), result in zip(batch, results):
            tile_height = image.size[1]
            detections = zip(result["scores"].tolist(), result["labels"].tolist(), result["boxes"].tolist())
            for score, label, (x0, y0, x1, y1) in detections:
                # Loose text on the artwork is where false hits happen (windows
                # of buildings read as lettering), so it needs more confidence.
                if label == FREE_TEXT and score < FREE_TEXT_THRESHOLD:
                    continue
                cut = (top > 0 and y0 <= CUT_EDGE_MARGIN) or (
                    top + tile_height < strip_height and y1 >= tile_height - CUT_EDGE_MARGIN
                )
                box = ((x0, y0 + top, x1, y1 + top), cut)
                (bubbles if label == BUBBLE else texts).append(box)

    bubbles, texts = merge_boxes(bubbles), merge_boxes(texts)
    regions = []
    for text in texts:
        holders = [b for b in bubbles if contains_centre(b, text)]
        holder = min(holders, key=area, default=None)  # The innermost bubble.
        regions.append(((union(holder, text) if holder else text), False))

    result = []
    for region in sorted(merge_boxes(regions), key=lambda box: box[1]):
        # Other text reaching into the cut-out, such as a watermark on the
        # bubble's edge, is painted over before reading; its own text is kept.
        reach = expand(region, MASK_REACH)
        own = [t for t in texts if contains_centre(region, t)]
        others = [t for t in texts if not contains_centre(region, t) and intersection(reach, t) > 0]
        result.append({**to_json(region), "keep": [to_json(t) for t in own],
                       "cover": [to_json(t) for t in others]})  # fmt: skip
    return result


def contains_centre(box, inner):
    cx, cy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]


def expand(box, ratio):
    dx, dy = (box[2] - box[0]) * ratio, (box[3] - box[1]) * ratio
    return (box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy)


def to_json(box):
    return {"x0": round(box[0]), "y0": round(box[1]), "x1": round(box[2]), "y1": round(box[3])}


def merge_boxes(boxes):
    """Unions copies of one box: near-identical boxes from overlapping tiles,
    and a box cut by a tile edge with the whole one from the next tile.

    `boxes` are (box, cut) pairs; returns plain boxes.
    """
    merged = []  # [box, cut] pairs
    for box, cut in sorted(boxes, key=lambda pair: area(pair[0]), reverse=True):
        for kept in merged:
            same = iou(box, kept[0]) >= SAME_BOX_IOU
            completes = (cut or kept[1]) and overlap(box, kept[0]) >= CUT_BOX_COVERED
            if same or completes:
                kept[0] = union(kept[0], box)
                kept[1] = kept[1] and cut
                break
        else:
            merged.append([box, cut])
    return [box for box, _ in merged]


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def intersection(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy


def overlap(a, b):
    """Intersection as a share of the smaller box."""
    smaller = min(area(a), area(b))
    return intersection(a, b) / smaller if smaller else 0


def iou(a, b):
    shared = intersection(a, b)
    total = area(a) + area(b) - shared
    return shared / total if total else 0


def union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def decode_tiles(body):
    tiles = []
    for tile in body["tiles"]:
        image = Image.open(io.BytesIO(base64.b64decode(tile["image"]))).convert("RGB")
        tiles.append((int(tile["top"]), image))
    return tiles


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def warm_up():
    """Loads every voice and runs both models once, so the first page isn't slow."""
    for voice in VOICES:
        pipelines[voice[0]].load_voice(voice)
    synthesize("Ready.", VOICES[0])
    detect([(0, Image.new("RGB", (640, 640), "white"))])


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            message = f"Local server ready ({device.upper()})"
            self.send_json(200, {"ready": True, "message": message, "detector": True})
        elif self.path == "/voices":
            self.send_json(200, {"voices": VOICE_LIST})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path == "/tts":
                self.handle_tts(body)
            elif self.path == "/detect":
                self.send_json(200, {"regions": detect(decode_tiles(body))})
            else:
                self.send_json(404, {"error": "Not found"})
        except Exception as error:  # Report any failure to the extension.
            self.send_json(500, {"error": str(error)})

    def handle_tts(self, body):
        text = str(body.get("text", "")).strip()
        voice = body.get("voice", VOICES[0])
        if not text:
            return self.send_json(400, {"error": "No text"})
        if voice not in VOICES:
            return self.send_json(400, {"error": f"Unknown voice {voice!r}"})
        wav = synthesize(text, voice)
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
    print(f"Manga Reader local server on http://{HOST}:{PORT} ({device})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
