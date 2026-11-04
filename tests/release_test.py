"""Publication invariants; no network, user credentials or real course files."""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from release_lib import EXTENSION_FILES, extension_payload, public_paths, source_fingerprint, write_zip
from check_repo import audit
from prepare_release import release_metadata, release_notes, verify_artifacts


class ReleaseTests(unittest.TestCase):
    def test_install_archive_contains_only_explicit_assets(self):
        manifest, payload = extension_payload(ROOT)
        self.assertEqual(manifest['manifest_version'], 3)
        self.assertTrue(set(EXTENSION_FILES).issubset(payload))
        self.assertIn('docs/images/settings.png', payload)
        self.assertIn('SECURITY.md', payload)
        self.assertFalse(any(name.startswith(('test-results/', 'tools/', '.planning/')) for name in payload))

    def test_identical_inputs_have_identical_zip_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            a, b = Path(folder) / 'a.zip', Path(folder) / 'b.zip'
            self.assertEqual(write_zip(a, {'z.txt': b'z', 'a.txt': b'a'}), write_zip(b, {'a.txt': b'a', 'z.txt': b'z'}))
            self.assertEqual(a.read_bytes(), b.read_bytes())
            with ZipFile(a) as archive:
                self.assertEqual(archive.namelist(), ['a.txt', 'z.txt'])
                self.assertEqual(archive.getinfo('a.txt').date_time, (1980, 1, 1, 0, 0, 0))

    def test_unsafe_archive_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ['../outside', '/absolute', 'dir\\file']:
                with self.assertRaises(ValueError):
                    write_zip(Path(folder) / 'bad.zip', {name: b'no'})

    def test_personal_files_are_never_public_candidates(self):
        candidates = public_paths(ROOT)
        for name in ['tools/credentials.py', 'tools/configure_local.py', 'tools/login_local.py', 'test-results/live-models-v050.json', '.planning/findings.md', '启动课伴.ps1']:
            self.assertNotIn(name, candidates)
            self.assertTrue(audit(ROOT, [name]))

    def test_secret_detection_does_not_echo_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            secret = 'sk-' + 'exampleDO_NOT_USE_' * 3
            (root / 'README.md').write_text(secret, encoding='utf-8')
            issues = audit(root, ['README.md'])
            self.assertEqual(issues[0]['reason'], 'api_key')
            self.assertNotIn(secret, json.dumps(issues))

    def test_source_fingerprint_changes_with_code(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'extension').mkdir()
            path = root / 'extension' / 'api.mjs'
            path.write_text('one', encoding='utf-8')
            first = source_fingerprint(root)
            path.write_text('two', encoding='utf-8')
            self.assertNotEqual(first, source_fingerprint(root))

    def test_versions_match(self):
        manifest = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))
        package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version'], package['version'])
        self.assertIn(manifest['version'], (ROOT / 'extension/popup.html').read_text(encoding='utf-8'))

    def test_initial_settings_are_not_bundled(self):
        _manifest, payload = extension_payload(ROOT)
        for name in payload:
            self.assertFalse(name.endswith(('.env', '.key', '.pfx', '.log')))
        self.assertNotIn('settings.json', payload)


class ReleasePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        for name in public_paths(ROOT):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        self.version = release_metadata(self.root)['version']
        self.folder = Path(self.temp.name) / 'dist'

    def build_fixture(self, extra_source=None, fingerprint=None):
        _manifest, payload = extension_payload(self.root)
        counts = {name: 1 for name in ['unit', 'edge_or_chromium', 'models', 'workflow', 'mooc', 'pending', 'stability', 'review', 'assessments', 'adapters']}
        checks = {'source_fingerprint': fingerprint or source_fingerprint(self.root), 'checks': counts, 'total': sum(counts.values()),
                  'real_api_tested': False, 'real_course_tested': False}
        payload['CHECKS.json'] = json.dumps(checks).encode('utf-8')
        install_name = f'study-pilot-edge-v{self.version}.zip'
        source_name = f'study-pilot-edge-source-v{self.version}.zip'
        source = {'study-pilot-edge/' + name: (self.root / name).read_bytes() for name in public_paths(self.root)}
        source.update(extra_source or {})
        sums = {install_name: write_zip(self.folder / install_name, payload), source_name: write_zip(self.folder / source_name, source)}
        (self.folder / 'SHA256SUMS.txt').write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(sums.items())), encoding='utf-8')
        return checks

    def test_tag_mismatch_cannot_publish(self):
        with self.assertRaisesRegex(ValueError, 'tag does not match'):
            release_metadata(self.root, 'v999.0.0')

    def test_stale_lockfile_cannot_publish(self):
        path = self.root / 'package-lock.json'
        lock = json.loads(path.read_text(encoding='utf-8'))
        lock['packages']['']['version'] = '0.0.0'
        path.write_text(json.dumps(lock), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'versions must match'):
            release_metadata(self.root)

    def test_valid_archives_and_current_changelog_generate_release_notes(self):
        checks = self.build_fixture()
        self.assertEqual(verify_artifacts(self.root, self.folder, self.version), checks)
        notes = release_notes(release_metadata(self.root), checks)
        self.assertIn(f'study-pilot-edge-v{self.version}.zip', notes)
        self.assertNotIn('首个公开发布版', notes)
        self.assertNotIn('## 0.6.0', notes)

    def test_modified_download_is_rejected_by_checksum(self):
        self.build_fixture()
        path = self.folder / f'study-pilot-edge-v{self.version}.zip'
        path.write_bytes(path.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            verify_artifacts(self.root, self.folder, self.version)

    def test_private_extra_file_is_rejected_even_with_matching_checksum(self):
        self.build_fixture(extra_source={'study-pilot-edge/tools/credentials.py': b'not public'})
        with self.assertRaisesRegex(ValueError, 'current public files'):
            verify_artifacts(self.root, self.folder, self.version)

    def test_stale_test_summary_is_rejected(self):
        self.build_fixture(fingerprint='0' * 64)
        with self.assertRaisesRegex(ValueError, 'summary is missing, stale'):
            verify_artifacts(self.root, self.folder, self.version)


if __name__ == '__main__':
    unittest.main()
