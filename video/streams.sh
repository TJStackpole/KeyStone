#!/bin/sh
# KEYSTONE demo video streams.
#
# Generates four placeholder clips on first run (2 aerial-style, 2 bodycam-
# style — synthetic lavfi sources, no real footage) and loops each into
# MediaMTX as RTSP. The dashboard consumes them over WebRTC/HLS and overlays
# the SIMULATED FEED watermark in the UI.
#
# Swapping in a REAL drone: point the aircraft's RTSP output at
# rtsp://<host>:8554/drone1 — zero code changes anywhere else.
set -u

DIR=/clips
mkdir -p "$DIR"

gen() {
  name="$1"; src="$2"
  if [ ! -f "$DIR/$name.mp4" ]; then
    echo "[streams] generating $name.mp4"
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "$src" \
      -t 24 -r 24 -c:v libx264 -preset veryfast -pix_fmt yuv420p \
      "$DIR/$name.mp4" || echo "[streams] WARN: failed to generate $name"
  fi
}

# Aerial-ish: slow drifting fractal + desaturated grade / test pattern flyover feel.
gen drone1  "mandelbrot=size=960x540:rate=24:end_scale=0.2,hue=s=0.25,eq=brightness=-0.05:contrast=1.1"
gen drone2  "testsrc2=size=960x540:rate=24,hue=s=0.3:h=90,eq=brightness=-0.1"
# Helicopter-ish: wide slow orbit feel (zoomed fractal drift, blue-grey grade).
gen helo1   "mandelbrot=size=960x540:rate=24:end_scale=0.4:inner=convergence,hue=s=0.2:h=200,eq=brightness=-0.12:contrast=1.15"
# Bodycam-ish: noisy, jittery, low-light look.
gen bodycam1 "smptehdbars=size=960x540:rate=24,noise=alls=18:allf=t,eq=brightness=-0.25:saturation=0.5"
gen bodycam2 "testsrc=size=960x540:rate=24,noise=alls=24:allf=t,hue=s=0.15,eq=brightness=-0.2"

publish() {
  name="$1"
  while true; do
    # TCP transport: large H264 frames fragment over UDP and drop (MediaMTX
    # logs "invalid FU-A packet"), which breaks HLS/WebRTC conversion.
    ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 \
      -i "$DIR/$name.mp4" -c copy -rtsp_transport tcp -f rtsp "rtsp://mediamtx:8554/$name"
    echo "[streams] $name publisher exited — retrying in 2s"
    sleep 2
  done
}

echo "[streams] publishing drone1 drone2 helo1 bodycam1 bodycam2 -> rtsp://mediamtx:8554"
publish drone1 &
publish drone2 &
publish helo1 &
publish bodycam1 &
publish bodycam2 &
wait
