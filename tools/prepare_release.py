"""Check the tag, changelog and exact archive payload before publishing."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile

from release_lib import extension_payload, public_paths, source_fingerprint

ROOT = Path(__file__).resolve().parents[1]


def release_metadata(root, tag=None):
    manifest = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))
    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
    version = manifest['version']
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', version):
        raise ValueError('Release version must have three numeric components')
    if any(value != version for value in [package['version'], lock['version'], lock['packages']['']['version']]):
        raise ValueError('Manifest, package and lockfile versions must match')
    if tag is not None and tag != 'v' + version:
        raise ValueError('Release tag does not match the extension version')
    if version + ' ·' not in (root / 'extension/popup.html').read_text(encoding='utf-8'):
        raise ValueError('Update the popup version before releasing')
    if '**当前版本：v' + version + '**' not in (root / 'README.md').read_text(encoding='utf-8'):
        raise ValueError('Update the README version before releasing')
    changelog = (root / 'CHANGELOG.md').read_text(encoding='utf-8')
    sections = list(re.finditer(r'^## ([0-9]+\.[0-9]+\.[0-9]+)(?:[^\n]*)$', changelog, re.M))
    if not sections or sections[0][1] != version:
        raise ValueError('The first changelog section must describe this release')
    changes = changelog[sections[0].end():sections[1].start() if len(sections) > 1 else len(changelog)].strip()
    if not changes:
        raise ValueError('Release changelog must not be empty')
    return {'version': version, 'tag': 'v' + version, 'changes': changes}


def read_archive(path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive members')
        if any(info.file_size > 10 * 1024 * 1024 for info in archive.infolist()):
            raise ValueError('Archive member exceeds publication size limit')
        return {name: archive.read(name) for name in names}


def verify_artifacts(root, folder, version):
    names = [f'study-pilot-edge-v{version}.zip', f'study-pilot-edge-source-v{version}.zip']
    sums = {}
    for line in (folder / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (study-pilot-edge[^/\\\s]+\.zip)', line)
        if not match or match[2] in sums:
            raise ValueError('Invalid or duplicate checksum entry')
        sums[match[2]] = match[1]
    if set(sums) != set(names):
        raise ValueError('Checksums must describe exactly the two current release archives')
    for name in names:
        path = folder / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != sums[name]:
            raise ValueError('Archive checksum mismatch: ' + name)
    source = read_archive(folder / names[1])
    expected_source = {'study-pilot-edge/' + name: (root / name).read_bytes() for name in public_paths(root)}
    if source != expected_source:
        raise ValueError('Source archive does not match the current public files')
    install = read_archive(folder / names[0])
    checks = json.loads(install.pop('CHECKS.json'))
    _manifest, expected_install = extension_payload(root)
    if install != expected_install:
        raise ValueError('Install archive does not match the current extension and documents')
    expected_suites = {'unit', 'edge_or_chromium', 'models', 'workflow', 'mooc', 'pending', 'stability'}
    counts = checks.get('checks', {})
    if (checks.get('source_fingerprint') != source_fingerprint(root)
            or set(counts) != expected_suites
            or any(type(count) is not int or count < 1 for count in counts.values())
            or checks.get('total') != sum(counts.values())
            or checks.get('real_api_tested') is not False
            or checks.get('real_course_tested') is not False):
        raise ValueError('Archive verification summary is missing, stale or not offline')
    return checks


def release_notes(metadata, checks=None, checks_url=None):
    version = metadata['version']
    text = metadata['changes'] + '\n\n'
    text += f'下载 `study-pilot-edge-v{version}.zip` 后解压，在 Edge 扩展管理页加载包含 `manifest.json` 的目录。已有用户重新加载扩展后刷新课程页面；未提交答案请先保存。\n\n'
    text += '源码包用于审阅和开发，`SHA256SUMS.txt` 用于核对同一发布中的两个 ZIP。不同 Python/zlib 环境的压缩字节可能不同，请勿混用其他构建的校验值。\n\n'
    if checks:
        text += f'验证：{checks["total"]} 项扩展离线检查通过；检查使用模拟接口与课程，不代表真实账号的整门课程验收。\n\n'
    if checks_url:
        if not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+', checks_url):
            raise ValueError('Unexpected checks URL')
        text += f'[本次 GitHub Actions]({checks_url})。\n\n'
    text += '本项目使用 MIT 许可证。验证码、考试、独立完成声明和课程讨论由本人按课程要求处理。\n'
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag')
    parser.add_argument('--artifacts', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--checks-url')
    args = parser.parse_args()
    metadata = release_metadata(ROOT, args.tag)
    checks = verify_artifacts(ROOT, args.artifacts, metadata['version']) if args.artifacts else None
    notes = release_notes(metadata, checks, args.checks_url)
    if args.output:
        args.output.write_text(notes, encoding='utf-8')
    print(json.dumps({'tag': metadata['tag'], 'versions_match': True, 'artifacts_verified': checks is not None}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error))
