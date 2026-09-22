import inspect
import os
import re

import odoo
from odoo import api, models, release
from odoo.orm.fields import Field
from odoo.exceptions import AccessError, UserError


def _is_synthetic(klass):
    # o registry monta uma classe combinada por modelo (ex. "res.partner")
    # além das classes "de verdade" que declaram o modelo (ex. "ResPartner").
    # inspect.getsourcelines() falha nessas com OSError.
    return '.' in klass.__name__


def _find_line(klass, name, start, lines):
    pattern = re.compile(r'\s*%s\s*=' % re.escape(name))
    for i, line in enumerate(lines):
        if pattern.match(line):
            return start + i
    return start


class Xray(models.AbstractModel):
    _name = 'xray.xray'
    _description = 'Odoo X-Ray introspection'

    def _check_xray_access(self):
        if not self.env.user.has_group('base.group_system'):
            raise AccessError('Odoo X-Ray: acesso restrito a administradores.')

    @api.model
    def capabilities(self):
        allowed = self.env.user.has_group('base.group_system')
        return {'authorized': allowed, 'version': '19.0.2.0.0',
                'without_debug': allowed, 'view_provenance': allowed}

    @api.model
    def locate_view_node(self, view_id, node_identity):
        self._check_xray_access()
        from .view_trace import inspect_view_node
        if not isinstance(node_identity, dict) or not isinstance(view_id, int):
            raise UserError('Identidade de view inválida.')
        return inspect_view_node(self.env, view_id, node_identity)

    @api.model
    def roots(self):
        """Paths que a extensão precisa mapear pra host, e a versão do Odoo.
        `odoo` é um namespace package (__file__ é None) — release.py não é,
        então é ele que dá o diretório real do core."""
        self._check_xray_access()
        return {
            'addons': list(odoo.addons.__path__),
            'core': os.path.dirname(release.__file__),
            'version': release.version,
        }

    @api.model
    def locate_field(self, model, field):
        """file:line de cada classe que declara `field`, ordenado por MRO
        (mais derivado primeiro — override local antes do core)."""
        self._check_xray_access()
        if model not in self.env:
            return {'error': 'modelo desconhecido: %s' % model}

        record = self.env[model]
        if field not in record._fields:
            return {'error': 'campo desconhecido: %s.%s' % (model, field)}

        fdef = record._fields[field]
        out = []
        for klass in type(record).mro():
            if _is_synthetic(klass):
                continue
            value = vars(klass).get(field)
            if not isinstance(value, Field):
                continue
            try:
                src = inspect.getsourcefile(klass)
                lines, start = inspect.getsourcelines(klass)
                line = _find_line(klass, field, start, lines)
            except (OSError, TypeError):
                continue
            out.append({
                'module': getattr(klass, '_module', None),
                'klass': klass.__name__,
                'file': src,
                'line': line,
            })

        # campo do ORM em si (id, display_name, write_date...): a única
        # classe que o declara é a BaseModel do core, sem módulo. Odoo não
        # expõe um `Field.automatic` (só existe no ir.model.fields do banco).
        automatic = bool(out) and all(loc['module'] is None for loc in out)
        if automatic:
            out = []

        return {
            'model': model,
            'field': field,
            'type': fdef.type,
            'related': fdef.related,
            'compute': bool(fdef.compute),
            'store': fdef.store,
            'automatic': bool(automatic),
            'modules': list(fdef._modules) if not automatic else [],
            'locations': out,
        }

    @api.model
    def locate_model(self, model):
        """MRO inteira do modelo — toda classe que contribui pra ele."""
        self._check_xray_access()
        if model not in self.env:
            return {'error': 'modelo desconhecido: %s' % model}

        out = []
        for klass in type(self.env[model]).mro():
            if _is_synthetic(klass) or not getattr(klass, '_module', None):
                continue
            try:
                src = inspect.getsourcefile(klass)
                _, start = inspect.getsourcelines(klass)
            except (OSError, TypeError):
                continue
            out.append({
                'module': klass._module,
                'klass': klass.__name__,
                'file': src,
                'line': start,
            })
        return {'model': model, 'contributors': out}

    @api.model
    def locate_method(self, model, name):
        """Toda classe que declara/sobrescreve o método `name`, na ordem
        em que o MRO resolve a chamada (a primeira é quem executa)."""
        self._check_xray_access()
        if model not in self.env:
            return {'error': 'modelo desconhecido: %s' % model}

        out = []
        for klass in type(self.env[model]).mro():
            if _is_synthetic(klass):
                continue
            value = vars(klass).get(name)
            if not callable(value):
                continue
            try:
                src = inspect.getsourcefile(value)
                _, start = inspect.getsourcelines(value)
            except (OSError, TypeError):
                continue
            out.append({
                'module': getattr(klass, '_module', None),
                'klass': klass.__name__,
                'file': src,
                'line': start,
            })
        return {'model': model, 'method': name, 'overrides': out}
