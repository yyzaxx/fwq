#!/usr/bin/env bash
set -euo pipefail
cd /root/ClawChatProjects/listing/browser
export DISPLAY=:101
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
pids=($!)
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT INT TERM
for i in {1..30}; do [ -S /tmp/.X11-unix/X101 ] && break; sleep 0.2; done
openbox >openbox.log 2>&1 &
pids+=($!)
chromium-browser --no-sandbox --disable-dev-shm-usage --disable-features=BackForwardCache --no-first-run --no-default-browser-check --password-store=basic --user-data-dir="$PWD/profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --window-size=1440,900 --start-maximized about:blank >chromium.log 2>&1 &
pids+=($!)
x11vnc -display "$DISPLAY" -localhost -rfbport 5901 -nopw -forever -shared -xkb >vnc.log 2>&1 &
pids+=($!)
websockify --web=/usr/share/novnc 127.0.0.1:6081 127.0.0.1:5901 >websockify.log 2>&1 &
pids+=($!)
wait -n "${pids[@]}"
