"""
Master E2E Test Suite Runner for CareerFair
Author: test_writer_e2e
Methodology: 4-Tier Opaque-Box Automated Testing
Tiers:
  Tier 1 - Feature Coverage (10 tests)
  Tier 2 - Boundary & Corner Cases (7 tests)
  Tier 3 - Cross-Feature Combinations (5 tests)
  Tier 4 - Real-World Application Scenarios (3 tests)
"""

import os
import sys
import time
import json
import argparse
from typing import List, Dict, Any

# Ensure current directory is on python path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from config import LIVE_URL, DEFAULT_LOCAL_URL
from local_server import LocalTestServer
from harness import TestSuite
from tier1_features import run_tier1_tests
from tier2_boundaries import run_tier2_tests
from tier3_combinations import run_tier3_tests
from tier4_scenarios import run_tier4_tests

# Reconfigure stdout for utf-8 encoding on Windows
sys.stdout.reconfigure(encoding="utf-8")

def print_banner():
    banner = r"""
========================================================================
     CAREERFAIR COMPREHENSIVE 4-TIER AUTOMATED E2E TEST SUITE
========================================================================
  Methodology:
    [Tier 1] Feature Coverage (API, Handshake, 12 Tabs, 8 Games, Modals)
    [Tier 2] Boundary & Corner Cases (Empty, Max-Length, Rapid, Injections)
    [Tier 3] Cross-Feature Combinations (Auth + Lifecycle + Audio + Theme)
    [Tier 4] Real-World Scenarios (Student Journey, Admin Journey, Mobile)
========================================================================
"""
    print(banner)

def print_suite_table(suite: TestSuite):
    print(f"\n[{suite.name.upper()}]")
    print(f"{'-'*75}")
    print(f"{'STATUS':<8} | {'TEST ID':<26} | {'TIME (ms)':<9} | {'DETAILS'}")
    print(f"{'-'*75}")
    for c in suite.cases:
        status_tag = f"PASS" if c.status == "PASS" else (f"FAIL" if c.status == "FAIL" else "SKIP")
        err = f" - Error: {c.error_message}" if c.error_message else ""
        print(f"{status_tag:<8} | {c.test_id:<26} | {c.duration_ms:<9.1f} | {c.title}{err}")
    print(f"{'-'*75}")
    s = suite.summary()
    print(f"Subtotal: {s['passed']}/{s['total']} passed, {s['failed']} failed ({s['duration_ms']:.1f}ms)\n")

def print_final_summary(suites: List[TestSuite], total_duration_ms: float) -> bool:
    total_tests = sum(len(s.cases) for s in suites)
    total_passed = sum(sum(1 for c in s.cases if c.status == "PASS") for s in suites)
    total_failed = sum(sum(1 for c in s.cases if c.status == "FAIL") for s in suites)
    total_skipped = sum(sum(1 for c in s.cases if c.status == "SKIP") for s in suites)
    all_success = (total_failed == 0)

    print("========================================================================")
    print("                      FINAL E2E EXECUTION REPORT                        ")
    print("========================================================================")
    for s in suites:
        summary = s.summary()
        status_str = "SUCCESS" if summary["success"] else "FAILURES DETECTED"
        print(f"  Tier {summary['tier']}: {summary['name']:<35} -> {summary['passed']}/{summary['total']} PASS [{status_str}]")
    print("------------------------------------------------------------------------")
    print(f"  TOTAL EXECUTED : {total_tests}")
    print(f"  TOTAL PASSED   : {total_passed}")
    print(f"  TOTAL FAILED   : {total_failed}")
    print(f"  TOTAL SKIPPED  : {total_skipped}")
    print(f"  OVERALL TIME   : {total_duration_ms:.1f}ms ({total_duration_ms / 1000:.2f}s)")
    print(f"  VERDICT        : {'100% SUITE PASS (READY)' if all_success else 'FAILED - ISSUES DETECTED'}")
    print("========================================================================\n")
    return all_success

def main():
    parser = argparse.ArgumentParser(description="CareerFair 4-Tier Automated E2E Test Suite Runner")
    parser.add_argument("--url", type=str, default=None, help="Target URL to test (default: local server or env CAREERFAIR_URL)")
    parser.add_argument("--live", action="store_true", help="Test live site: https://careerwithenglish.pages.dev")
    parser.add_argument("--tier", type=str, default="all", choices=["1", "2", "3", "4", "all"], help="Specify tier to run (default: all)")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed mode (default: headless)")
    parser.add_argument("--local", action="store_true", help="Start local mock server automatically")
    parser.add_argument("--json", type=str, default=None, help="Save report to JSON file path")
    args = parser.parse_args()

    print_banner()

    # Determine target URL
    local_server_instance = None
    if args.live:
        target_url = LIVE_URL
    elif args.url:
        target_url = args.url
    else:
        # Default to local server
        target_url = DEFAULT_LOCAL_URL
        args.local = True

    if args.local:
        local_server_instance = LocalTestServer(port=8899)
        local_server_instance.start()

    print(f"Target Environment : {target_url}")
    print(f"Browser Mode       : {'Headed' if args.headed else 'Headless (Chrome)'}")
    print(f"Active Tiers Scope : {args.tier.upper()}")
    print("------------------------------------------------------------------------")

    suites: List[TestSuite] = []
    start_time = time.time()
    headless_mode = not args.headed

    try:
        # Tier 1
        if args.tier in ("1", "all"):
            s1 = run_tier1_tests(target_url=target_url, headless=headless_mode)
            print_suite_table(s1)
            suites.append(s1)

        # Tier 2
        if args.tier in ("2", "all"):
            s2 = run_tier2_tests(target_url=target_url, headless=headless_mode)
            print_suite_table(s2)
            suites.append(s2)

        # Tier 3
        if args.tier in ("3", "all"):
            s3 = run_tier3_tests(target_url=target_url, headless=headless_mode)
            print_suite_table(s3)
            suites.append(s3)

        # Tier 4
        if args.tier in ("4", "all"):
            s4 = run_tier4_tests(target_url=target_url, headless=headless_mode)
            print_suite_table(s4)
            suites.append(s4)

    finally:
        if local_server_instance:
            local_server_instance.stop()

    total_duration = (time.time() - start_time) * 1000
    all_passed = print_final_summary(suites, total_duration)

    # Optional JSON export
    if args.json:
        report_data = {
            "timestamp": time.time(),
            "target_url": target_url,
            "total_duration_ms": total_duration,
            "all_passed": all_passed,
            "suites": [
                {
                    "tier": s.tier,
                    "name": s.name,
                    "summary": s.summary(),
                    "cases": [
                        {
                            "test_id": c.test_id,
                            "title": c.title,
                            "status": c.status,
                            "duration_ms": c.duration_ms,
                            "error": c.error_message
                        }
                        for c in s.cases
                    ]
                }
                for s in suites
            ]
        }
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2)
        print(f"Report exported to: {args.json}")

    sys.exit(0 if all_passed else 1)

if __name__ == "__main__":
    main()
