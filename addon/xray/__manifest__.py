{
    'name': 'X-Ray',
    'summary': 'Introspecção de campos/modelos/métodos para a extensão Odoo X-Ray',
    'version': '19.0.3.0.0',
    'author': 'SrMarinho',
    'category': 'Tools',
    'license': 'LGPL-3',
    'depends': ['web'],
    'auto_install': False,
    'data': [],
    'assets': {
        'web.assets_backend': [
            'xray/static/src/metadata.js',
            'xray/static/src/metadata.xml',
        ],
    },
    'installable': True,
}
