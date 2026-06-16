#!/bin/bash

# Kill hey-koko web app processes

echo "Cleaning up hey-koko processes..."

# Kill all hey-koko app instances (force kill)
if pgrep hey-koko >/dev/null 2>&1; then
  pkill -9 hey-koko 2>/dev/null
  echo "✓ Killed hey-koko app instances"
fi

# Kill all node server.js processes (force kill to ensure cleanup)
if pgrep -f "node server" >/dev/null 2>&1; then
  pkill -9 -f "node server" 2>/dev/null
  echo "✓ Killed Node.js server processes"
fi

# Wait a bit for ports to be released
sleep 1

# Verify port is free
if lsof -Pi :1314 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "⚠ Warning: Port 1314 still in use, forcing cleanup..."
  lsof -Pi :1314 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
  sleep 1
fi

if lsof -Pi :1314 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "⚠ Port 1314 still in use - you may need to restart your Mac"
else
  echo "✓ Port 1314 is now free"
fi

echo "Done - you can now launch hey-koko.app"
