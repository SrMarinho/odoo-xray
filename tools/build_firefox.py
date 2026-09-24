#!/usr/bin/env python3
"""Build a Firefox MV3 directory from the Chromium extension sources."""

import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'extension'
DEFAULT_DESTINATION = ROOT / 'dist/firefox'


def build(destination=DEFAULT_DESTINATION):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for relative in ('src/background.js', 'src/content.js', 'src/extract.js',
                     'src/rpc.js', 'src/hook.js', 'src/compose.js', 'src/settings.js',
                     'options/options.html', 'options/options.js', 'ui.css'):
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / relative, target)
    shutil.copytree(SOURCE / 'themes', destination / 'themes', dirs_exist_ok=True)

    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    manifest['background'] = {'scripts': [manifest['background']['service_worker']]}
    manifest['browser_specific_settings'] = {'gecko': {
        'id': 'odoo-xray@srmarinho',
        'strict_min_version': '140.0',
        'data_collection_permissions': {'required': ['none']},
    }}
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return destination


if __name__ == '__main__':
    print(build(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DESTINATION))
