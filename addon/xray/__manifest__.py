{
    'name': 'X-Ray',
    'summary': 'Introspecção de campos/modelos/métodos para a extensão Odoo X-Ray',
    'version': '19.0.2.0.0',
    'category': 'Tools',
    'license': 'LGPL-3',
    'depends': ['web'],
    'auto_install': True,
    'data': [],
    'assets': {
        'web.assets_backend': [
            'xray/static/src/metadata.js',
            'xray/static/src/metadata.xml',
        ],
    },
    'installable': True,
}
