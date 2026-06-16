#!/bin/bash

# Kill hey-koko web app processes

echo "Killing hey-koko processes..."

# Kill Node.js process running on port 1314
if lsof -Pi :1314 -sTCP:LISTEN -t >/dev/null 2>&1; then
  PID=$(lsof -Pi :1314 -sTCP:LISTEN -t)
  kill $PID
  echo "✓ Killed Node.js process (PID: $PID) on port 1314"
else
  echo "No process found on port 1314"
fi

# Kill any remaining node server.js processes
PIDS=$(pgrep -f "node server.js" | grep -v grep)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill -9
  echo "✓ Killed remaining Node.js processes: $PIDS"
fi

# Kill the macOS app if running
if pgrep -f "hey-koko.app" >/dev/null 2>&1; then
  killall "hey-koko" 2>/dev/null
  echo "✓ Killed hey-koko.app"
fi

echo "Done"
