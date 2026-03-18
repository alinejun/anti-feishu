#!/bin/bash
# Start Antigravity IDE with CDP remote debugging enabled.
# This is required for Anti-Feishu to control the IDE.

CDP_PORT="${CDP_PORT:-9222}"

echo "Starting Antigravity with remote debugging on port ${CDP_PORT}..."

# macOS application path
APP_PATH="/Applications/Antigravity.app/Contents/MacOS/Antigravity"

if [ ! -f "$APP_PATH" ]; then
  echo "Error: Antigravity not found at $APP_PATH"
  echo "Please install Antigravity or update the path in this script."
  exit 1
fi

"$APP_PATH" --remote-debugging-port="$CDP_PORT" "$@"
