"""Portable, deterministic release inputs shared by the build and checks."""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipInfo, ZipFile

EXTENSION_FILES = (
    'api.mjs', 'background.mjs', 'content.js', 'core.mjs', 'manifest.json',
    'mooc-adapter.js', 'mooc-tasks.mjs', 'options.css', 'options.html',
    'options.mjs', 'popup.html', 'popup.mjs', 'ui.css', 'vision.mjs',
)
PUBLIC_TOOLS = (
    'check_repo.py', 'check_syntax.py', 'export_source.py', 'package.py',
    'release_lib.py', 'run_browser_checks.py', 'unit_check.py',
)
PUBLIC_TESTS = (
    'api.test.mjs', 'core.test.mjs', 'mooc_tasks.test.mjs', 'browser_check.py',
    'browser_support.py', 'models_browser_check.py', 'mooc_check.py',
    'mooc_pending_check.py', 'workflow_check.py', 'release_test.py',
)
ROOT_FILES = (
    '.gitignore', '.gitattributes', '.editorconfig', '.prettierignore',
    '.prettierrc.json', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
    'SECURITY.md', 'package.json', 'package-lock.json', 'requirements-dev.txt',
)
DOC_FILES = ('CONFIGURATION.md', 'PRIVACY.md', 'DEVELOPMENT.md', 'RELEASING.md', 'TROUBLESHOOTING.md', 'images/settings.png')
GITHUB_FILES = ('workflows/ci.yml', 'dependabot.yml', 'pull_request_template.md', 'ISSUE_TEMPLATE/bug_report.yml', 'ISSUE_TEMPLATE/feature_request.yml', 'ISSUE_TEMPLATE/config.yml')


def public_paths(root):
    paths = [*ROOT_FILES, *('extension/' + p for p in EXTENSION_FILES),
             *('tools/' + p for p in PUBLIC_TOOLS), *('tests/' + p for p in PUBLIC_TESTS),
             *('docs/' + p for p in DOC_FILES), *('.github/' + p for p in GITHUB_FILES)]
    if (root / 'LICENSE').is_file():
        paths.append('LICENSE')
    return sorted(paths)


def source_fingerprint(root):
    digest = hashlib.sha256()
    paths = [*('extension/' + p for p in EXTENSION_FILES), *('tests/' + p for p in PUBLIC_TESTS), *('tools/' + p for p in PUBLIC_TOOLS)]
    for name in sorted(paths):
        path = root / name
        if path.is_file():
            digest.update(name.encode('utf-8') + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def extension_payload(root):
    payload = {}
    extension = (root / 'extension').resolve()
    for name in EXTENSION_FILES:
        path = (extension / name).resolve()
        if not path.is_relative_to(extension) or not path.is_file() or (extension / name).is_symlink():
            raise ValueError('Missing or unsafe extension asset: ' + name)
        payload[name] = path.read_bytes()
    manifest = json.loads(payload['manifest.json'])
    if manifest['manifest_version'] != 3:
        raise ValueError('Expected Manifest V3')
    if not all(part.isdigit() for part in manifest['version'].split('.')):
        raise ValueError('Invalid extension version')
    payload['README.md'] = (root / 'README.md').read_bytes()
    for name in ['CONFIGURATION.md', 'PRIVACY.md', 'TROUBLESHOOTING.md']:
        payload['docs/' + name] = (root / 'docs' / name).read_bytes()
    if (root / 'LICENSE').is_file():
        payload['LICENSE'] = (root / 'LICENSE').read_bytes()
    return manifest, payload


def write_zip(destination, payload):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payload.items()):
            if name.startswith('/') or '..' in Path(name).parts or '\\' in name:
                raise ValueError('Unsafe archive member')
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=9)
    with ZipFile(destination) as archive:
        if archive.testzip():
            raise ValueError('ZIP CRC failure')
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def verified_checks(root):
    output = root / 'test-results'
    reports = {'unit': 'unit-report.json', 'edge_or_chromium': 'edge-report.json', 'models': 'models-report.json', 'workflow': 'workflow-report.json', 'mooc': 'mooc-report.json', 'pending': 'mooc-pending-report.json'}
    # The Chromium suite uses its own report name.
    aggregate = json.loads((output / 'browser-suite-report.json').read_text(encoding='utf-8'))
    if aggregate.get('browser') == 'chromium':
        reports['edge_or_chromium'] = 'chromium-report.json'
    fingerprint = source_fingerprint(root)
    if not aggregate.get('all_passed') or not aggregate.get('complete_suite') or aggregate.get('source_fingerprint') != fingerprint:
        raise ValueError('Run the complete browser suite against the current source before packaging')
    counts = {}
    for label, name in reports.items():
        report = json.loads((output / name).read_text(encoding='utf-8'))
        count = int(report.get('passed', 0))
        if count < 1 or report.get('all_passed') is False or report.get('complete_suite') is False or report.get('legacy') is True:
            raise ValueError('Incomplete or failed checks: ' + label)
        if report.get('real_api_tested') or report.get('real_course_tested'):
            raise ValueError('A real course/API report cannot be bundled')
        if label == 'unit' and report.get('source_fingerprint') != fingerprint:
            raise ValueError('Rerun unit checks against current source')
        counts[label] = count
    return {'source_fingerprint': fingerprint, 'browser': aggregate['browser'], 'checks': counts, 'total': sum(counts.values()), 'real_api_tested': False, 'real_course_tested': False}
