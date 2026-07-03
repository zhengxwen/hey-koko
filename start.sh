#!/bin/bash
# Launch hey-koko on Linux or macOS: start the server and open the browser.
cd "$(dirname "$0")"

# node may be installed via nvm (user-local), which login shells load but
# double-click/cron/ssh-command contexts don't.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

# pipx-installed tools (yt-dlp, pandoc) live in ~/.local/bin; Homebrew on
# Apple Silicon lives in /opt/homebrew/bin (not on PATH outside login shells).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# Open the browser: macOS always has a GUI; on Linux only when a graphical
# session exists (skipped over plain SSH).
if [ "$(uname)" = "Darwin" ]; then
  (
    sleep 1
    open "http://127.0.0.1:1314"
  ) &
elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY}${WAYLAND_DISPLAY}" ]; then
  (
    sleep 1
    xdg-open "http://127.0.0.1:1314"
  ) &
fi

node server.js
