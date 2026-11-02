"""Run only offline extension suites, never the local account helpers."""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from release_lib import source_fingerprint

ROOT = Path(__file__).resolve().parents[1]
SUITES = ['browser_check.py', 'models_browser_check.py', 'workflow_check.py', 'mooc_check.py', 'mooc_pending_check.py', 'stability_check.py', 'review_check.py']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium', 'edge'], default='chromium')
    parser.add_argument('--suite', choices=SUITES, action='append')
    parser.add_argument('--jobs', type=int, choices=[1, 2, 3], default=2)
    args = parser.parse_args()
    env = {**os.environ, 'STUDY_PILOT_BROWSER': args.browser, 'PYTHONUTF8': '1'}
    summary = []
    fingerprint = source_fingerprint(ROOT)
    def run(suite):
        command = [sys.executable, '-X', 'utf8', str(ROOT / 'tests' / suite)]
        if suite == 'browser_check.py':
            command += ['--browser', args.browser]
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8', timeout=900)
            print(f'[{suite}]\n{result.stdout}{result.stderr}', flush=True)
            return {'suite': suite, 'passed': result.returncode == 0}
        except subprocess.TimeoutExpired:
            return {'suite': suite, 'passed': False, 'reason': 'timeout'}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(run, suite) for suite in args.suite or SUITES]
        for future in as_completed(futures):
            summary.append(future.result())
    output = ROOT / 'test-results'
    output.mkdir(exist_ok=True)
    report = {'browser': args.browser, 'suites': summary, 'all_passed': all(s['passed'] for s in summary) and fingerprint == source_fingerprint(ROOT), 'complete_suite': not args.suite and len(summary) == len(SUITES), 'source_fingerprint': fingerprint, 'real_api_tested': False, 'real_course_tested': False}
    (output / 'browser-suite-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return 0 if report['all_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
