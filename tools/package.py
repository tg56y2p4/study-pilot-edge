"""Build verified install/source archives with deterministic ZIP metadata."""
import hashlib
import json
from pathlib import Path
from check_repo import audit
from release_lib import extension_payload, public_paths, verified_checks, write_zip

ROOT = Path(__file__).resolve().parents[1]


def main():
    paths = public_paths(ROOT)
    issues = audit(ROOT, paths)
    if issues:
        raise SystemExit(json.dumps({'issues': issues}))
    checks = verified_checks(ROOT)
    manifest, payload = extension_payload(ROOT)
    payload['CHECKS.json'] = (json.dumps(checks, indent=2, sort_keys=True) + '\n').encode('utf-8')
    output = ROOT / 'dist'
    version = manifest['version']
    release = output / f'study-pilot-edge-v{version}.zip'
    source = output / f'study-pilot-edge-source-v{version}.zip'
    artifacts = {release.name: write_zip(release, payload), source.name: write_zip(source, {'study-pilot-edge/' + name: (ROOT / name).read_bytes() for name in paths})}
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(artifacts.items())), encoding='utf-8')
    report = {'version': version, 'checks': checks, 'files': {name: {'sha256': digest, 'bytes': (output / name).stat().st_size} for name, digest in artifacts.items()}}
    (ROOT / 'test-results' / 'package-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
