#!/usr/bin/env bash
set -euo pipefail


TELEGRAM_RTMP_URL=rtmps://dc4-1.rtmp.t.me/s
TELEGRAM_STREAM_KEY=5110668514:RjuliFocGccw_EIh2u9n7w


USE_PROXYCHAINS=1
DISPLAY_ID="${DISPLAY_ID:-:99.0}"
USE_PROXYCHAINS="${USE_PROXYCHAINS:-1}"

CMD=()
if [[ "$USE_PROXYCHAINS" == "1" ]]; then
  CMD+=(proxychains4)
fi

CMD+=(ffmpeg
 -f x11grab \
  -video_size 1280x720 \
  -framerate 15 \
  -i :99.0 \
  -f lavfi \
  -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -vf "crop=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 \
  -preset veryfast \
  -pix_fmt yuv420p \
  -r 15 \
  -g 30 \
  -b:v 1200k \
  -maxrate 1200k \
  -bufsize 2400k \
  -c:a aac \
  -b:a 96k \
  -ar 44100 \
  -f flv \
  "${TELEGRAM_RTMP_URL}/${TELEGRAM_STREAM_KEY}"
)

exec "${CMD[@]}"