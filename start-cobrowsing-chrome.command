#!/bin/zsh
# Launch the dedicated co-browsing Chrome for hey-koko: a separate profile
# (~/.hey-koko/chrome — your daily browser is untouched) with the CDP port open
# so the assistant can read pages you browse in THIS instance. Double-clickable.
# Port must match ~/.hey-koko/browser.json / BROWSER_CDP_URL if you changed those.
PORT="${BROWSER_CDP_PORT:-9222}"
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/.hey-koko/chrome" \
  --remote-debugging-port="$PORT"
