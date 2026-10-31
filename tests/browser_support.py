"""Select the isolated browser used by offline extension checks."""
import os
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / 'test-results'
RESULTS.mkdir(exist_ok=True)


def browser_options(browser=None):
    selected = browser or os.environ.get('STUDY_PILOT_BROWSER', 'chromium')
    if selected == 'chromium':
        return {'channel': 'chromium'}
    if selected != 'edge':
        raise ValueError('STUDY_PILOT_BROWSER must be chromium or edge')
    override = os.environ.get('STUDY_PILOT_EDGE_EXECUTABLE')
    if override:
        path = Path(override).expanduser().resolve()
        if not path.is_file():
            raise ValueError('STUDY_PILOT_EDGE_EXECUTABLE does not point to a file')
        return {'executable_path': str(path)}
    if sys.platform == 'win32':
        for root in ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA']:
            folder = os.environ.get(root)
            if folder:
                candidate = Path(folder) / 'Microsoft/Edge/Application/msedge.exe'
                if candidate.is_file():
                    return {'executable_path': str(candidate)}
    return {'channel': 'msedge'}
