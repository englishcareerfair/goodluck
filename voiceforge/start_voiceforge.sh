#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Starting VoiceForge Local Offline TTS API on http://127.0.0.1:8765 ..."
python3 "$DIR/server.py"
