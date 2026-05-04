#!/usr/bin/env bash
set -euo pipefail

DISPLAY_ID="${DISPLAY_ID:-:99}"
GEOMETRY="${GEOMETRY:-1280x720x24}"
TMUX_SESSION="${TMUX_SESSION:-vfb}"
TERM_CMD="${TERM_CMD:-xterm}"

if ! pgrep -f "Xvfb $DISPLAY_ID" >/dev/null; then
  Xvfb "$DISPLAY_ID" -screen 0 "$GEOMETRY" &
  DISPLAY=$DISPLAY_ID openbox &
  sleep 1
fi


DISPLAY="$DISPLAY_ID" "$TERM_CMD" \
  -fa Monospace \
  -fs 10 \
  -geometry 160x45 \
  -e "tmux new-session -A -s '$TMUX_SESSION'" &

sleep 1

TMUX_TARGET="$(tmux display-message -t "$TMUX_SESSION:0.0" -p '#{pane_id}')"
mkdir -p .telegram-human-mcp
echo "$TMUX_TARGET" > .telegram-human-mcp/tmux-target

echo "Started:"
echo "  DISPLAY=$DISPLAY_ID"
echo "  TMUX_SESSION=$TMUX_SESSION"
echo "  TMUX_TARGET=$TMUX_TARGET"

sleep 1
x11vnc -display $DISPLAY_ID -nopw -listen 127.0.0.1 -xkb -forever