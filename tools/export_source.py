"""Export only the public repository allowlist; exclude local working data."""
import json
from pathlib import Path
from release_lib import public_paths, write_zip
from check_repo import audit

ROOT = Path(__file__).resolve().parents[1]


def main():
    issues = audit(ROOT, public_paths(ROOT))
    if issues:
        raise SystemExit(json.dumps({'issues': issues}))
    version = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
    payload = {'study-pilot-edge/' + name: (ROOT / name).read_bytes() for name in public_paths(ROOT)}
    destination = ROOT / 'dist' / f'study-pilot-edge-source-v{version}.zip'
    digest = write_zip(destination, payload)
    print(json.dumps({'file': str(destination), 'files': len(payload), 'sha256': digest}))


if __name__ == '__main__':
    main()
