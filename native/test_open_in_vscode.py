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
    def test_application_routes_actions_through_injected_services(self):
        class Sources:
            def locate_declaration(self, message):
                return {'route': 'declaration', 'action': message['action']}

            def locate_view(self, _message):
                return {'route': 'view'}

            def resolve_file(self, _message):
                return {'route': 'file'}

        class Editor:
            def open(self, _message):
                return {'route': 'editor'}

        application = open_in_vscode.XrayApplication(Sources(), Editor())
        self.assertEqual(application.handle({'action': 'locate_field'}),
                         {'route': 'declaration', 'action': 'locate_field'})
        self.assertEqual(application.handle({'action': 'locate_view'}), {'route': 'view'})
        self.assertEqual(application.handle({'action': 'resolve_file'}), {'route': 'file'})
        self.assertEqual(application.handle({'action': 'open'}), {'route': 'editor'})

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

    def test_locate_view_matches_exact_line(self):
        with tempfile.TemporaryDirectory() as directory:
            views_dir = os.path.join(directory, 'sale', 'views')
            os.makedirs(views_dir)
            xml_path = os.path.join(views_dir, 'sale_order_views.xml')
            with open(xml_path, 'w') as handle:
                handle.write(
                    '<odoo>\n'
                    '  <record id="view_order_form" model="ir.ui.view">\n'
                    '    <field name="name">sale.order.form</field>\n'
                    '    <field name="arch" type="xml">\n'
                    '      <field name="partner_id"/>\n'
                    '    </field>\n'
                    '  </record>\n'
                    '</odoo>\n'
                )
            result = open_in_vscode.locate_view({
                'xml_id': 'sale.view_order_form', 'arch_fs': 'sale/views/sale_order_views.xml',
                'arch': '<field name="partner_id"/>', 'nodes': [0], 'roots': [directory],
            })
            self.assertEqual(len(result['matches']), 1)
            match = result['matches'][0]
            self.assertTrue(match['exact'])
            self.assertEqual(match['file'], xml_path)
            self.assertEqual(match['record_line'], 2)
            self.assertEqual(match['lines']['0'], 5)

    def test_locate_view_reports_divergent_file(self):
        with tempfile.TemporaryDirectory() as directory:
            views_dir = os.path.join(directory, 'sale', 'views')
            os.makedirs(views_dir)
            xml_path = os.path.join(views_dir, 'sale_order_views.xml')
            with open(xml_path, 'w') as handle:
                handle.write(
                    '<odoo><record id="view_order_form" model="ir.ui.view">'
                    '<field name="arch" type="xml"><field name="other_field"/></field>'
                    '</record></odoo>'
                )
            result = open_in_vscode.locate_view({
                'xml_id': 'sale.view_order_form', 'arch_fs': 'sale/views/sale_order_views.xml',
                'arch': '<field name="partner_id"/>', 'nodes': [0], 'roots': [directory],
            })
            self.assertEqual(len(result['matches']), 1)
            self.assertFalse(result['matches'][0]['exact'])
            self.assertEqual(result['matches'][0]['lines'], {})

    def test_locate_view_missing_file_returns_no_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            result = open_in_vscode.locate_view({
                'xml_id': 'sale.view_order_form', 'arch_fs': 'sale/views/missing.xml',
                'arch': '<form/>', 'nodes': [], 'roots': [directory],
            })
            self.assertEqual(result['matches'], [])

    def test_locate_view_rejects_path_traversal(self):
        with self.assertRaisesRegex(ValueError, 'inválid'):
            open_in_vscode.locate_view({
                'xml_id': 'sale.view_order_form', 'arch_fs': '../../etc/passwd',
                'arch': '<form/>', 'nodes': [], 'roots': ['/tmp'],
            })

    def test_locate_view_searches_multiple_roots(self):
        with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
            views_dir = os.path.join(two, 'sale', 'views')
            os.makedirs(views_dir)
            xml_path = os.path.join(views_dir, 'sale_order_views.xml')
            with open(xml_path, 'w') as handle:
                handle.write(
                    '<odoo><record id="view_order_form" model="ir.ui.view">'
                    '<field name="arch" type="xml"><form/></field>'
                    '</record></odoo>'
                )
            result = open_in_vscode.locate_view({
                'xml_id': 'sale.view_order_form', 'arch_fs': 'sale/views/sale_order_views.xml',
                'arch': '<form/>', 'nodes': [], 'roots': [one, two],
            })
            self.assertEqual(len(result['matches']), 1)
            self.assertEqual(result['matches'][0]['file'], xml_path)

    def test_resolve_container_file_by_project_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            views_dir = os.path.join(directory, 'abastecimento', 'views')
            os.makedirs(views_dir)
            source = os.path.join(views_dir, 'fatura.xml')
            with open(source, 'w') as handle:
                handle.write('<odoo/>')
            result = open_in_vscode.resolve_file({
                'action': 'resolve_file',
                'file': '/mnt/extra-addons/abastecimento/views/fatura.xml',
                'roots': [directory],
            })
            self.assertEqual(result['matches'][0]['file'], source)

    def test_resolve_file_returns_equal_best_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            expected = []
            for project in ('one', 'two'):
                model_dir = os.path.join(directory, project, 'sale', 'models')
                os.makedirs(model_dir)
                source = os.path.join(model_dir, 'order.py')
                with open(source, 'w') as handle:
                    handle.write('')
                expected.append(source)
            result = open_in_vscode.resolve_file({
                'action': 'resolve_file',
                'file': '/mnt/addons/sale/models/order.py',
                'roots': [directory],
            })
            self.assertEqual([match['file'] for match in result['matches']], expected)

    def test_resolve_file_rejects_filename_only_match(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, 'different', 'order.py')
            os.makedirs(os.path.dirname(source))
            with open(source, 'w') as handle:
                handle.write('')
            result = open_in_vscode.resolve_file({
                'action': 'resolve_file', 'file': '/mnt/sale/order.py', 'roots': [directory],
            })
            self.assertEqual(result['matches'], [])

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
