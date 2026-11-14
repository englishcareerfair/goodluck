"""
CareerFair E2E Test Suite Core Harness & Utilities
Provides:
- CryptoClient (ECDH-P256-HKDF-AES256GCM E2EE encryption)
- ApiHarness (opaque HTTP client for backend verification)
- BrowserHarness (Playwright automation with Chrome / responsive viewport)
- Reporting & assertion utilities
"""

import os
import sys
import time
import json
import base64
import requests
from typing import Dict, Any, Optional, Tuple

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from config import (
    TARGET_URL,
    CHROME_PATH,
    ADMIN_PASSWORD,
    DEFAULT_HTTP_TIMEOUT,
    VIEWPORT_DESKTOP,
    VIEWPORT_MOBILE_IPHONE
)

class CryptoClient:
    """Implements client-side E2EE v3 ECDH-P256-HKDF-AESGCM envelope encryption."""

    @staticmethod
    def encrypt_payload(
        server_pub_jwk: Dict[str, Any],
        challenge_id: str,
        nonce: str,
        purpose: str,
        payload_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        # 1. Parse server public key from JWK
        x_int = int.from_bytes(base64.urlsafe_b64decode(server_pub_jwk["x"] + "==="), "big")
        y_int = int.from_bytes(base64.urlsafe_b64decode(server_pub_jwk["y"] + "==="), "big")
        server_pub = ec.EllipticCurvePublicNumbers(x_int, y_int, ec.SECP256R1()).public_key()

        # 2. Generate client ephemeral keypair
        client_priv = ec.generate_private_key(ec.SECP256R1())
        client_pub = client_priv.public_key()
        client_pn = client_pub.public_numbers()
        client_x_b64 = base64.urlsafe_b64encode(client_pn.x.to_bytes(32, "big")).decode("ascii").rstrip("=")
        client_y_b64 = base64.urlsafe_b64encode(client_pn.y.to_bytes(32, "big")).decode("ascii").rstrip("=")

        # 3. Derive shared secret & HKDF AES-GCM key
        shared_bits = client_priv.exchange(ec.ECDH(), server_pub)
        salt = f"{challenge_id}:{nonce}".encode("utf-8")
        info = f"careerfair-admin-e2ee-v3:{purpose}".encode("utf-8")
        aes_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(shared_bits)

        # 4. Prepare plaintext payload with padding and nonce
        plain_dict = dict(payload_data)
        plain_dict["nonce"] = nonce
        plain_dict["ts"] = int(time.time() * 1000)
        plain_dict["pad"] = base64.b64encode(os.urandom(16)).decode("ascii")
        pt = json.dumps(plain_dict).encode("utf-8")

        # 5. Encrypt with AES-256-GCM
        iv = os.urandom(12)
        aad = f"{challenge_id}:{nonce}:{purpose}".encode("utf-8")
        ct = AESGCM(aes_key).encrypt(iv, pt, aad)

        return {
            "v": 3,
            "challengeId": challenge_id,
            "purpose": purpose,
            "clientPubJwk": {
                "kty": "EC",
                "crv": "P-256",
                "x": client_x_b64,
                "y": client_y_b64
            },
            "iv": base64.b64encode(iv).decode("ascii"),
            "ct": base64.b64encode(ct).decode("ascii")
        }


class ApiHarness:
    """Opaque API test client interacting with Cloudflare Pages Functions backend."""

    def __init__(self, base_url: str = TARGET_URL):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session_token: Optional[str] = None

    def url(self, path: str) -> str:
        clean_path = path if path.startswith("/") else f"/{path}"
        return f"{self.base_url}{clean_path}"

    def get_config(self) -> requests.Response:
        return self.session.get(self.url("/api/config"), timeout=DEFAULT_HTTP_TIMEOUT)

    def get_scores(self) -> requests.Response:
        return self.session.get(self.url("/api/scores"), timeout=DEFAULT_HTTP_TIMEOUT)

    def get_feedback(self) -> requests.Response:
        return self.session.get(self.url("/api/feedback"), timeout=DEFAULT_HTTP_TIMEOUT)

    def post_feedback(self, data: Dict[str, Any]) -> requests.Response:
        return self.session.post(self.url("/api/feedback"), json=data, timeout=DEFAULT_HTTP_TIMEOUT)

    def get_random_sentence(self) -> requests.Response:
        return self.session.get(self.url("/api/random-sentence"), timeout=DEFAULT_HTTP_TIMEOUT)

    def get_dict_word(self, word: str) -> requests.Response:
        return self.session.get(self.url(f"/api/dict/{word}"), timeout=DEFAULT_HTTP_TIMEOUT)

    def get_handshake(self, purpose: str = "login") -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        try:
            res = self.session.get(self.url(f"/api/admin/auth/handshake?purpose={purpose}"), timeout=DEFAULT_HTTP_TIMEOUT)
            if res.status_code != 200:
                return None, f"HTTP {res.status_code}: {res.text[:100]}"
            ct = res.headers.get("Content-Type", "")
            if "application/json" not in ct:
                return None, f"Expected JSON content-type but received: {ct}"
            data = res.json()
            if not data.get("ok") or not data.get("publicKeyJwk"):
                return None, f"Malformed handshake: {data}"
            return data, None
        except Exception as e:
            return None, str(e)

    def login_admin(self, password: str = ADMIN_PASSWORD) -> Tuple[Optional[str], Optional[str]]:
        hs, err = self.get_handshake("login")
        if err or not hs:
            return None, f"Handshake failed: {err}"
        
        envelope = CryptoClient.encrypt_payload(
            server_pub_jwk=hs["publicKeyJwk"],
            challenge_id=hs["challengeId"],
            nonce=hs["nonce"],
            purpose="login",
            payload_data={"password": password}
        )
        
        try:
            res = self.session.post(
                self.url("/api/admin/login"),
                json={"e2ee": envelope},
                timeout=DEFAULT_HTTP_TIMEOUT
            )
            if res.status_code != 200:
                return None, f"HTTP {res.status_code}: {res.text[:100]}"
            data = res.json()
            if data.get("ok") and data.get("token"):
                self.session_token = data["token"]
                return data["token"], None
            return None, data.get("error", "Login rejected")
        except Exception as e:
            return None, str(e)

    def ping_admin(self, token: Optional[str] = None) -> requests.Response:
        auth_token = token or self.session_token or ""
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
        return self.session.get(self.url("/api/admin/ping"), headers=headers, timeout=DEFAULT_HTTP_TIMEOUT)

    def logout_admin(self, token: Optional[str] = None) -> requests.Response:
        auth_token = token or self.session_token or ""
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
        return self.session.post(self.url("/api/admin/logout"), headers=headers, timeout=DEFAULT_HTTP_TIMEOUT)


class BrowserHarness:
    """Helper for Playwright browser instance creation and page operations."""

    @staticmethod
    def launch_browser(playwright_instance, headless: bool = True):
        # Prefer direct executable Chrome if available, otherwise chromium channel 'chrome'
        if os.path.exists(CHROME_PATH):
            return playwright_instance.chromium.launch(
                executable_path=CHROME_PATH,
                headless=headless,
                args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
            )
        else:
            return playwright_instance.chromium.launch(
                channel="chrome",
                headless=headless,
                args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
            )

    @staticmethod
    def setup_page(browser, viewport: Optional[Dict[str, Any]] = None):
        vp = viewport or VIEWPORT_DESKTOP
        context = browser.new_context(
            viewport={"width": vp["width"], "height": vp["height"]},
            is_mobile=vp.get("is_mobile", False),
            has_touch=vp.get("has_touch", False)
        )
        page = context.new_page()
        return context, page

    @staticmethod
    def dismiss_loader(page):
        page.evaluate("""() => {
            const l = document.getElementById('site-loader');
            if (l) l.remove();
            document.body.classList.remove('loading-lock');
        }""")

    @staticmethod
    def wait_and_click(page, selector: str, timeout: int = 5000):
        page.wait_for_selector(selector, timeout=timeout, state="visible")
        page.click(selector)


class TestCase:
    def __init__(self, test_id: str, title: str, tier: int):
        self.test_id = test_id
        self.title = title
        self.tier = tier
        self.status = "PENDING"  # PASS, FAIL, SKIP
        self.duration_ms = 0
        self.error_message: Optional[str] = None

    def record_pass(self, duration_ms: float):
        self.status = "PASS"
        self.duration_ms = round(duration_ms, 1)

    def record_fail(self, error: str, duration_ms: float):
        self.status = "FAIL"
        self.error_message = error
        self.duration_ms = round(duration_ms, 1)

    def record_skip(self, reason: str):
        self.status = "SKIP"
        self.error_message = reason


class TestSuite:
    def __init__(self, name: str, tier: int):
        self.name = name
        self.tier = tier
        self.cases: list[TestCase] = []

    def add(self, test_id: str, title: str) -> TestCase:
        tc = TestCase(test_id, title, self.tier)
        self.cases.append(tc)
        return tc

    def summary(self) -> Dict[str, Any]:
        total = len(self.cases)
        passed = sum(1 for c in self.cases if c.status == "PASS")
        failed = sum(1 for c in self.cases if c.status == "FAIL")
        skipped = sum(1 for c in self.cases if c.status == "SKIP")
        total_time = sum(c.duration_ms for c in self.cases)
        return {
            "tier": self.tier,
            "name": self.name,
            "total": total,
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
            "duration_ms": round(total_time, 1),
            "success": (failed == 0)
        }
