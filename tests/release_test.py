"""Publication invariants; no network, user credentials or real course files."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from release_lib import EXTENSION_FILES, extension_payload, public_paths, source_fingerprint, write_zip
from check_repo import audit


class ReleaseTests(unittest.TestCase):
    def test_install_archive_contains_only_explicit_assets(self):
        manifest, payload = extension_payload(ROOT)
        self.assertEqual(manifest['manifest_version'], 3)
        self.assertTrue(set(EXTENSION_FILES).issubset(payload))
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


if __name__ == '__main__':
    unittest.main()
