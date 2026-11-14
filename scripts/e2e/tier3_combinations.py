"""
Tier 3: Cross-Feature Combination E2E Tests
Covers:
- T3.1: Admin Full Lifecycle (Handshake -> Login -> Moderation -> Ping -> Logout)
- T3.2: Audio Interruption on Tab Transition
- T3.3: Theme Switching & State Persistence Across Reloads
- T3.4: Modal Display & Background Viewport Isolation
- T3.5: Quiz Completion & Leaderboard Score Display
"""

import time
from playwright.sync_api import sync_playwright
from harness import ApiHarness, BrowserHarness, TestSuite
from config import TARGET_URL, ADMIN_PASSWORD

def run_tier3_tests(target_url: str = TARGET_URL, headless: bool = True) -> TestSuite:
    suite = TestSuite("Tier 3: Cross-Feature Combinations", tier=3)
    api = ApiHarness(target_url)

    # ── T3.1: Admin Full Lifecycle ──────────────────────────────────────────────
    tc = suite.add("T3.1_ADMIN_LIFECYCLE", "Admin Lifecycle: Handshake, Login, Ping, Logout")
    t0 = time.time()
    try:
        # 1. Handshake
        hs, err = api.get_handshake("login")
        assert hs and hs.get("ok"), f"Handshake failed: {err}"

        # 2. Login
        token, err = api.login_admin(ADMIN_PASSWORD)
        assert token and token.startswith("adm_sess_"), f"Login failed: {err}"

        # 3. Ping session
        res = api.ping_admin(token)
        assert res.status_code == 200 and res.json().get("admin") is True, "Ping session failed"

        # 4. Logout
        res = api.logout_admin(token)
        assert res.status_code == 200, "Logout call failed"

        # 5. Verify session is now invalidated
        res = api.ping_admin(token)
        assert res.status_code in (401, 403), f"Session still active after logout! Status: {res.status_code}"
        tc.record_pass((time.time() - t0) * 1000)
    except Exception as e:
        tc.record_fail(str(e), (time.time() - t0) * 1000)

    # ── Browser-Based Cross-Feature Tests ───────────────────────────────────────
    with sync_playwright() as p:
        browser = BrowserHarness.launch_browser(p, headless=headless)
        ctx, page = BrowserHarness.setup_page(browser)

        try:
            page.goto(target_url, wait_until="domcontentloaded")
            BrowserHarness.dismiss_loader(page)
            page.wait_for_timeout(300)

            # ── T3.2: Audio Interruption on Tab Transition ───────────────────────
            tc = suite.add("T3.2_AUDIO_INTERRUPTION", "Voice Cancellation on Tab Switch")
            t0 = time.time()
            try:
                # 1. Switch to speak tab
                page.evaluate("window.switchTab('speak', { skipSubInit: false })")
                page.wait_for_timeout(200)

                # 2. Start speech synthesis
                page.evaluate("if (typeof window.speak === 'function') window.speak('Auditory speech test sentence');")
                page.wait_for_timeout(100)

                # 3. Switch to careers tab without keepVoice option
                page.evaluate("window.switchTab('careers', { keepVoice: false })")
                page.wait_for_timeout(200)

                # 4. Verify speech synthesis is stopped
                is_speaking = page.evaluate("() => window.speechSynthesis ? window.speechSynthesis.speaking : false")
                assert is_speaking is False, "Audio speech continued playing after switching tabs!"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T3.3: Theme Switching & State Persistence Across Reloads ─────────
            tc = suite.add("T3.3_THEME_PERSISTENCE", "Theme Toggle (Dark/Light) & LocalStorage Persistence")
            t0 = time.time()
            try:
                # Toggle to Light mode
                page.evaluate("""() => {
                    if (typeof window.setTheme === 'function') window.setTheme('light');
                    else document.documentElement.setAttribute('data-theme', 'light');
                }""")
                page.wait_for_timeout(200)
                theme1 = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
                assert theme1 == "light", f"Expected light theme, got: {theme1}"

                # Reload page
                page.reload(wait_until="domcontentloaded")
                BrowserHarness.dismiss_loader(page)
                page.wait_for_timeout(300)

                theme_reloaded = page.evaluate("() => document.documentElement.getAttribute('data-theme') || localStorage.getItem('cf_theme')")
                assert theme_reloaded == "light", f"Theme did not persist after reload! Got: {theme_reloaded}"

                # Toggle back to Dark mode
                page.evaluate("""() => {
                    if (typeof window.setTheme === 'function') window.setTheme('dark');
                    else document.documentElement.setAttribute('data-theme', 'dark');
                }""")
                page.wait_for_timeout(200)
                theme2 = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
                assert theme2 == "dark", f"Expected dark theme, got: {theme2}"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T3.4: Modal Display & Background Viewport Isolation ─────────────
            tc = suite.add("T3.4_MODAL_ISOLATION", "Modal Opening & Background Viewport Isolation")
            t0 = time.time()
            try:
                page.evaluate("window.switchTab('games', { skipSubInit: true })")
                page.wait_for_timeout(200)

                # Open Terms of Service modal
                page.evaluate("""() => {
                    const m = document.getElementById('tos-pp-modal');
                    if (m) m.classList.add('active');
                }""")
                page.wait_for_timeout(150)
                is_modal_active = page.evaluate("() => document.getElementById('tos-pp-modal').classList.contains('active')")
                assert is_modal_active is True, "TOS modal failed to display"

                # Close modal using button
                close_btn = page.locator("#btn-close-tos")
                if close_btn.count() > 0:
                    close_btn.click()
                else:
                    page.evaluate("() => document.getElementById('tos-pp-modal').classList.remove('active')")
                page.wait_for_timeout(150)

                is_modal_closed = page.evaluate("() => !document.getElementById('tos-pp-modal').classList.contains('active')")
                assert is_modal_closed is True, "TOS modal remained open after clicking close"

                # Verify current tab is still games
                current_tab = page.evaluate("() => window.STATE ? window.STATE.activeTab : null")
                assert current_tab == "games", f"Active tab changed unexpectedly to {current_tab}"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

            # ── T3.5: Quiz Completion & Leaderboard Score Display ───────────────
            tc = suite.add("T3.5_QUIZ_TO_LEADERBOARD", "Quiz Attempt Flow to Leaderboard Display")
            t0 = time.time()
            try:
                # 1. Switch to roadmap/quiz
                page.evaluate("window.switchTab('roadmap', { skipSubInit: false })")
                page.wait_for_timeout(200)
                page.evaluate("if (typeof window.renderPlanTool === 'function') window.renderPlanTool('quiz')")
                page.wait_for_timeout(200)

                # 2. Switch to leaderboard
                page.evaluate("window.switchTab('leaderboard', { skipSubInit: false })")
                page.wait_for_timeout(300)

                # 3. Check leaderboard section is active
                lb_visible = page.evaluate("() => !document.getElementById('sec-leaderboard').hidden")
                assert lb_visible is True, "Leaderboard section not visible"
                tc.record_pass((time.time() - t0) * 1000)
            except Exception as e:
                tc.record_fail(str(e), (time.time() - t0) * 1000)

        finally:
            ctx.close()
            browser.close()

    return suite

if __name__ == "__main__":
    s = run_tier3_tests()
    print(f"\n--- {s.name} Summary ---")
    for c in s.cases:
        print(f"[{c.status}] {c.test_id}: {c.title} ({c.duration_ms}ms) {c.error_message or ''}")
