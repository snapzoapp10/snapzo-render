#!/usr/bin/env bash
# One command to install everything and keep the Snapzo render server running.
# First time:  SECRET=<your secret word> bash start.sh
# Afterwards:  bash start.sh   (the secret is remembered)
set -u
cd "$(dirname "$0")"

SECRET_FILE="$HOME/.snapzo-secret"
[ -n "${SECRET:-}" ] && echo "$SECRET" > "$SECRET_FILE"
[ -f "$SECRET_FILE" ] || { echo "Run once as: SECRET=yourword bash start.sh"; exit 1; }
export SECRET="$(cat "$SECRET_FILE")"

# Stop any older copy of this script / server
PIDFILE="$HOME/.snapzo-start.pid"
if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; fi
echo $$ > "$PIDFILE"
pkill -f "node server.mjs" 2>/dev/null
sleep 1

echo "== Installing video tools (first time takes ~2 min)"
if ! command -v ffmpeg >/dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg fonts-dejavu-core python3-venv >/dev/null
fi
if [ ! -x "$HOME/ytenv/bin/pip" ]; then
  python3 -m venv "$HOME/ytenv" 2>/dev/null || { sudo apt-get install -y -qq python3-venv >/dev/null; python3 -m venv "$HOME/ytenv"; }
fi
"$HOME/ytenv/bin/pip" install -q -U "yt-dlp[default]" bgutil-ytdlp-pot-provider

POT_VER="$("$HOME/ytenv/bin/pip" show bgutil-ytdlp-pot-provider | awk '/^Version/{print $2}')"
if [ ! -f "$HOME/bgutil/server/build/main.js" ] || [ "$(cat "$HOME/bgutil/.ver" 2>/dev/null)" != "$POT_VER" ]; then
  echo "== Installing YouTube token helper $POT_VER"
  rm -rf "$HOME/bgutil"
  git clone -q --depth 1 --branch "$POT_VER" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$HOME/bgutil" \
    || git clone -q --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$HOME/bgutil"
  (cd "$HOME/bgutil/server" && npm ci --silent >/dev/null 2>&1 && npx tsc) && echo "$POT_VER" > "$HOME/bgutil/.ver"
fi
pkill -f "bgutil/server/build/main.js" 2>/dev/null
nohup node "$HOME/bgutil/server/build/main.js" > /tmp/bgutil.log 2>&1 &

export YTDLP="$HOME/ytenv/bin/yt-dlp"
echo "== Snapzo is running. Keep this tab open."
while true; do
  git pull -q --ff-only 2>/dev/null || true
  "$HOME/ytenv/bin/pip" install -q -U "yt-dlp[default]" >/dev/null 2>&1 || true
  node server.mjs
  echo "== restarting..."
  sleep 2
done
