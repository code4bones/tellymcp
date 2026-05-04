#!/bin/bash

TELEGRAM_RTMP_URL=rtmps://dc4-1.rtmp.t.me/s
TELEGRAM_STREAM_KEY=5110668514:RjuliFocGccw_EIh2u9n7w

WIN_ID=$(xdotool getactivewindow)

eval $(xdotool getwindowgeometry --shell "$WIN_ID")

echo "$X $Y $WIDTH $HEIGHT"
HEIGHT=$((HEIGHT / 2 * 2))

ffmpeg \
  -f x11grab \
  -video_size "${WIDTH}x${HEIGHT}" \
  -framerate 30 \
  -i ":0.0+${X},${Y}" \
  -f lavfi \
  -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 \
  -preset veryfast \
  -pix_fmt yuv420p \
  -r 30 \
  -g 60 \
  -b:v 2500k \
  -maxrate 2500k \
  -bufsize 5000k \
  -c:a aac \
  -b:a 128k \
  -ar 44100 \
  -f flv \
  "$TELEGRAM_RTMP_URL/$TELEGRAM_STREAM_KEY"