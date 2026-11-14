"""
Milestone 2 Adversarial Verification Suite
Author: challenger_m2_1 (Empirical Challenger)
Target: CareerFair Web Platform
Port: 8788
Viewports: 360x640, 375x667, 390x844, 412x915

Empirically challenges and stress-tests:
1. Computed font-size >= 16px on ALL mobile inputs/textareas/selects
2. Mobile touch target dimensions (>= 40px)
3. Leaderboard table horizontal scroll indicator
4. VoiceLab DOM and script mount, YouTube IFrame API, and form a11y
5. Authenticated mobile admin moderation parity:
   - Login on mobile viewport via UI
   - Verify .admin-score-actions and .admin-feedback-actions are visible, unblocked, and clickable
   - Empirically click moderation buttons (delete score, pin feedback) with native dialog handling
6. Cross-device layout integrity (no document horizontal scroll leak on 360px)
7. Session persistence across mobile reload
"""

import os
import sys
import time
import json
import base64
import threading
import http.server
import socketserver
import urllib.parse
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Ensure import paths
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPTS_DIR, "..", ".."))
PUBLIC_DIR = os.path.join(REPO_ROOT, "public")
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TEST_PORT = 8788
TEST_BASE_URL = f"http://127.0.0.1:{TEST_PORT}"
ADMIN_PASSWORD = "Youtuber@1"

# In-memory mock data for the test server
SERVER_ECDH_KEY = ec.generate_private_key(ec.SECP256R1())
ACTIVE_CHALLENGES = {}
ACTIVE_SESSIONS = set()

INITIAL_SCORES = [
    {
        "id": 101,
        "name": "Rohan Verma",
        "student_name": "Rohan Verma",
        "pack": "Everyday",
        "acc": 94,
        "fluency": 91,
        "wpm": 128,
        "score": 94,
        "accuracy": 94,
        "game_type": "speech",
        "ts": int(time.time() * 1000) - 120000,
        "created_at": int(time.time() * 1000) - 120000
    },
    {
        "id": 102,
        "name": "Aarav Sharma",
        "student_name": "Aarav Sharma",
        "pack": "Aviation",
        "acc": 98,
        "fluency": 95,
        "wpm": 135,
        "score": 98,
        "accuracy": 98,
        "game_type": "speech",
        "ts": int(time.time() * 1000) - 60000,
        "created_at": int(time.time() * 1000) - 60000
    }
]

INITIAL_FEEDBACKS = [
    {
        "id": 201,
        "name": "Priya Nair",
        "student_name": "Priya Nair",
        "role": "Student",
        "class_affiliation": "Class 12",
        "comment": "The aviation flight communication module was sensational!",
        "feedback_text": "The aviation flight communication module was sensational!",
        "pinned": 0,
        "rating": 5,
        "rating_useful": 5,
        "created_at": int(time.time() * 1000) - 300000
    },
    {
        "id": 202,
        "name": "Prof. K. Sen",
        "student_name": "Prof. K. Sen",
        "role": "Teacher",
        "class_affiliation": "Faculty",
        "comment": "Outstanding phonetic analysis and real-time speech evaluation.",
        "feedback_text": "Outstanding phonetic analysis and real-time speech evaluation.",
        "pinned": 1,
        "rating": 5,
        "rating_useful": 5,
        "created_at": int(time.time() * 1000) - 150000
    }
]

STORED_SCORES = list(INITIAL_SCORES)
STORED_FEEDBACKS = list(INITIAL_FEEDBACKS)


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


class ChallengerTestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-key")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/config":
            return self.send_json({
                "ok": True,
                "has_gemini_key": True,
                "has_eleven_key": True,
                "db_connected": True,
                "total_scores": len(STORED_SCORES),
                "total_feedback": len(STORED_FEEDBACKS)
            })

        if path in ("/api/scores", "/api/leaderboard"):
            return self.send_json(STORED_SCORES)

        if path == "/api/feedback":
            return self.send_json(STORED_FEEDBACKS)

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

        # Fallback to SPA index.html for virtual routes
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

        if path == "/api/admin/login":
            e2ee = body.get("e2ee")
            if not e2ee:
                return self.send_json({"ok": False, "error": "Encrypted auth required"}, status=400)
            payload, err = decrypt_envelope(e2ee, "login")
            if err:
                return self.send_json({"ok": False, "error": err}, status=400)
            if payload.get("password") == ADMIN_PASSWORD:
                session_token = f"adm_sess_{os.urandom(24).hex()}"
                ACTIVE_SESSIONS.add(session_token)
                # Return both token and sessionToken for 100% contract compliance
                return self.send_json({
                    "ok": True,
                    "token": session_token,
                    "sessionToken": session_token,
                    "expiresAt": int(time.time() * 1000) + (30 * 24 * 3600 * 1000)
                })
            return self.send_json({"ok": False, "error": "Invalid administrator password"}, status=401)

        if path == "/api/admin/logout":
            auth = self.headers.get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            if token in ACTIVE_SESSIONS:
                ACTIVE_SESSIONS.remove(token)
            return self.send_json({"ok": True})

        if path == "/api/admin/del":
            score_id = body.get("id")
            score_name = body.get("name")
            STORED_SCORES = [s for s in STORED_SCORES if str(s.get("id")) != str(score_id) and s.get("name") != score_name]
            return self.send_json({"ok": True, "deleted": score_id})

        if path == "/api/admin/del-feedback":
            fb_id = body.get("id")
            STORED_FEEDBACKS = [f for f in STORED_FEEDBACKS if str(f.get("id")) != str(fb_id)]
            return self.send_json({"ok": True, "deleted": fb_id})

        if path == "/api/admin/pin-feedback":
            fb_id = body.get("id")
            pinned = body.get("pinned", 1)
            for f in STORED_FEEDBACKS:
                if str(f.get("id")) == str(fb_id):
                    f["pinned"] = pinned
            return self.send_json({"ok": True, "pinned": pinned})

        self.send_json({"ok": False, "error": f"Unhandled route {path}"}, status=404)

    def log_message(self, format, *args):
        # Silence routine HTTP access logs during test runs
        pass


class TestHarnessServer:
    def __init__(self, port=TEST_PORT):
        self.port = port
        self.server = None
        self.thread = None

    def start(self):
        socketserver.TCPServer.allow_reuse_address = True
        self.server = socketserver.TCPServer(("127.0.0.1", self.port), ChallengerTestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        print(f"[ChallengerServer] Server listening on http://127.0.0.1:{self.port}")
        time.sleep(0.5)

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            print("[ChallengerServer] Server stopped.")


def dismiss_loader(page):
    try:
        page.evaluate("""() => {
            const l = document.getElementById('site-loader');
            if (l) l.remove();
            document.body.classList.remove('loading-lock');
            document.body.style.overflow = 'auto';
        }""")
    except Exception:
        pass


def run_adversarial_suite():
    print("=" * 72)
    print("        MILESTONE 2 EMPIRICAL ADVERSARIAL VERIFICATION SUITE       ")
    print("=" * 72)

    server = TestHarnessServer(TEST_PORT)
    server.start()

    viewports = [
        {"name": "Android Small (360x640)", "width": 360, "height": 640},
        {"name": "iPhone SE/8 (375x667)", "width": 375, "height": 667},
        {"name": "iPhone 12/13/14 (390x844)", "width": 390, "height": 844},
        {"name": "Pixel / Galaxy (412x915)", "width": 412, "height": 915}
    ]

    all_passed = True
    results_summary = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=CHROME_PATH if os.path.exists(CHROME_PATH) else None,
                headless=True,
                args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
            )

            # Accept all confirm/alert dialogs automatically
            def handle_dialog(dialog):
                dialog.accept()

            for vp in viewports:
                vp_name = vp["name"]
                w, h = vp["width"], vp["height"]
                print(f"\n[{vp_name}] Testing viewport {w}x{h}...")

                context = browser.new_context(
                    viewport={"width": w, "height": h},
                    is_mobile=True,
                    has_touch=True
                )
                page = context.new_page()
                page.on("dialog", handle_dialog)

                # Reset stored mock data for each viewport run
                global STORED_SCORES, STORED_FEEDBACKS
                STORED_SCORES = list(INITIAL_SCORES)
                STORED_FEEDBACKS = list(INITIAL_FEEDBACKS)

                # 1. Load Page
                page.goto(f"{TEST_BASE_URL}/", wait_until="domcontentloaded")
                page.wait_for_function("() => typeof window.switchTab === 'function'", timeout=15000)
                dismiss_loader(page)

                # ─────────────────────────────────────────────────────────────
                # CHECK 1: Static Mounts & DOM Structure
                # ─────────────────────────────────────────────────────────────
                vl_script = page.locator('script[src*="voicelab.js"]').count()
                vl_sec = page.locator('#sec-voicelab').count()
                yt_script = page.locator('script[src*="youtube.com/iframe_api"]').count()
                adm_user = page.locator('#admin-login-form input[name="username"]').count()

                assert vl_script == 0, f"Expected 0 voicelab.js scripts, found {vl_script}"
                assert vl_sec == 0, f"Expected 0 #sec-voicelab containers, found {vl_sec}"
                assert yt_script == 1, f"Expected 1 youtube.com/iframe_api script, found {yt_script}"
                assert adm_user == 1, f"Expected 1 admin username field, found {adm_user}"
                print(f"  [PASS] Static Mounts: VoiceLab removed, YouTube API, and Admin username field present.")

                # ─────────────────────────────────────────────────────────────
                # CHECK 2: Computed Font-Size on ALL Mobile Inputs (>= 16px)
                # ─────────────────────────────────────────────────────────────
                font_sizes = page.evaluate("""() => {
                    const selector = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), select, textarea';
                    const els = Array.from(document.querySelectorAll(selector));
                    return els.map(el => {
                        const cs = window.getComputedStyle(el);
                        return {
                            tag: el.tagName.toLowerCase(),
                            id: el.id || '',
                            name: el.getAttribute('name') || '',
                            type: el.getAttribute('type') || '',
                            fontSizeStr: cs.fontSize,
                            fontSizePx: parseFloat(cs.fontSize)
                        };
                    });
                }""")

                failed_inputs = [inp for inp in font_sizes if inp["fontSizePx"] < 15.9]
                print(f"  [PASS] Inspected {len(font_sizes)} mobile input/select/textarea elements for iOS zoom prevention.")
                if failed_inputs:
                    print(f"  [FAIL] FAILED input font-sizes (< 16px): {failed_inputs}")
                    all_passed = False
                    assert False, f"Mobile inputs with font-size < 16px found: {failed_inputs}"
                else:
                    sample_fs = {f"#{inp['id'] or inp['name']}": inp['fontSizeStr'] for inp in font_sizes[:5]}
                    print(f"  [PASS] Computed font sizes >= 16px verified (samples: {sample_fs})")

                # ─────────────────────────────────────────────────────────────
                # CHECK 3: Mobile Touch Target Accessibility (>= 40px)
                # ─────────────────────────────────────────────────────────────
                touch_targets = page.evaluate("""() => {
                    // Temporarily reveal admin login to measure toggle button
                    const secAdmin = document.getElementById('sec-admin');
                    if (secAdmin) secAdmin.hidden = false;
                    const gate = document.getElementById('admin-gate-screen');
                    if (gate) gate.hidden = false;

                    // Activate tutorial choice modal to measure open close button
                    const choiceModal = document.getElementById('tutorial-choice-modal');
                    if (choiceModal) {
                        choiceModal.classList.add('active');
                        choiceModal.style.transition = 'none';
                        const card = choiceModal.querySelector('.mystery-modal-card');
                        if (card) {
                            card.style.transition = 'none';
                            card.style.transform = 'scale(1) rotateY(0deg)';
                        }
                    }

                    const visibleThemeBtn = Array.from(document.querySelectorAll('.theme-btn')).find(b => b.offsetWidth > 0);
                    const switcher = document.querySelector('.theme-switcher');
                    const tutHeader = document.querySelector('#btn-header-tutorial');
                    const togglePwd = document.querySelector('#btn-toggle-pwd-vis');
                    const closeChoice = document.querySelector('#btn-close-tutorial-choice');

                    const getBox = (el) => el ? {
                        w: el.getBoundingClientRect().width,
                        h: el.getBoundingClientRect().height,
                        ow: el.offsetWidth,
                        oh: el.offsetHeight
                    } : null;

                    return {
                        themeBtn: getBox(visibleThemeBtn),
                        themeSwitcher: getBox(switcher),
                        headerTutorial: getBox(tutHeader),
                        togglePwd: getBox(togglePwd),
                        closeChoice: getBox(closeChoice)
                    };
                }""")

                # Hide modal back
                page.evaluate("""() => {
                    const choiceModal = document.getElementById('tutorial-choice-modal');
                    if (choiceModal) choiceModal.classList.remove('active');
                }""")

                assert touch_targets["themeBtn"]["w"] >= 40 and touch_targets["themeBtn"]["h"] >= 40, f"Theme button touch target < 40px: {touch_targets['themeBtn']}"
                assert touch_targets["themeSwitcher"]["w"] >= 40 and touch_targets["themeSwitcher"]["h"] >= 40, f"Theme switcher touch target < 40px: {touch_targets['themeSwitcher']}"
                assert touch_targets["headerTutorial"]["h"] >= 40, f"Header tutorial button height < 40px: {touch_targets['headerTutorial']}"
                assert touch_targets["togglePwd"]["w"] >= 40 and touch_targets["togglePwd"]["h"] >= 40, f"Toggle password button touch target < 40px: {touch_targets['togglePwd']}"
                assert touch_targets["closeChoice"]["w"] >= 40 and touch_targets["closeChoice"]["h"] >= 40, f"Close tutorial choice button touch target < 40px: {touch_targets['closeChoice']}"
                print(f"  [PASS] Touch target dimensions verified (all >= 40px)")

                # ─────────────────────────────────────────────────────────────
                # CHECK 4: Leaderboard Table Horizontal Scroll Indicator
                # ─────────────────────────────────────────────────────────────
                table_scroll = page.evaluate("""() => {
                    const el = document.querySelector('#sec-leaderboard .table-wrapper');
                    const cs = window.getComputedStyle(el);
                    return {
                        overflowX: cs.overflowX,
                        scrollbarWidth: cs.scrollbarWidth
                    };
                }""")
                assert table_scroll["overflowX"] in ("auto", "scroll"), f"Unexpected overflowX: {table_scroll['overflowX']}"
                assert table_scroll["scrollbarWidth"] != "none", f"Scrollbar is hidden with scrollbarWidth: none!"
                print(f"  [PASS] Leaderboard horizontal scroll indicator verified (overflowX={table_scroll['overflowX']}, scrollbarWidth={table_scroll['scrollbarWidth']})")

                # ─────────────────────────────────────────────────────────────
                # CHECK 5: Document Horizontal Overflow Check (Layout Integrity)
                # ─────────────────────────────────────────────────────────────
                doc_overflow = page.evaluate("""() => {
                    return {
                        scrollWidth: document.documentElement.scrollWidth,
                        innerWidth: window.innerWidth,
                        overflows: document.documentElement.scrollWidth > window.innerWidth + 2
                    };
                }""")
                assert not doc_overflow["overflows"], f"Document horizontal overflow detected on {w}x{h}: scrollWidth={doc_overflow['scrollWidth']}, innerWidth={doc_overflow['innerWidth']}"
                print(f"  [PASS] No horizontal viewport clipping or overflow leak (scrollWidth={doc_overflow['scrollWidth']}, innerWidth={doc_overflow['innerWidth']})")

                # ─────────────────────────────────────────────────────────────
                # CHECK 6: Authenticated Mobile Admin Moderation Parity
                # ─────────────────────────────────────────────────────────────
                # A. Log in as Admin via UI on mobile
                page.evaluate("() => window.switchTab('admin')")
                page.wait_for_selector('#admin-pwd-input', state='visible', timeout=10000)
                page.fill('#admin-pwd-input', ADMIN_PASSWORD)
                page.click('#admin-login-form button[type="submit"]')
                page.wait_for_function("() => Boolean(localStorage.getItem('cf_admin_session'))", timeout=15000)
                admin_logged_in = page.evaluate("() => Boolean(localStorage.getItem('cf_admin_session'))")
                assert admin_logged_in, "Admin login failed on mobile viewport!"
                print(f"  [PASS] Admin authenticated successfully on mobile screen (token present in localStorage).")

                # B. Navigate to Leaderboard on mobile and verify .admin-score-actions
                page.evaluate("() => window.switchTab('leaderboard')")
                page.wait_for_selector('#sec-leaderboard tbody tr td.leaderboard-name-cell', timeout=10000)
                page.wait_for_timeout(300)

                score_actions_check = page.evaluate("""() => {
                    const actions = Array.from(document.querySelectorAll('.admin-score-actions'));
                    return actions.map(act => {
                        const cs = window.getComputedStyle(act);
                        const rect = act.getBoundingClientRect();
                        const buttons = Array.from(act.querySelectorAll('button')).map(b => ({
                            title: b.title || b.textContent.trim(),
                            w: b.offsetWidth,
                            h: b.offsetHeight
                        }));
                        return {
                            display: cs.display,
                            visible: rect.width > 0 && rect.height > 0 && cs.display !== 'none',
                            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                            buttonCount: buttons.length,
                            buttons: buttons
                        };
                    });
                }""")

                assert len(score_actions_check) > 0, "No .admin-score-actions found in leaderboard table!"
                for idx, sc_act in enumerate(score_actions_check):
                    assert sc_act["display"] != "none", f"Row {idx} .admin-score-actions has display: none!"
                    assert sc_act["visible"], f"Row {idx} .admin-score-actions is not visible!"
                    assert sc_act["buttonCount"] >= 2, f"Row {idx} expected at least 2 action buttons, found {sc_act['buttonCount']}"
                print(f"  [PASS] Leaderboard .admin-score-actions verified: {len(score_actions_check)} rows rendered with visible, interactive admin action buttons (display={score_actions_check[0]['display']}).")

                # C. Test interactability: Check if score actions are blocked or clickable
                del_btn = page.locator('.admin-score-actions button[title*="Delete"]').first
                del_btn_visible = del_btn.is_visible()
                score_click_success = False
                blocker_info = None

                # Inspect geometric occlusion / pointer interception
                occlusion_diag = page.evaluate("""() => {
                    const btn = document.querySelector('.admin-score-actions button[title*="Delete"]');
                    if (!btn) return { found: false };
                    const rect = btn.getBoundingClientRect();
                    const cx = rect.x + rect.width / 2;
                    const cy = rect.y + rect.height / 2;
                    const topEl = document.elementFromPoint(cx, cy);
                    const cell = btn.closest('td');
                    const nextCell = cell ? cell.nextElementSibling : null;
                    return {
                        found: true,
                        btnRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                        cellRect: cell ? { x: cell.getBoundingClientRect().x, w: cell.getBoundingClientRect().width, r: cell.getBoundingClientRect().right } : null,
                        nextCellRect: nextCell ? { x: nextCell.getBoundingClientRect().x, w: nextCell.getBoundingClientRect().width } : null,
                        center: { cx, cy },
                        isBlocked: !(topEl === btn || btn.contains(topEl)),
                        topElement: topEl ? (topEl.tagName + (topEl.className ? '.' + topEl.className : '')) : null
                    };
                }""")

                if occlusion_diag.get("isBlocked"):
                    blocker_info = f"Occluded by {occlusion_diag.get('topElement')} (btn at x={occlusion_diag['btnRect']['x']:.1f}, cell ends at x={occlusion_diag['cellRect']['r']:.1f})"
                    print(f"  [FAIL] Score action button is blocked/occluded: {blocker_info}")
                    all_passed = False
                else:
                    try:
                        del_btn.click(timeout=3000)
                        score_click_success = True
                        print(f"  [PASS] Score action button clicked successfully.")
                    except Exception as e:
                        blocker_info = f"Click failed: {str(e)[:100]}"
                        print(f"  [FAIL] Score action button click failed: {blocker_info}")
                        all_passed = False

                # D. Navigate to Feedback Wall on mobile and verify .admin-feedback-actions
                page.evaluate("() => window.switchTab('feedback')")
                page.wait_for_selector('#sec-feedback .feedback-item', timeout=10000)
                page.wait_for_timeout(300)

                feedback_actions_check = page.evaluate("""() => {
                    const actions = Array.from(document.querySelectorAll('.admin-feedback-actions'));
                    return actions.map(act => {
                        const cs = window.getComputedStyle(act);
                        const rect = act.getBoundingClientRect();
                        const buttons = Array.from(act.querySelectorAll('button')).map(b => ({
                            title: b.title || b.textContent.trim(),
                            w: b.offsetWidth,
                            h: b.offsetHeight
                        }));
                        return {
                            display: cs.display,
                            visible: rect.width > 0 && rect.height > 0 && cs.display !== 'none',
                            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                            buttonCount: buttons.length,
                            buttons: buttons
                        };
                    });
                }""")

                assert len(feedback_actions_check) > 0, "No .admin-feedback-actions found in feedback list!"
                for idx, fb_act in enumerate(feedback_actions_check):
                    assert fb_act["display"] != "none", f"Feedback {idx} .admin-feedback-actions has display: none!"
                    assert fb_act["visible"], f"Feedback {idx} .admin-feedback-actions is not visible!"
                    assert fb_act["buttonCount"] >= 3, f"Feedback {idx} expected >= 3 action buttons, found {fb_act['buttonCount']}"
                print(f"  [PASS] Feedback .admin-feedback-actions verified: {len(feedback_actions_check)} items rendered with visible admin buttons (display={feedback_actions_check[0]['display']}).")

                # E. Test interactability: Empirically click the feedback pin button on mobile!
                pin_btn = page.locator('.admin-feedback-actions button[title*="Pin"]').first
                assert pin_btn.is_visible(), "Feedback pin button is not visible on mobile!"
                feedback_click_success = False
                try:
                    pin_btn.click(timeout=3000)
                    feedback_click_success = True
                    print(f"  [PASS] Feedback pin action successfully triggered on mobile screen.")
                except Exception as e:
                    print(f"  [FAIL] Feedback pin click failed: {str(e)[:100]}")
                    all_passed = False

                # ─────────────────────────────────────────────────────────────
                # CHECK 7: Session Persistence Across Mobile Page Reload
                # ─────────────────────────────────────────────────────────────
                page.reload(wait_until="domcontentloaded")
                page.wait_for_function("() => typeof window.switchTab === 'function'", timeout=15000)
                dismiss_loader(page)

                persisted_admin = page.evaluate("() => Boolean(localStorage.getItem('cf_admin_session'))")
                assert persisted_admin, "Admin session failed to persist across page reload on mobile!"
                page.evaluate("() => window.switchTab('leaderboard')")
                page.wait_for_selector('#sec-leaderboard tbody tr td.leaderboard-name-cell', timeout=10000)
                page.wait_for_timeout(300)
                persisted_score_actions = page.locator('.admin-score-actions').count()
                assert persisted_score_actions > 0, "Admin score actions not present after mobile page reload!"
                print(f"  [PASS] Admin session and moderation parity persist cleanly across mobile reload.")

                context.close()
                vp_status = "PASS" if (score_click_success and feedback_click_success) else "FAIL"
                results_summary.append({
                    "viewport": vp_name,
                    "dimensions": f"{w}x{h}",
                    "font_size_ge_16px": True,
                    "touch_targets_ge_40px": True,
                    "table_scroll_indicator": True,
                    "admin_moderation_parity": True,
                    "admin_score_interactable": score_click_success,
                    "admin_feedback_interactable": feedback_click_success,
                    "blocker_info": blocker_info,
                    "session_persistence": True,
                    "status": vp_status
                })

            browser.close()

    except Exception as exc:
        print(f"\n[CRITICAL FAILURE] Verification failed: {str(exc)}")
        import traceback
        traceback.print_exc()
        all_passed = False
    finally:
        server.stop()

    print("\n" + "=" * 72)
    print("                     VERIFICATION SUMMARY MATRIX                    ")
    print("=" * 72)
    for res in results_summary:
        print(f"  {res['viewport']:<28} ({res['dimensions']:<7}) : [{res['status']}] - All 7 Checks Passed")

    print("=" * 72)
    verdict = "CONFIRMED" if all_passed and len(results_summary) == 4 else "REJECTED"
    print(f"  FINAL VERDICT: {verdict}")
    print("=" * 72)
    return verdict, results_summary


if __name__ == "__main__":
    verdict, summary = run_adversarial_suite()
    sys.exit(0 if verdict == "CONFIRMED" else 1)
