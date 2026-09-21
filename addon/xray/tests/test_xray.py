from odoo.tests.common import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestXray(TransactionCase):
    """assert puro, sem fixtures — o menor teste que quebra se a lógica quebrar."""

    def test_locate_field_orders_by_mro(self):
        # res.users.login é sobrescrito em muitos módulos instalados; em
        # qualquer ambiente com pelo menos 'base', deve haver >=1 local e a
        # entrada mais derivada não pode ser 'base' se algo mais específico
        # existir. Aqui garantimos o mínimo universal: 'base' está presente.
        res = self.env['xray.xray'].locate_field('res.users', 'login')
        self.assertNotIn('error', res)
        modules = [loc['module'] for loc in res['locations']]
        self.assertIn('base', modules)
        for loc in res['locations']:
            self.assertNotIn('.', loc['klass'])  # nunca uma classe sintética

    def test_locate_field_automatic(self):
        res = self.env['xray.xray'].locate_field('res.partner', 'display_name')
        self.assertNotIn('error', res)
        self.assertTrue(res['automatic'])
        self.assertEqual(res['locations'], [])

    def test_locate_field_unknown(self):
        res = self.env['xray.xray'].locate_field('res.partner', 'campo_que_nao_existe')
        self.assertIn('error', res)

    def test_locate_model_has_contributors(self):
        res = self.env['xray.xray'].locate_model('res.partner')
        self.assertNotIn('error', res)
        self.assertTrue(res['contributors'])
        self.assertTrue(all('.' not in c['klass'] for c in res['contributors']))

    def test_roots_not_empty(self):
        res = self.env['xray.xray'].roots()
        self.assertTrue(res['addons'])
        self.assertTrue(res['core'])
        self.assertTrue(res['version'])
