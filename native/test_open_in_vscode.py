import io
import json
import os
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import open_in_vscode


class NativeHostTest(unittest.TestCase):
    def test_finds_field_and_method_without_odoo_module(self):
        with tempfile.TemporaryDirectory() as directory:
            model_dir = os.path.join(directory, 'addons', 'custom', 'models')
            os.makedirs(model_dir)
            source = os.path.join(model_dir, 'partner.py')
            with open(source, 'w') as handle:
                handle.write('class Partner:\n    _inherit = "res.partner"\n    name = fields.Char()\n    def write(self, vals):\n        pass\n')
            field = open_in_vscode.declarations({
                'action': 'locate_field', 'model': 'res.partner', 'field': 'name',
                'roots': [directory],
            })
            method = open_in_vscode.declarations({
                'action': 'locate_method', 'model': 'res.partner', 'method': 'write',
                'roots': [directory],
            })
            self.assertEqual(field['locations'][0]['line'], 3)
            self.assertEqual(method['overrides'][0]['line'], 4)
            self.assertEqual(field['locations'][0]['file'], source)

    def test_protocol_and_validation(self):
        with tempfile.NamedTemporaryFile() as source:
            message = {'action': 'open', 'file': source.name, 'line': 22}
            payload = json.dumps(message).encode()
            decoded = open_in_vscode.read_message(io.BytesIO(struct.pack('=I', len(payload)) + payload))
            self.assertEqual(open_in_vscode.validate_request(decoded), (source.name, 22))

    def test_rejects_missing_file(self):
        with self.assertRaisesRegex(ValueError, 'não encontrado'):
            open_in_vscode.validate_request({'action': 'open', 'file': '/missing.py', 'line': 1})

    @patch('open_in_vscode.shutil.which')
    @patch('open_in_vscode.subprocess.run')
    def test_flatpak_command(self, run, which):
        which.side_effect = lambda name: '/usr/bin/' + name if name == 'flatpak' else None
        run.return_value.returncode = 0
        command = open_in_vscode.editor_command('/tmp/model.py', 7)
        self.assertEqual(command[-2:], ['--open-url', 'vscode://file/tmp/model.py:7:1'])

    @patch('open_in_vscode.shutil.which')
    @patch('open_in_vscode.subprocess.run')
    def test_flatpak_url_encodes_spaces(self, run, which):
        which.side_effect = lambda name: '/usr/bin/' + name if name == 'flatpak' else None
        run.return_value.returncode = 0
        command = open_in_vscode.editor_command('/tmp/a file.py', 9)
        self.assertEqual(command[-1], 'vscode://file/tmp/a%20file.py:9:1')

    @patch.dict(os.environ, {'XRAY_NATIVE_DRY_RUN': '1'})
    def test_dry_run_preserves_exact_file_and_line(self):
        with patch('open_in_vscode.editor_command') as command:
            command.return_value = ['code', '--goto', '/tmp/a file.py:83']
            self.assertEqual(
                open_in_vscode.open_editor('/tmp/a file.py', 83),
                ['code', '--goto', '/tmp/a file.py:83'],
            )

    @patch('open_in_vscode.time.sleep')
    @patch('open_in_vscode.shutil.which')
    @patch('open_in_vscode.editor_command')
    @patch('open_in_vscode.subprocess.run')
    def test_waits_for_editor_then_focuses(self, run, command, which, _sleep):
        command.return_value = ['code', '--reuse-window', '--goto', '/tmp/model.py:31']
        which.side_effect = lambda name: '/usr/bin/hyprctl' if name == 'hyprctl' else None
        run.side_effect = [
            subprocess.CompletedProcess(command.return_value, 0, '', ''),
            subprocess.CompletedProcess(['hyprctl'], 0, 'ok', ''),
        ]
        self.assertEqual(open_in_vscode.open_editor('/tmp/model.py', 31), command.return_value)
        self.assertEqual(run.call_args_list[0].args[0][-1], '/tmp/model.py:31')

    @patch('open_in_vscode.shutil.which', return_value=None)
    @patch('open_in_vscode.editor_command')
    @patch('open_in_vscode.subprocess.run')
    def test_reports_editor_failure(self, run, command, _which):
        command.return_value = ['code', '--goto', '/tmp/model.py:31']
        run.return_value = subprocess.CompletedProcess(command.return_value, 1, '', 'boom')
        with self.assertRaisesRegex(RuntimeError, 'boom'):
            open_in_vscode.open_editor('/tmp/model.py', 31)

if __name__ == '__main__':
    unittest.main()
