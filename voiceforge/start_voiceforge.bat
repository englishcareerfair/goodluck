@echo off
setlocal
echo Starting VoiceForge Local Offline TTS API on http://127.0.0.1:8765 ...
python "%~dp0server.py"
pause
