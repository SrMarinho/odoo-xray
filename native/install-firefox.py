#!/usr/bin/env python3
"""Register the editor host for Firefox on Linux without changing Chromium setup."""
import json
from pathlib import Path
import shutil

EXTENSION_ID = 'odoo-xray@srmarinho'


def install(home):
    host = home / '.local/lib/odoo-xray/open_in_vscode.py'
    host.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(__file__).with_name('open_in_vscode.py'), host)
    host.chmod(0o755)
    manifest = {
        'name': 'com.odoo_xray.editor',
        'description': 'Odoo X-Ray VS Code launcher',
        'path': str(host),
        'type': 'stdio',
        'allowed_extensions': [EXTENSION_ID],
    }
    directory = home / '.mozilla/native-messaging-hosts'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / 'com.odoo_xray.editor.json'
    target.write_text(json.dumps(manifest, indent=2) + '\n')
    return target


if __name__ == '__main__':
    print('Host Firefox instalado:', install(Path.home()))
    print('Recarregue a extensão e a página do Odoo.')
