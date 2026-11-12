#!/usr/bin/env python3
"""Roamies speech server: better ears and a better voice for Roamies, running on your own computer.

Ears:  POST /v1/audio/transcriptions   a WAV file in a form  ->  {"text": "..."}
       A Whisper model tuned for Singapore English by default (mjwong/whisper-large-v3-turbo-singlish, MIT licence),
       for accents Roamies' built-in model mishears. Any Whisper model on Hugging Face works: --model.
Voice: POST /v1/audio/speech           {"input": "...", "voice": "bm_george"}  ->  a WAV file
       Kokoro (Apache 2.0), a British man's voice by default. Optional: only if the `kokoro` package is installed.

Both are asked the way OpenAI's endpoints are, so they fit Roamies' "Speech server" and "Voice server" settings:
    Speech server:  http://127.0.0.1:8123/v1/audio/transcriptions
    Voice server:   http://127.0.0.1:8123/v1/audio/speech

It only listens on this computer (127.0.0.1). The models download from Hugging Face the first time. See README.md.
"""
import argparse
import io
import json
import math
import os
import struct
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE = os.environ.get("ROAMIES_SPEECH_FAKE") == "1"  # tests: no models, canned answers
MAX_BODY = 64 * 1024 * 1024
RATE = 16000


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# ---------------------------------------------------------------- audio in and out

def read_wav(data):
    """A WAV file's bytes -> (mono float samples in a list or numpy array, sample rate). 8, 16, 24 or 32-bit PCM."""
    with wave.open(io.BytesIO(data), "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if FAKE:
        return [0.0] * (len(raw) // (width * channels)), rate
    import numpy as np
    if width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        x = (np.where(v >= 1 << 23, v - (1 << 24), v)).astype(np.float32) / 8388608.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"{width * 8}-bit WAV files aren't supported")
    if channels > 1:
        x = x[: len(x) // channels * channels].reshape(-1, channels).mean(axis=1)
    if rate != RATE and len(x):
        # Roamies sends 16 kHz already; anything else is brought to it simply.
        n = int(round(len(x) * RATE / rate))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
        rate = RATE
    return x, rate


def write_wav(samples, rate):
    """Float samples (-1..1) -> the bytes of a 16-bit mono WAV file."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        if FAKE:
            w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples))
        else:
            import numpy as np
            w.writeframes((np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
    return out.getvalue()


def form_parts(content_type, body):
    """multipart/form-data -> {field name: bytes}."""
    boundary = None
    for piece in content_type.split(";"):
        key, _, value = piece.strip().partition("=")
        if key.lower() == "boundary":
            boundary = value.strip('"')
    if not boundary:
        raise ValueError("the form has no boundary")
    fields = {}
    for part in body.split(b"--" + boundary.encode("latin-1")):
        head, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        name = None
        for line in head.decode("latin-1").split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                for item in line.split(";"):
                    k, _, v = item.strip().partition("=")
                    if k == "name":
                        name = v.strip('"')
        if name:
            fields[name] = content[:-2] if content.endswith(b"\r\n") else content
    return fields


# ---------------------------------------------------------------- the models

class Ears:
    def __init__(self, model, cpu=False):
        self.name, self.device, self.lock = model, "none", threading.Lock()
        if FAKE:
            return
        import torch
        from transformers import pipeline
        cuda = torch.cuda.is_available() and not cpu
        self.device = "cuda:0" if cuda else "cpu"
        dtype = torch.float16 if cuda else torch.float32
        log(f"Loading the listening model {model} on {'your graphics card' if cuda else 'the processor (slower)'}...")
        t0 = time.time()
        made = None
        # The half-precision option has had two names across transformers versions; plain loading works on all.
        for extra in ({"dtype": dtype}, {"torch_dtype": dtype}, {}):
            try:
                made = pipeline("automatic-speech-recognition", model=model, device=self.device, **extra)
                break
            except TypeError:
                continue
        if made is None:
            raise RuntimeError("couldn't load the listening model")
        self.asr = made
        log(f"Listening model ready in {time.time() - t0:.0f}s.")

    def hear(self, samples, rate, language="en"):
        if FAKE:
            return f"fake transcript of {len(samples)} samples at {rate} Hz"
        if len(samples) < rate // 5:
            return ""
        with self.lock:
            kwargs = {"task": "transcribe"}
            if language:
                kwargs["language"] = language
            out = self.asr({"array": samples, "sampling_rate": rate}, chunk_length_s=30, generate_kwargs=kwargs)
        return " ".join(str(out.get("text", "")).split())


class Voice:
    """Kokoro text to speech. `ok` is False when the package isn't installed: the server then only listens."""

    RATE = 24000

    def __init__(self, voice, lang, off=False):
        self.voice, self.lang, self.ok, self.why, self.lock = voice, lang, False, "", threading.Lock()
        if FAKE:
            self.ok = True
            return
        if off:
            self.why = "the voice was switched off with --no-voice"
            return
        try:
            from kokoro import KPipeline
        except Exception as e:  # not installed, or one of its own needs is missing
            self.why = f"the kokoro package isn't installed ({e.__class__.__name__}: {e})"
            return
        try:
            log(f"Loading the voice (Kokoro, {voice})...")
            self.pipeline = KPipeline(lang_code=lang)
            self.say("Ready.")  # the first run downloads the voice and warms up
            self.ok = True
            log("Voice ready.")
        except Exception as e:
            self.why = f"Kokoro couldn't start ({e.__class__.__name__}: {e})"

    def say(self, text, voice=None, speed=1.0):
        if FAKE:
            n = int(self.RATE * 0.02 * max(1, len(text)))
            return [0.3 * math.sin(2 * math.pi * 220 * i / self.RATE) for i in range(n)]
        import numpy as np
        pieces = []
        with self.lock:
            for _, _, audio in self.pipeline(text, voice=voice or self.voice, speed=speed):
                if audio is None:
                    continue
                pieces.append(audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio))
        return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


# ---------------------------------------------------------------- the server

def make_handler(ears, voice):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # quiet: one line per request is printed below instead
            pass

        def reply(self, status, body, kind="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def do_GET(self):
            self.reply(200, {"ok": True, "ears": ears.name, "device": ears.device, "voice": voice.voice if voice.ok else None, "voice_note": voice.why or None})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_BODY:
                    return self.reply(413, {"error": "the request is empty or too large"})
                body = self.rfile.read(length)
                path = self.path.split("?")[0].rstrip("/")
                if path in ("/v1/audio/transcriptions", "/inference"):
                    return self.transcribe(body)
                if path == "/v1/audio/speech":
                    return self.speak(body)
                self.reply(404, {"error": f"nothing at {path}"})
            except Exception as e:  # one bad request must not stop the server
                log("error:", repr(e))
                try:
                    self.reply(500, {"error": f"{e.__class__.__name__}: {e}"})
                except Exception:
                    pass

        def transcribe(self, body):
            fields = form_parts(self.headers.get("Content-Type", ""), body)
            if "file" not in fields:
                return self.reply(400, {"error": "the form has no file"})
            try:
                samples, rate = read_wav(fields["file"])
            except (wave.Error, ValueError, EOFError) as e:
                return self.reply(400, {"error": f"that isn't a WAV file I can read ({e})"})
            language = fields.get("language", b"en").decode("utf-8", "replace").strip() or "en"
            t0 = time.time()
            text = ears.hear(samples, rate, language)
            log(f"heard {len(samples) / max(rate, 1):.1f}s in {time.time() - t0:.1f}s: {text!r}")
            self.reply(200, {"text": text})

        def speak(self, body):
            if not voice.ok:
                return self.reply(501, {"error": f"No voice here: {voice.why}. Roamies will use Windows' own voice."})
            ask = json.loads(body.decode("utf-8"))
            text = str(ask.get("input", "")).strip()
            if not text:
                return self.reply(400, {"error": "nothing to say"})
            if str(ask.get("response_format", "wav")).lower() != "wav":
                return self.reply(400, {"error": "only response_format wav is made here"})
            t0 = time.time()
            samples = voice.say(text, voice=str(ask.get("voice") or "") or None, speed=float(ask.get("speed") or 1.0))
            log(f"said {len(samples) / Voice.RATE:.1f}s in {time.time() - t0:.1f}s: {text[:60]!r}")
            self.reply(200, write_wav(samples, Voice.RATE), "audio/wav")

    return Handler


def main():
    p = argparse.ArgumentParser(description="Better ears and a better voice for Roamies, on this computer.")
    p.add_argument("--port", type=int, default=8123)
    p.add_argument("--model", default="mjwong/whisper-large-v3-turbo-singlish", help="a Whisper model on Hugging Face (default: tuned for Singapore English)")
    p.add_argument("--voice", default="bm_george", help="a Kokoro voice (default: a British man's)")
    p.add_argument("--voice-lang", default="b", help="Kokoro language code for the voice: b British English, a American English")
    p.add_argument("--no-voice", action="store_true", help="listen only; don't load the voice")
    p.add_argument("--cpu", action="store_true", help="don't use the graphics card")
    args = p.parse_args()

    ears = Ears(args.model, cpu=args.cpu)
    voice = Voice(args.voice, args.voice_lang, off=args.no_voice)
    if not voice.ok:
        log(f"No voice: {voice.why}. Listening still works.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(ears, voice))
    server.daemon_threads = True
    log("Ready. In Roamies' panel, on the Voice page:")
    log(f"  Speech server:  http://127.0.0.1:{args.port}/v1/audio/transcriptions")
    if voice.ok:
        log(f"  Voice server:   http://127.0.0.1:{args.port}/v1/audio/speech")
    log("Leave this window open while you use Roamies. Ctrl+C stops it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except OSError as e:
        sys.exit(f"Couldn't start: {e}. Is it already running, or is the port taken? Try --port 8124.")
