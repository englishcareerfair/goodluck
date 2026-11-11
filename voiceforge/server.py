"""
VoiceForge Local Offline TTS API (127.0.0.1:8765)
Zero-dependency offline speech engine used as local fallback when ElevenLabs API quota runs out.
"""
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import wave

HOST = os.environ.get("VOICEFORGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICEFORGE_PORT", "8765"))
MAX_CACHE = 64

_audio_cache: "OrderedDict[tuple[str, str, float], bytes]" = OrderedDict()
_cache_lock = threading.Lock()
_synth_lock = threading.Lock()
_ps_proc = None
_jobs: dict[str, dict] = {}


def _detect_backend() -> str:
    sys_name = platform.system().lower()
    if sys_name == "windows":
        return "windows-sapi"
    if sys_name == "darwin" and shutil.which("say"):
        return "macos-say"
    if shutil.which("espeak-ng"):
        return "espeak-ng"
    if shutil.which("espeak"):
        return "espeak"
    return "builtin-tone"


BACKEND = _detect_backend()


def _get_ps_worker():
    """Keep a warm PowerShell System.Speech synthesizer process for fast local WAV synthesis."""
    global _ps_proc
    if _ps_proc is not None and _ps_proc.poll() is None:
        return _ps_proc

    init_script = r"""
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ErrorActionPreference = 'Stop'
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $rate = [int][Math]::Max(-10, [Math]::Min(10, [Math]::Round(($req.rate - 1.0) * 8.0)))
    $synth.Rate = $rate
    $targetVoice = $null
    $voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }
    if ($req.voice) {
      $targetVoice = $voices | Where-Object { $_.VoiceInfo.Name -like "*$($req.voice)*" } | Select-Object -First 1
    }
    if (-not $targetVoice) {
      $targetVoice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-IN' } | Select-Object -First 1
    }
    if (-not $targetVoice) {
      $targetVoice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
    }
    if ($targetVoice) { $synth.SelectVoice($targetVoice.VoiceInfo.Name) }
    $synth.SetOutputToWaveFile($req.out)
    $synth.Speak([string]$req.text)
    $synth.SetOutputToNull()
    [Console]::Out.WriteLine("OK")
  } catch {
    try { $synth.SetOutputToNull() } catch {}
    [Console]::Out.WriteLine("ERR:" + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
"""
    creationflags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    _ps_proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", init_script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=creationflags,
    )
    return _ps_proc


def _synthesize_windows_sapi(text: str, voice: str, rate: float) -> bytes:
    global _ps_proc
    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="vf_")
    os.close(fd)
    try:
        with _synth_lock:
            for attempt in range(2):
                proc = _get_ps_worker()
                payload = json.dumps({"text": text, "voice": voice, "rate": rate, "out": tmp_wav})
                try:
                    proc.stdin.write(payload + "\n")
                    proc.stdin.flush()
                    resp = proc.stdout.readline().strip()
                except Exception:
                    _ps_proc = None
                    if attempt == 0:
                        continue
                    raise
                if resp == "OK" and os.path.exists(tmp_wav) and os.path.getsize(tmp_wav) > 44:
                    with open(tmp_wav, "rb") as f:
                        return f.read()
                _ps_proc = None
                if attempt == 1:
                    raise RuntimeError(f"SAPI synthesis failed: {resp}")
    finally:
        try:
            if os.path.exists(tmp_wav):
                os.unlink(tmp_wav)
        except Exception:
            pass
    raise RuntimeError("SAPI synthesis produced empty WAV")


def _synthesize_unix_cli(text: str, rate: float) -> bytes:
    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="vf_")
    os.close(fd)
    try:
        if BACKEND == "macos-say":
            wpm = max(90, min(320, int(175 * rate)))
            subprocess.run(["say", "-r", str(wpm), "-o", tmp_wav, "--data-format=LEI16@22050", text], check=True)
        elif BACKEND in ("espeak-ng", "espeak"):
            wpm = max(80, min(320, int(165 * rate)))
            subprocess.run([BACKEND, "-s", str(wpm), "-w", tmp_wav, text], check=True)
        with open(tmp_wav, "rb") as f:
            return f.read()
    finally:
        try:
            if os.path.exists(tmp_wav):
                os.unlink(tmp_wav)
        except Exception:
            pass


def _synthesize_fallback_wav(text: str, rate: float) -> bytes:
    import math

    sr = 22050
    words = max(1, len(text.split()))
    dur = max(0.4, min(12.0, (words / 2.6) / max(0.5, min(2.0, rate))))
    n_samples = int(sr * dur)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        frames = bytearray()
        for i in range(n_samples):
            t = i / sr
            env = 0.5 * (1.0 - math.cos(2 * math.pi * ((t * 2.5) % 1.0)))
            val = 0.25 * env * math.sin(2 * math.pi * 175.0 * t)
            frames.extend(struct.pack("<h", int(max(-32767, min(32767, val * 32767)))))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def synthesize_wav(text: str, voice: str = "", rate: float = 1.0) -> bytes:
    clean_text = " ".join(str(text or "").split()).strip()[:2500]
    if not clean_text:
        raise ValueError("Text cannot be empty")
    rate_val = max(0.6, min(1.6, float(rate or 1.0)))
    key = (clean_text, str(voice or ""), round(rate_val, 2))

    with _cache_lock:
        if key in _audio_cache:
            _audio_cache.move_to_end(key)
            return _audio_cache[key]

    if BACKEND == "windows-sapi":
        wav_bytes = _synthesize_windows_sapi(clean_text, str(voice or ""), rate_val)
    elif BACKEND in ("macos-say", "espeak-ng", "espeak"):
        wav_bytes = _synthesize_unix_cli(clean_text, rate_val)
    else:
        wav_bytes = _synthesize_fallback_wav(clean_text, rate_val)

    with _cache_lock:
        _audio_cache[key] = wav_bytes
        while len(_audio_cache) > MAX_CACHE:
            _audio_cache.popitem(last=False)
    return wav_bytes


class VoiceForgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-token")
        self.send_header("Access-Control-Expose-Headers", "X-VoiceForge-Backend, X-VoiceForge-Engine")

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_wav(self, wav_bytes: bytes):
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-VoiceForge-Backend", BACKEND)
        self.send_header("X-VoiceForge-Engine", "voiceforge-local")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(wav_bytes)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8")) if raw else {}

    def log_message(self, format, *args):
        return

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/", "/health"):
            self._send_json({
                "ok": True,
                "status": "ok",
                "engine": "VoiceForge Local Offline API",
                "backend": BACKEND,
                "host": HOST,
                "port": PORT,
            })
            return

        if path == "/voices":
            self._send_json({
                "ok": True,
                "voices": [
                    {"id": "voiceforge-local", "name": f"VoiceForge Offline ({BACKEND})", "accent": "Local OS"}
                ],
            })
            return

        if path.startswith("/jobs/"):
            job_id = path.split("/jobs/", 1)[1]
            job = _jobs.get(job_id)
            self._send_json(job if job else {"error": "Job not found"}, 200 if job else 404)
            return

        if path.startswith("/audio/"):
            job_id = path.split("/audio/", 1)[1].replace(".wav", "")
            job = _jobs.get(job_id)
            if job and "_wav" in job:
                self._send_wav(job["_wav"])
            else:
                self._send_json({"error": "Audio not found"}, 404)
            return

        self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        try:
            body = self._read_json()
        except Exception:
            self._send_json({"ok": False, "error": "Invalid JSON body"}, 400)
            return

        if path in ("/tts", "/tts/speak"):
            try:
                wav_bytes = synthesize_wav(
                    text=body.get("text", ""),
                    voice=body.get("voice") or body.get("voiceId") or "",
                    rate=body.get("speed") or body.get("rate") or 1.0,
                )
                self._send_wav(wav_bytes)
            except ValueError as e:
                self._send_json({"ok": False, "error": str(e)}, 400)
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, 500)
            return

        if path == "/tts/generate":
            try:
                wav_bytes = synthesize_wav(
                    text=body.get("text", ""),
                    voice=body.get("voice_id") or body.get("voice") or "",
                    rate=body.get("speed") or 1.0,
                )
                job_id = f"job-{uuid.uuid4().hex[:12]}"
                _jobs[job_id] = {
                    "id": job_id,
                    "status": "completed",
                    "progress": 100,
                    "audio_url": f"http://{HOST}:{PORT}/audio/{job_id}.wav",
                    "_wav": wav_bytes,
                }
                if len(_jobs) > 32:
                    _jobs.pop(next(iter(_jobs)))
                self._send_json({k: v for k, v in _jobs[job_id].items() if k != "_wav"})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, 400)
            return

        self._send_json({"error": "Not found"}, 404)


def main():
    server = ThreadingHTTPServer((HOST, PORT), VoiceForgeHandler)
    print(f"VoiceForge Local Offline TTS API active at http://{HOST}:{PORT} (backend={BACKEND})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if _ps_proc is not None and _ps_proc.poll() is None:
            _ps_proc.terminate()


if __name__ == "__main__":
    main()
