"""WATCHTOWER transcription sidecar.

Two modes, selected by BROADCASTIFY_URL:

  (default)  Bundled recording, streamed AS-IF-LIVE: transcribe the file once
             with faster-whisper, then replay the timestamped lines paced to
             real time, looping forever. Works fully offline.

  (URL set)  Live stream: ffmpeg pulls the authenticated Broadcastify stream,
             we transcribe rolling 12-second chunks and emit lines as they
             complete.

Every line goes to all connected WebSocket clients (the WATCHTOWER backend)
as JSON: {"text": ..., "offset": seconds-into-source, "live": bool}
"""

import asyncio
import json
import os
import subprocess
import tempfile
import time

import websockets
from faster_whisper import WhisperModel

AUDIO_FILE = os.environ.get("AUDIO_SOURCE", "/audio/fdny-dispatch-demo.mp3")
LIVE_URL = os.environ.get("BROADCASTIFY_URL", "").strip()
MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
PORT = 8765

clients: set = set()


async def handler(ws):
    clients.add(ws)
    print(f"[whisper] client connected ({len(clients)} total)")
    try:
        await ws.wait_closed()
    finally:
        clients.discard(ws)


async def emit(line: dict) -> None:
    dead = []
    for ws in clients:
        try:
            await ws.send(json.dumps(line))
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def load_model() -> WhisperModel:
    print(f"[whisper] loading model '{MODEL_NAME}' (first run downloads weights)…")
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    print("[whisper] model ready")
    return model


async def replay_file_forever(model: WhisperModel) -> None:
    """Transcribe the bundled recording once, then replay lines paced as live."""
    print(f"[whisper] transcribing {AUDIO_FILE} …")
    segments, info = model.transcribe(AUDIO_FILE, vad_filter=True, beam_size=3, language="en")
    lines = [
        {"t0": float(s.start), "t1": float(s.end), "text": s.text.strip()}
        for s in segments
        if s.text.strip()
    ]
    duration = float(info.duration)
    print(f"[whisper] {len(lines)} lines over {duration:.0f}s — replaying as live loop")

    while True:
        loop_start = time.monotonic()
        for line in lines:
            delay = line["t0"] - (time.monotonic() - loop_start)
            if delay > 0:
                await asyncio.sleep(delay)
            await emit({"text": line["text"], "offset": line["t0"], "live": False})
        tail = duration - (time.monotonic() - loop_start)
        await asyncio.sleep(max(tail, 0) + 2.0)


async def transcribe_live_forever(model: WhisperModel) -> None:
    """Rolling-chunk transcription of an authenticated live stream URL.

    Degrades gracefully: if the stream produces nothing across several
    attempts (bad URL, missing premium auth), falls back to the bundled
    recording so the demo never goes silent.
    """
    chunk_s = 12
    failures = 0
    print(f"[whisper] live mode: {LIVE_URL[:60]}… ({chunk_s}s chunks)")
    while True:
        if failures >= 3:
            print("[whisper] live stream failed repeatedly — falling back to bundled recording")
            await replay_file_forever(model)
            return
        proc = subprocess.Popen(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-i", LIVE_URL,
                "-f", "segment", "-segment_time", str(chunk_s),
                "-ar", "16000", "-ac", "1",
                os.path.join(tempfile.gettempdir(), "live-%06d.wav"),
            ]
        )
        try:
            index = 0
            offset = 0.0
            while proc.poll() is None:
                path = os.path.join(tempfile.gettempdir(), f"live-{index:06d}.wav")
                nxt = os.path.join(tempfile.gettempdir(), f"live-{index + 1:06d}.wav")
                # A chunk is complete once ffmpeg starts writing the next one.
                if os.path.exists(nxt):
                    segments, _info = model.transcribe(path, vad_filter=True, beam_size=3, language="en")
                    for s in segments:
                        text = s.text.strip()
                        if text:
                            await emit({"text": text, "offset": offset + float(s.start), "live": True})
                    os.unlink(path)
                    offset += chunk_s
                    index += 1
                else:
                    await asyncio.sleep(1.0)
            if index == 0:
                failures += 1
            else:
                failures = 0
        finally:
            proc.kill()
        print("[whisper] live stream ended/failed — retrying in 5s")
        await asyncio.sleep(5)


async def main() -> None:
    model = await asyncio.to_thread(load_model)
    async with websockets.serve(handler, "0.0.0.0", PORT):
        print(f"[whisper] websocket serving on :{PORT}")
        if LIVE_URL:
            await transcribe_live_forever(model)
        else:
            await replay_file_forever(model)


if __name__ == "__main__":
    asyncio.run(main())
