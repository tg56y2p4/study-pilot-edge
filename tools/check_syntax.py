"""Check public JavaScript and Python without touching a real browser."""
import ast
import subprocess
from pathlib import Path
from release_lib import public_paths

ROOT = Path(__file__).resolve().parents[1]
for name in public_paths(ROOT):
    path = ROOT / name
    if path.suffix in {'.js', '.mjs'}:
        subprocess.run(['node', '--check', str(path)], check=True)
    elif path.suffix == '.py':
        ast.parse(path.read_text(encoding='utf-8'), filename=name)
print('Public JavaScript/Python syntax checks passed')
