"""
CareerFair E2E Test Suite Configuration
Author: test_writer_e2e
Target: CareerFair Web Platform
Live URL: https://careerwithenglish.pages.dev
Local Port: 8899
"""

import os

# Default Target URL: can be overridden via CAREERFAIR_URL environment variable
DEFAULT_LOCAL_URL = "http://127.0.0.1:8899"
LIVE_URL = "https://careerwithenglish.pages.dev"
TARGET_URL = os.environ.get("CAREERFAIR_URL", DEFAULT_LOCAL_URL)

# Credentials & Security
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Youtuber@1")
AUTH_CHALLENGE_PURPOSE_LOGIN = "login"
AUTH_CHALLENGE_PURPOSE_CHANGE_PWD = "change-password"

# Timeouts (in seconds)
DEFAULT_HTTP_TIMEOUT = 10
DEFAULT_PAGE_TIMEOUT = 30000  # ms for Playwright
DEFAULT_ACTION_TIMEOUT = 8000  # ms for Playwright clicks/waits

# Paths
REPO_ROOT = r"D:\TANMAY\careerfair\careerfair"
PUBLIC_DIR = os.path.join(REPO_ROOT, "public")
ARTIFACTS_DIR = os.path.join(REPO_ROOT, "artifacts")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# Viewport Presets
VIEWPORT_DESKTOP = {"width": 1440, "height": 900}
VIEWPORT_LAPTOP = {"width": 1280, "height": 800}
VIEWPORT_MOBILE_IPHONE = {"width": 390, "height": 844, "is_mobile": True, "has_touch": True}
VIEWPORT_MOBILE_SMALL = {"width": 375, "height": 667, "is_mobile": True, "has_touch": True}

# 12 Navigation Tabs
EXPECTED_TABS = [
    "hero",
    "careers",
    "colleges",
    "exams",
    "speak",
    "speechLab",
    "teleprompter",
    "games",
    "roadmap",
    "leaderboard",
    "feedback",
    "admin"
]

# 8 Arcade Games
EXPECTED_GAMES = [
    "quest-scribe",
    "quest-bard",
    "quest-cipher",
    "wordle",
    "flashcards",
    "dict",
    "spelling",
    "hangman"
]

# 4 Core Modals
EXPECTED_MODALS = [
    "tos-pp-modal",
    "user-issue-modal",
    "tutorial-choice-modal",
    "admin-session-details-modal"
]

# 3 Roadmap Tools
EXPECTED_ROADMAP_TOOLS = [
    "bizcard",
    "myplan",
    "quiz"
]
