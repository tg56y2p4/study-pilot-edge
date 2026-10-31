"""Validate publication inputs without displaying matched secret values."""
import json
import re
import subprocess
from pathlib import Path
from release_lib import public_paths

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = (
    ('api_key', re.compile(rb'\bsk-[A-Za-z0-9._-]{20,}')),
    ('github_token', re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})')),
    ('private_key', re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('windows_personal_path', re.compile(rb'[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b)[A-Za-z0-9_.-]+', re.I)),
    ('signed_course_url', re.compile(rb'(?:chaoxing\.com|icourse163\.org)[^\s"\'<>]{0,500}[?&](?:enc|token|cpi|userid|stuId)=')),
)


def audit(root, paths):
    allowed = set(public_paths(root))
    issues = []
    for name in sorted(set(paths)):
        if name not in allowed:
            issues.append({'file': name, 'reason': 'outside_public_allowlist'})
            continue
        candidate = root / name
        path = candidate.resolve()
        if not path.is_relative_to(root.resolve()) or candidate.is_symlink() or not candidate.is_file():
            issues.append({'file': name, 'reason': 'missing_or_unsafe_path'})
            continue
        data = candidate.read_bytes()
        for reason, pattern in PATTERNS:
            if pattern.search(data):
                issues.append({'file': name, 'reason': reason})
        if candidate.suffix != '.png':
            try:
                data.decode('utf-8')
            except UnicodeDecodeError:
                issues.append({'file': name, 'reason': 'not_utf8_text'})
    return issues


def main():
    paths = public_paths(ROOT)
    issues = audit(ROOT, paths)
    if (ROOT / '.git').is_dir():
        tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True).stdout.decode('utf-8').split('\0')
        issues += audit(ROOT, [name for name in tracked if name])
    print(json.dumps({'public_files': len(paths), 'passed': not issues, 'issues': issues}))
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
