"""Run Node unit tests and write a compact release-verification report."""
import json
import re
import subprocess
from pathlib import Path
from release_lib import source_fingerprint
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'test-results').mkdir(exist_ok=True)
fingerprint=source_fingerprint(ROOT)
result=subprocess.run(['node','--test','--test-reporter=tap',*[str(p.relative_to(ROOT)) for p in sorted((ROOT/'tests').glob('*.test.mjs'))]],cwd=ROOT,capture_output=True,text=True,encoding='utf-8')
tests=re.search(r'^# tests (\d+)$',result.stdout,re.M);passed=re.search(r'^# pass (\d+)$',result.stdout,re.M)
report={'checks':int(tests[1]) if tests else 0,'passed':int(passed[1]) if passed else 0,'all_passed':result.returncode==0 and bool(tests) and tests[1]==passed[1]}
report['source_fingerprint']=fingerprint
report['all_passed']=report['all_passed'] and fingerprint==source_fingerprint(ROOT)
if not report['all_passed']:print(result.stdout);print(result.stderr)
(ROOT/'test-results'/'unit-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
raise SystemExit(result.returncode or (0 if report['all_passed'] else 1))
