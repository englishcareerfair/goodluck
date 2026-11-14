"""
Local Mock / Oracle Server for CareerFair E2E Testing
Serves static assets from public/ and provides full Cloudflare Pages Functions
API emulation matching functions/api/[[path]].js interface contracts.
"""

import http.server
import socketserver
import threading
import json
import base64
import os
import time
import urllib.parse
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from config import PUBLIC_DIR, ADMIN_PASSWORD

# Global State for Mock Server
SERVER_ECDH_KEY = ec.generate_private_key(ec.SECP256R1())
ACTIVE_CHALLENGES = {}  # challenge_id -> { nonce, purpose, exp }
ACTIVE_SESSIONS = set()  # set of valid adm_sess_ tokens
STORED_FEEDBACKS = [
    {
        "id": 1,
        "student_name": "Aarav Sharma",
        "role": "Student",
        "class_affiliation": "Class 10",
        "feedback_text": "The Aviation and AI booths were incredible!",
        "rating": 5,
        "rating_useful": 5,
        "created_at": int(time.time() * 1000)
    }
]
STORED_SCORES = [
    {
        "id": 1,
        "student_name": "Rohan V.",
        "score": 95,
        "accuracy": 92,
        "game_type": "speech",
        "created_at": int(time.time() * 1000)
    }
]
STORED_ISSUES = []

def get_server_pub_jwk():
    pn = SERVER_ECDH_KEY.public_key().public_numbers()
    x_b64 = base64.urlsafe_b64encode(pn.x.to_bytes(32, "big")).decode("ascii").rstrip("=")
    y_b64 = base64.urlsafe_b64encode(pn.y.to_bytes(32, "big")).decode("ascii").rstrip("=")
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": x_b64,
        "y": y_b64,
        "ext": True
    }

def decrypt_envelope(e2ee_envelope, expected_purpose):
    if not isinstance(e2ee_envelope, dict) or e2ee_envelope.get("v") != 3:
        return None, "Invalid envelope version"
    
    challenge_id = e2ee_envelope.get("challengeId")
    purpose = e2ee_envelope.get("purpose")
    if purpose != expected_purpose or challenge_id not in ACTIVE_CHALLENGES:
        return None, "Expired or invalid challenge"
    
    chal = ACTIVE_CHALLENGES.pop(challenge_id)
    if time.time() * 1000 > chal["exp"]:
        return None, "Challenge expired"
    
    client_pub_jwk = e2ee_envelope.get("clientPubJwk", {})
    x_int = int.from_bytes(base64.urlsafe_b64decode(client_pub_jwk["x"] + "==="), "big")
    y_int = int.from_bytes(base64.urlsafe_b64decode(client_pub_jwk["y"] + "==="), "big")
    client_pub = ec.EllipticCurvePublicNumbers(x_int, y_int, ec.SECP256R1()).public_key()
    
    shared_bits = SERVER_ECDH_KEY.exchange(ec.ECDH(), client_pub)
    salt = f"{challenge_id}:{chal['nonce']}".encode("utf-8")
    info = f"careerfair-admin-e2ee-v3:{expected_purpose}".encode("utf-8")
    aes_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(shared_bits)
    
    iv = base64.b64decode(e2ee_envelope["iv"])
    ct = base64.b64decode(e2ee_envelope["ct"])
    aad = f"{challenge_id}:{chal['nonce']}:{expected_purpose}".encode("utf-8")
    
    try:
        pt = AESGCM(aes_key).decrypt(iv, ct, aad)
        payload = json.loads(pt.decode("utf-8"))
        if payload.get("nonce") != chal["nonce"]:
            return None, "Nonce mismatch"
        return payload, None
    except Exception as e:
        return None, f"Decryption failed: {str(e)}"


class CareerFairHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # /api/config
        if path == "/api/config":
            return self.send_json({
                "ok": True,
                "has_gemini_key": True,
                "has_eleven_key": True,
                "db_connected": True,
                "total_scores": len(STORED_SCORES),
                "total_feedback": len(STORED_FEEDBACKS)
            })

        # /api/scores or /api/leaderboard
        if path in ("/api/scores", "/api/leaderboard"):
            return self.send_json(STORED_SCORES)

        # /api/feedback
        if path == "/api/feedback":
            return self.send_json(STORED_FEEDBACKS)

        # /api/random-sentence
        if path == "/api/random-sentence":
            return self.send_json({
                "ok": True,
                "sentence": "Effective communication and technological expertise open global career pathways.",
                "targetWords": ["communication", "technological", "pathways"]
            })

        # /api/dict/<word>
        if path.startswith("/api/dict/"):
            word = path.replace("/api/dict/", "").strip()
            return self.send_json({
                "ok": True,
                "word": word,
                "phonetic": "/wɜːd/",
                "meaning": f"Definition and context for {word} in professional English."
            })

        # /api/admin/auth/handshake
        if path == "/api/admin/auth/handshake":
            purpose = query.get("purpose", ["login"])[0]
            challenge_id = os.urandom(16).hex()
            nonce = os.urandom(24).hex()
            ACTIVE_CHALLENGES[challenge_id] = {
                "nonce": nonce,
                "purpose": purpose,
                "exp": int(time.time() * 1000) + 180000
            }
            return self.send_json({
                "ok": True,
                "v": 3,
                "alg": "ECDH-P256-HKDF-SHA256-AES256GCM",
                "challengeId": challenge_id,
                "nonce": nonce,
                "purpose": purpose,
                "publicKeyJwk": get_server_pub_jwk()
            })

        # /api/admin/ping
        if path == "/api/admin/ping":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if token and token in ACTIVE_SESSIONS:
                return self.send_json({
                    "ok": True,
                    "admin": True,
                    "session": True,
                    "scopes": ["*"],
                    "ip": "127.0.0.1"
                })
            return self.send_json({"ok": False, "error": "Admin session expired or invalid"}, status=401)

        # /api/admin/config
        if path == "/api/admin/config":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if not token or token not in ACTIVE_SESSIONS:
                return self.send_json({"ok": False, "error": "Unauthorized"}, status=401)
            return self.send_json({
                "ok": True,
                "features": {
                    "live_stream": True,
                    "speech_lab": True,
                    "games": True,
                    "quiz": True,
                    "leaderboard": True,
                    "feedback": True
                },
                "branding": {"title": "Career Fair 2026"}
            })

        # /api/admin/export
        if path == "/api/admin/export":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if not token or token not in ACTIVE_SESSIONS:
                return self.send_json({"ok": False, "error": "Unauthorized"}, status=401)
            return self.send_json({"ok": True, "scores": STORED_SCORES})

        # /api/admin/export-feedback
        if path == "/api/admin/export-feedback":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if not token or token not in ACTIVE_SESSIONS:
                return self.send_json({"ok": False, "error": "Unauthorized"}, status=401)
            return self.send_json({"ok": True, "feedback": STORED_FEEDBACKS})

        # Rate-limiting simulated check
        if path == "/api/test/rate-limit":
            return self.send_json({"ok": False, "error": "Too Many Requests"}, status=429)

        # Static assets and Cloudflare Pages SPA rewrite fallback
        clean_path = path.lstrip("/").split("?")[0]
        local_path = os.path.join(PUBLIC_DIR, clean_path.replace("/", os.sep))
        if clean_path and (not os.path.exists(local_path) or os.path.isdir(local_path)):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        global STORED_SCORES, STORED_FEEDBACKS
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get("Content-Length", 0))
        body_raw = self.rfile.read(content_length).decode("utf-8", errors="replace") if content_length > 0 else "{}"
        
        try:
            body = json.loads(body_raw)
        except Exception:
            body = {}

        # /api/admin/login
        if path == "/api/admin/login":
            e2ee = body.get("e2ee")
            if not e2ee:
                return self.send_json({"ok": False, "error": "Encrypted authentication payload required"}, status=400)
            
            payload, err = decrypt_envelope(e2ee, "login")
            if err:
                return self.send_json({"ok": False, "error": err}, status=400)
            
            submitted_pwd = payload.get("password", "")
            if submitted_pwd == ADMIN_PASSWORD:
                session_token = f"adm_sess_{os.urandom(24).hex()}"
                ACTIVE_SESSIONS.add(session_token)
                return self.send_json({
                    "ok": True,
                    "sessionToken": session_token,
                    "token": session_token,
                    "expiresAt": int(time.time() * 1000) + (30 * 24 * 3600 * 1000)
                })
            else:
                return self.send_json({"ok": False, "error": "Invalid administrator password"}, status=401)

        # /api/admin/verify
        if path == "/api/admin/verify":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if token and token in ACTIVE_SESSIONS:
                return self.send_json({
                    "ok": True,
                    "admin": True,
                    "ip": "127.0.0.1",
                    "immune": True
                })
            return self.send_json({"ok": False, "revoked": True, "error": "Admin session expired or invalid"}, status=401)

        # /api/admin/logout
        if path == "/api/admin/logout":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if token in ACTIVE_SESSIONS:
                ACTIVE_SESSIONS.remove(token)
            return self.send_json({"ok": True})

        # /api/feedback
        if path == "/api/feedback":
            name = (body.get("name") or body.get("student_name") or "").strip()
            comment = (body.get("comment") or body.get("feedback_text") or "").strip()
            if not name or not comment:
                return self.send_json({"ok": False, "error": "Name and comment are mandatory fields"}, status=400)
            
            new_id = len(STORED_FEEDBACKS) + 1
            entry = {
                "id": new_id,
                "student_name": name,
                "role": body.get("role", "Student"),
                "class_affiliation": body.get("class_affiliation", "General"),
                "feedback_text": comment,
                "rating": int(body.get("rating", body.get("rating_useful", 5))),
                "rating_useful": int(body.get("rating_useful", body.get("rating", 5))),
                "created_at": int(time.time() * 1000)
            }
            STORED_FEEDBACKS.insert(0, entry)
            return self.send_json({"ok": True, "id": new_id})

        # /api/attempt
        if path == "/api/attempt":
            score_val = body.get("score", 100)
            name = body.get("student_name", "Student")
            STORED_SCORES.insert(0, {
                "id": len(STORED_SCORES) + 1,
                "student_name": name,
                "score": score_val,
                "accuracy": body.get("accuracy", 90),
                "game_type": body.get("game_type", "arcade"),
                "created_at": int(time.time() * 1000)
            })
            return self.send_json({"ok": True})

        # /api/ai
        if path == "/api/ai":
            return self.send_json({
                "ok": True,
                "reply": "Your profile aligns strongly with STEM and Technical Communication fields."
            })

        # /api/tts
        if path == "/api/tts":
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(b"ID3" + b"\x00" * 128)  # Dummy MP3 header
            return

        # /api/stt
        if path == "/api/stt":
            return self.send_json({
                "ok": True,
                "text": "Every career speaks English.",
                "accuracy": 95
            })

        # /api/telemetry/session
        if path == "/api/telemetry/session":
            return self.send_json({"ok": True})

        # /api/user-issues
        if path == "/api/user-issues":
            STORED_ISSUES.append(body)
            return self.send_json({"ok": True, "ticket_id": f"TICK-{len(STORED_ISSUES)}"})

        # Admin deletion routes
        if path == "/api/admin/del":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if not token or token not in ACTIVE_SESSIONS:
                return self.send_json({"ok": False, "error": "Unauthorized"}, status=401)
            score_id = body.get("id")
            STORED_SCORES = [s for s in STORED_SCORES if s["id"] != score_id]
            return self.send_json({"ok": True})

        if path == "/api/admin/del-feedback":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if not token or token not in ACTIVE_SESSIONS:
                return self.send_json({"ok": False, "error": "Unauthorized"}, status=401)
            fb_id = body.get("id")
            STORED_FEEDBACKS = [f for f in STORED_FEEDBACKS if f["id"] != fb_id]
            return self.send_json({"ok": True})

        self.send_json({"ok": False, "error": f"Unhandled route {path}"}, status=404)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get("Content-Length", 0))
        body_raw = self.rfile.read(content_length).decode("utf-8", errors="replace") if content_length > 0 else "{}"
        if path == "/api/admin/config":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if not token or token not in ACTIVE_SESSIONS:
                return self.send_json({"ok": False, "error": "Unauthorized"}, status=401)
            return self.send_json({"ok": True})
        return self.send_json({"ok": False, "error": f"Unhandled PUT route {path}"}, status=404)


class LocalTestServer:
    def __init__(self, port=8899):
        self.port = port
        self.server = None
        self.thread = None

    def start(self):
        socketserver.TCPServer.allow_reuse_address = True
        self.server = socketserver.TCPServer(("127.0.0.1", self.port), CareerFairHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        print(f"[LocalServer] Started HTTP Oracle at http://127.0.0.1:{self.port}")
        time.sleep(0.5)

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            print("[LocalServer] Server stopped.")

if __name__ == "__main__":
    server = LocalTestServer(8899)
    server.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.stop()
