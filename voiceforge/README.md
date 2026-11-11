# VoiceForge Local Offline TTS API

Lightweight localhost TTS server (`http://127.0.0.1:8765`) used automatically by Career Fair 2026 as an offline speech fallback when ElevenLabs API credits run out or are unavailable.

## Start Locally
- **Windows**: Double-click `voiceforge/start_voiceforge.bat` or run `python voiceforge/server.py`
- **macOS / Linux**: `./voiceforge/start_voiceforge.sh` or `python3 voiceforge/server.py`

## Endpoints
- `GET /health` — Health & active OS speech backend check
- `POST /tts` — Synthesizes `{"text": "...", "rate": 1.0}` directly to `audio/wav`
