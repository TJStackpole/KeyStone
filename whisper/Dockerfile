# WATCHTOWER transcription sidecar — faster-whisper (base model, CPU int8).
# Transcribes the FDNY audio source and emits timestamped lines over WebSocket.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "faster-whisper>=1.0,<2" "websockets>=12,<14"

COPY transcriber.py /app/transcriber.py

# Model weights cache (downloaded on first run, ~145 MB for `base`).
ENV HF_HOME=/models
EXPOSE 8765

CMD ["python", "-u", "/app/transcriber.py"]
