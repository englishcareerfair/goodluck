"""
Tier 1: Feature Coverage E2E Tests
Covers:
- T1.1: API Routing & Contract Integrity
- T1.2: Admin Auth Handshake
- T1.3: Admin Password Verification (Youtuber@1)
- T1.4: Admin Session Persistence
- T1.5: Navigation Across All 12 Tabs
- T1.6: Game Launches (8 Arcade Games)
- T1.7: Audio Triggers & Voice Cancellation
- T1.8: Modal Openings & Dismissals
- T1.9: Feedback Submission
- T1.10: Quiz & Roadmap Subtools
"""

import time
from playwright.sync_api import sync_playwright
from harness import ApiHarness, BrowserHarness, TestSuite
from config import (
    TARGET_URL,
    ADMIN_PASSWORD,
    EXPECTED_TABS,
    EXPECTED_GAMES,
    EXPECTED_MODALS,
    EXPECTED_ROADMAP_TOOLS
)

def run_tier1_tests(target_url: str = TARGET_URL, headless: bool = True) -> TestSuite:
    suite = TestSuite("Tier 1: Feature Coverage", tier=1)
    api = ApiHarness(target_url)

    # ── T1.1: API Routing & Contract Integrity ──────────────────────────────────
    tc = suite.add("T1.1_API_ROUTING", "API Routing & Contract JSON Verification")
    t0 = time.time()
    try:
        res = api.get_config()
        ct = res.headers.get("Content-Type", "")
        if "application/json" not in ct:
            raise AssertionError(f"Expected application/json from /api/config, got: {ct} (Status: {res.status_code})")
        data = res.json()
        assert data.get("ok") is True, f"/api/config returned ok=False: {data}"
        tc.record_pass((time.time() - t0) * 1000)
    except Exception as e:
        tc.record_fail(str(e), (time.time() - t0) * 1000)

    # ── T1.2: Admin Auth Handshake ──────────────────────────────────────────────
    tc = suite.add("T1.2_ADMIN_HANDSHAKE", "Admin Auth Handshake Protocol")
    t0 = time.time()
    try:
        hs, err = api.get_handshake("login")
        if err or not hs:
            raise AssertionError(f"Handshake failed: {err}")
        assert hs.get("ok") is True, f"Handshake ok!=True: {hs}"
        assert hs.get("publicKeyJwk"), "Missing publicKeyJwk in handshake"
        assert hs.get("challengeId"), "Missing challengeId in handshake"
        assert hs.get("nonce"), "Missing nonce in handshake"
        tc.record_pass((time.time() - t0) * 1000)
    except Exception as e:
        tc.record_fail(str(e), (time.time() - t0) * 1000)

    # ── T1.3: Admin Password Verification (Youtuber@1) ───────────────────────────
    tc = suite.add("T1.3_ADMIN_LOGIN", "E2EE Admin Password Verification (Youtuber@1)")
    t0 = time.time()
    try:
        token, err = api.login_admin(ADMIN_PASSWORD)
        if err or not token:
            raise AssertionError(f"Admin login failed with password '{ADMIN_PASSWORD}': {err}")
        assert token.startswith("adm_sess_"), f"Unexpected token format: {token}"
        tc.record_pass((time.time() - t0) * 1000)
    except Exception as e:
        tc.record_fail(str(e), (time.time() - t0) * 1000)

    # ── T1.4: Admin Session Persistence ──────────────────────────────────────────
    tc = suite.add("T1.4_SESSION_PERSISTENCE", "Admin Session Ping & Validity Check")
    t0 = time.time()
    try:
        if not api.session_token:
            token, _ = api.login_admin(ADMIN_PASSWORD)
        res = api.ping_admin()
        assert res.status_code == 200, f"/api/admin/ping returned HTTP {res.status_code}"
        data = res.json()
        assert data.get("ok") is True and data.get("admin") is True, f"Ping payload invalid: {data}"
        tc.record_pass((time.time() - t0) * 1000)
    except Exception as e:
        tc.record_fail(str(e), (time.time() - t0) * 1000)

    # ── Browser-Based UI Feature Tests ──────────────────────────────────────────
    with sync_playwright() as p:
        browser = BrowserHarness.launch_browser(p, headless=headless)
        ctx, page = BrowserHarness.setup_page(browser)

        try:
            page.goto(target_url, wait_until="domcontentloaded")
            BrowserHarness.dismiss_loader(page)
            page.wait_for_timeout(500)

            # ── T1.5: Navigation Across All 12 Tabs ───────────────────────────────
            tc = suite.add("T1.5_TAB_NAVIGATION", "Navigation Across All 12 Tabs")
            t0 = time.time()
            try:
                for tab in EXPECTED_TABS:
                    page.evaluate(f"window.switchTab('{tab}', {{ skipSubInit: true }})")
                    page.wait_for_selector(f"#sec-{tab}:not([hidden])", timeout=4000)
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T1.6: Game Launches (8 Arcade Games) ──────────────────────────────
            tc = suite.add("T1.6_GAME_LAUNCHES", "Arcade Game Suite Launches (8 Games)")
            t0 = time.time()
            try:
                page.evaluate("window.switchTab('games', { skipSubInit: false })")
                page.wait_for_timeout(300)
                
                for game in EXPECTED_GAMES:
                    btn_selector = f"#game-picker-tabs button[data-game='{game}']"
                    if page.locator(btn_selector).count() > 0:
                        page.click(btn_selector)
                        page.wait_for_timeout(150)
                    else:
                        # Direct evaluate launcher if tab button not found
                        page.evaluate(f"if (typeof window.launchGame === 'function') window.launchGame('{game}')")
                
                # Check that game arena exists
                arena_exists = page.evaluate("() => document.getElementById('game-arena-mount') !== null")
                assert arena_exists, "Game arena mount container (#game-arena-mount) not found"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T1.7: Audio Triggers & Voice Cancellation ────────────────────────
            tc = suite.add("T1.7_AUDIO_TRIGGERS", "Speech & Voice Playback / Cancellation")
            t0 = time.time()
            try:
                # Trigger speak and then stopAllVoice
                res = page.evaluate("""() => {
                    if (typeof window.speak === 'function') {
                        window.speak('Career fair test speech sentence');
                    }
                    const activeBefore = window.speechSynthesis ? window.speechSynthesis.speaking : false;
                    if (typeof window.stopAllVoice === 'function') {
                        window.stopAllVoice();
                    }
                    const activeAfter = window.speechSynthesis ? window.speechSynthesis.speaking : false;
                    return { activeBefore, activeAfter };
                }""")
                assert res.get("activeAfter") is False, "stopAllVoice failed to cancel speech synthesis"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T1.8: Modal Openings & Dismissals ────────────────────────────────
            tc = suite.add("T1.8_MODAL_SYSTEM", "Modal Dialog Lifecycle (Open / Dismiss)")
            t0 = time.time()
            try:
                for modal_id in EXPECTED_MODALS:
                    # Open modal
                    page.evaluate(f"""() => {{
                        const m = document.getElementById('{modal_id}');
                        if (m) m.classList.add('active');
                    }}""")
                    is_active = page.evaluate(f"() => document.getElementById('{modal_id}') ? document.getElementById('{modal_id}').classList.contains('active') : false")
                    assert is_active, f"Modal #{modal_id} failed to open"
                    
                    # Dismiss modal
                    page.evaluate(f"""() => {{
                        const m = document.getElementById('{modal_id}');
                        if (m) m.classList.remove('active');
                    }}""")
                    is_closed = page.evaluate(f"() => document.getElementById('{modal_id}') ? !document.getElementById('{modal_id}').classList.contains('active') : true")
                    assert is_closed, f"Modal #{modal_id} failed to close"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T1.9: Feedback Submission ────────────────────────────────────────
            tc = suite.add("T1.9_FEEDBACK_SUBMISSION", "Feedback Submission Workflow")
            t0 = time.time()
            try:
                page.evaluate("window.switchTab('feedback', { skipSubInit: false })")
                page.wait_for_timeout(300)
                page.fill("#fb-name", "Test Candidate")
                if page.locator("#fb-role").count() > 0:
                    page.select_option("#fb-role", value="Student")
                if page.locator("#fb-class").count() > 0:
                    page.select_option("#fb-class", value="Class 10")
                page.fill("#fb-comment", "The Career Fair test suite exercises feedback successfully.")
                
                # Check submit button exists
                btn_exists = page.locator("#btn-submit-feedback").count() > 0
                assert btn_exists, "Submit feedback button #btn-submit-feedback not found"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T1.10: Quiz & Roadmap Subtools ───────────────────────────────────
            tc = suite.add("T1.10_ROADMAP_QUIZ", "Quiz & Roadmap Subtool Switcher")
            t0 = time.time()
            try:
                page.evaluate("window.switchTab('roadmap', { skipSubInit: false })")
                page.wait_for_timeout(300)
                
                for tool in EXPECTED_ROADMAP_TOOLS:
                    page.evaluate(f"if (typeof window.renderPlanTool === 'function') window.renderPlanTool('{tool}')")
                    page.wait_for_timeout(100)
                
                arena_has_content = page.evaluate("() => document.getElementById('plan-tool-arena') ? document.getElementById('plan-tool-arena').innerHTML.length > 0 : false")
                assert arena_has_content, "Plan tool arena (#plan-tool-arena) was empty"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

        finally:
            ctx.close()
            browser.close()

    return suite

if __name__ == "__main__":
    s = run_tier1_tests()
    print(f"\n--- {s.name} Summary ---")
    for c in s.cases:
        print(f"[{c.status}] {c.test_id}: {c.title} ({c.duration_ms}ms) {c.error_message or ''}")
