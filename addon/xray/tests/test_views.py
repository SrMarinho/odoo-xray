import json
from lxml import etree

from odoo.exceptions import AccessError
from odoo.tests.common import TransactionCase, tagged, new_test_user
from odoo.addons.xray.models.view_trace import Trace, _TRACE, fingerprint, ViewSource


@tagged('post_install', '-at_install')
class TestViewProvenance(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.xray = cls.env['xray.xray']
        cls.base = cls.env['ir.ui.view'].create({
            'name': 'xray test base', 'model': 'res.partner', 'type': 'form',
            'arch_db': '<form><group name="left"><field name="name"/><field name="email"/></group>'
                       '<group name="right"><field name="phone"/></group></form>',
        })
        cls.ordinary = new_test_user(cls.env, login='xray_ordinary', groups='base.group_user')

    def inherit(self, arch, parent=None, priority=16):
        return self.env['ir.ui.view'].create({
            'name': 'xray test extension', 'model': 'res.partner',
            'inherit_id': (parent or self.base).id, 'priority': priority, 'arch_db': arch,
        })

    def inspect(self, field='name', occurrence=0, xpath=None):
        result = self.env['res.partner'].get_view(self.base.id, 'form')
        root = etree.fromstring(result['arch'].encode())
        nodes = root.xpath(xpath) if xpath else root.xpath('//field[@name=$name]', name=field)
        node = nodes[occurrence]
        identity = json.loads(node.get('data-xray-node'))
        return self.xray.locate_view_node(int(node.get('data-xray-view-id')), identity)

    def test_rendered_nodes_and_breadcrumbs_are_inspectable(self):
        self.base.arch_db = '''<form string="Partner"><sheet><notebook>
            <page name="details" string="Details"><group name="left">
                <h1 class="title">Heading</h1>
                <field name="name"/>
                <button name="action_archive" type="object" string="Archive"/>
                <separator string="Contact"/>
            </group></page>
        </notebook></sheet></form>'''
        for xpath, tag, name in [
            ('//group', 'group', 'left'), ('//page', 'page', 'details'),
            ('//h1', 'h1', None), ('//button', 'button', 'action_archive'),
            ('//separator', 'separator', None),
        ]:
            result = self.inspect(xpath=xpath)
            self.assertNotIn('error', result)
            self.assertEqual(result['target']['tag'], tag)
            self.assertEqual(result['target']['name'], name)
            self.assertNotIn('data-xray-node', result['target']['attributes'])
        button = self.inspect(xpath='//button')
        self.assertEqual([item['tag'] for item in button['breadcrumbs']],
                         ['form', 'sheet', 'notebook', 'page', 'group', 'button'])
        self.assertTrue(all(item['identity']['fingerprint'] for item in button['breadcrumbs']))

    def test_identity_tag_and_name_are_validated(self):
        result = self.env['res.partner'].get_view(self.base.id, 'form')
        root = etree.fromstring(result['arch'].encode())
        node = root.xpath('//field[@name="name"]')[0]
        identity = json.loads(node.get('data-xray-node'))
        identity['tag'] = 'button'
        self.assertIn('error', self.xray.locate_view_node(self.base.id, identity))
        identity['tag'] = 'field'
        identity['name'] = 'email'
        self.assertIn('error', self.xray.locate_view_node(self.base.id, identity))

    def test_method_overrides_are_available_for_object_buttons(self):
        result = self.xray.locate_method('res.partner', 'write')
        self.assertEqual(result['model'], 'res.partner')
        self.assertEqual(result['method'], 'write')
        self.assertTrue(result['overrides'])

    def test_no_debug_and_access_cache(self):
        self.assertTrue(self.xray.capabilities()['without_debug'])
        self.assertEqual(self.inspect()['history'][0]['view']['id'], self.base.id)
        normal_model = self.env['res.partner'].with_user(self.ordinary)
        result = normal_model.get_view(self.base.id, 'form')
        self.assertNotIn('data-xray-', result['arch'])
        # Both cache warm-up orders must preserve separation.
        self.assertIn('data-xray-node', self.env['res.partner'].get_view(self.base.id, 'form')['arch'])
        normal_xray = self.xray.with_user(self.ordinary)
        self.assertFalse(normal_xray.capabilities()['authorized'])
        for method, args in [('roots', []), ('locate_field', ['res.partner', 'name']),
                             ('locate_model', ['res.partner']), ('locate_method', ['res.partner', 'write']),
                             ('locate_view_node', [self.base.id, {}])]:
            with self.assertRaises(AccessError):
                getattr(normal_xray, method)(*args)

    def test_attributes_sequence_and_depth_first(self):
        first = self.inherit('<field name="name" position="attributes"><attribute name="string">First</attribute></field>', priority=10)
        child = self.inherit('<field name="name" position="attributes"><attribute name="string">Child</attribute></field>', parent=first, priority=99)
        last = self.inherit('<field name="name" position="attributes"><attribute name="string">Last</attribute></field>', priority=20)
        result = self.inspect()
        self.assertNotIn('error', result)
        self.assertEqual([v['id'] for v in result['inheritance_chain']], [self.base.id, first.id, child.id, last.id])
        self.assertEqual([e['changes']['string']['after'] for e in result['history'] if e['operation'] == 'attributes'], ['First', 'Child', 'Last'])

    def test_insertions_move_replace_and_occurrences(self):
        insertion = self.inherit('''<data>
            <field name="name" position="before"><field name="website"/></field>
            <field name="name" position="after"><field name="name" string="Second"/></field>
            <group name="right" position="inside"><field name="email" position="move"/></group>
            <field name="phone" position="replace"><field name="phone" string="New phone"/></field>
        </data>''')
        self.assertEqual(self.inspect('website')['history'][-1]['via'], 'before')
        second = self.inspect('name', 1)
        self.assertEqual(second['history'][0]['view']['id'], insertion.id)
        self.assertEqual(self.inspect('name')['history'][0]['view']['id'], self.base.id)
        moved = self.inspect('email')
        self.assertEqual(moved['history'][-1]['operation'], 'move')
        self.assertEqual(moved['target']['path'], '/form/group[2]/field[2]')
        replaced = self.inspect('phone')
        self.assertEqual(replaced['history'][-1]['via'], 'replace')
        self.assertEqual(replaced['history'][-1]['view']['id'], insertion.id)

    def test_dollar_zero_and_ancestor_attributes(self):
        self.inherit('''<data>
            <field name="name" position="replace"><div>$0</div></field>
            <group name="left" position="attributes"><attribute name="invisible">True</attribute></group>
        </data>''')
        result = self.inspect()
        self.assertEqual(result['history'][0]['view']['id'], self.base.id)
        self.assertTrue(any(e['operation'] == 'replace' for e in result['history']))
        self.assertTrue(any(e.get('scope') and e['operation'] == 'attributes' for e in result['history']))

    def test_actual_composition_is_identical(self):
        self.inherit('<field name="name" position="after"><field name="website"/></field>')
        expected, _ = self.env['res.partner']._get_view(self.base.id, 'form')
        token = _TRACE.set(Trace())
        try:
            actual, _ = self.env['res.partner']._get_view(self.base.id, 'form')
        finally:
            _TRACE.reset(token)
        self.assertEqual(etree.tostring(expected), etree.tostring(actual))

    def test_stale_identity_rejected(self):
        arch, _ = self.env['res.partner']._get_view(self.base.id, 'form')
        identity = {'model': 'res.partner', 'field': 'name', 'path': '/form/group[1]/field[1]',
                    'fingerprint': fingerprint(arch)}
        self.inherit('<field name="name" position="attributes"><attribute name="string">Changed</attribute></field>')
        result = self.xray.locate_view_node(self.base.id, identity)
        self.assertIn('error', result)

    def test_root_and_inner_replace_preserve_composition(self):
        self.inherit('''<xpath expr="/form" position="replace"><form><group name="replacement">
            <field name="name"/><field name="phone"/>
        </group></form></xpath>''')
        self.inherit('''<xpath expr="//group[@name='replacement']" position="replace" mode="inner">
            <field name="email"/><field name="name" position="move"/>
        </xpath>''', priority=20)
        expected, _ = self.env['res.partner']._get_view(self.base.id, 'form')
        token = _TRACE.set(Trace())
        try:
            actual, _ = self.env['res.partner']._get_view(self.base.id, 'form')
        finally:
            _TRACE.reset(token)
        self.assertEqual(etree.tostring(expected), etree.tostring(actual))
        self.assertTrue(any(e['operation'] == 'move' for e in self.inspect()['history']))
        self.assertTrue(any(e.get('via') == 'replace' for e in self.inspect('email')['history']))

    def test_inactive_views_and_inline_subview(self):
        inactive = self.inherit('<field name="name" position="attributes"><attribute name="string">Unused</attribute></field>')
        inactive.active = False
        inserted = self.inherit('''<group name="right" position="inside">
            <field name="child_ids"><list><field name="name"/></list></field>
        </group>''')
        result = self.inspect('name', 1)
        self.assertNotIn(inactive.id, [v['id'] for v in result['inheritance_chain']])
        self.assertEqual(result['history'][0]['view']['id'], inserted.id)
        self.assertIn('/list/field', result['target']['path'])

    def test_database_view_has_no_fabricated_location(self):
        result = self.inspect()
        self.assertEqual(result['view']['origin'], 'database')
        self.assertIsNone(result['history'][0]['file'])

    def test_xml_file_location_and_modified_database(self):
        self.env['ir.model.data'].create({'module': 'xray', 'name': 'test_source_view',
                                        'model': 'ir.ui.view', 'res_id': self.base.id})
        self.base.write({'arch_fs': 'xray/tests/data/views.xml'})
        source = ViewSource(self.base)
        self.assertEqual(source.info['origin'], 'file')
        self.assertEqual(source.info['line'], 3)
        result = self.inspect('email')
        self.assertEqual(result['history'][0]['line'], 9)
        self.base.arch_db = self.base.arch_db.replace('name="email"', 'name="email" string="Edited"')
        self.assertEqual(ViewSource(self.base).info['origin'], 'database')
