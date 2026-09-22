"""Request-local provenance; composition is always performed by Odoo itself."""
from collections import deque
from contextvars import ContextVar
from copy import deepcopy
import hashlib
import json

from lxml import etree

from odoo import api, models
from odoo.exceptions import UserError
from odoo.tools.misc import file_path
from odoo.tools.template_inheritance import locate_node

_TRACE = ContextVar('xray_view_trace', default=None)


def elements(tree):
    return [node for node in tree.iter() if isinstance(node.tag, str)]


def shape(node):
    """Ignore formatting only. Never claim a disk location for changed XML."""
    return (node.tag, tuple(sorted(node.attrib.items())), (node.text or '').strip(),
            tuple(shape(child) for child in node if isinstance(child.tag, str)))


def fingerprint(arch):
    clean = deepcopy(arch)
    for node in elements(clean):
        for name in list(node.attrib):
            if name.startswith('data-xray-') or name == '__validate__':
                del node.attrib[name]
    return hashlib.sha256(etree.tostring(clean, method='c14n')).hexdigest()


class ViewSource:
    def __init__(self, view):
        self.info = {'id': view.id, 'name': view.name, 'xml_id': view.xml_id or None,
                     'module': (view.xml_id or '').partition('.')[0] or None,
                     'inherit_id': view.inherit_id.id or None, 'priority': view.priority,
                     'mode': view.mode, 'file': None, 'line': None, 'origin': 'database'}
        self.lines = {}
        self.bound = {}
        self.signatures = {}
        if not view.arch_fs or not view.xml_id:
            return
        try:
            path = file_path(view.arch_fs)
            parser = etree.XMLParser(resolve_entities=False, no_network=True)
            document = etree.parse(path, parser)
            short_id = view.xml_id.split('.', 1)[1]
            records = document.xpath('//record[@id=$full or @id=$short]',
                                     full=view.xml_id, short=short_id)
            candidates = []
            for record in records:
                field = record.find("field[@name='arch']")
                if field is None:
                    continue
                children = [n for n in field if isinstance(n.tag, str)]
                if len(children) == 1:
                    disk = children[0]
                else:
                    disk = etree.Element('data')
                    disk.extend(deepcopy(children))
                db = etree.fromstring(view.with_context(lang=None).arch_db.encode())
                if shape(disk) == shape(db):
                    candidates.append((record, disk, db))
            # Multiple definitions of the same record are ambiguous.
            if len(candidates) != 1:
                return
            record, disk, db = candidates[0]
            actual = etree.fromstring(view.arch.encode())
            actual_nodes, disk_nodes = elements(actual), elements(disk)
            if len(actual_nodes) != len(disk_nodes):
                return
            if any(a.tag != b.tag for a, b in zip(actual_nodes, disk_nodes)):
                return
            self.info.update(file=path, line=record.sourceline, origin='file')
            actual_tree = actual.getroottree()
            for a, b in zip(actual_nodes, disk_nodes):
                line = b.sourceline or record.sourceline
                self.lines[actual_tree.getpath(a)] = line
                self.signatures.setdefault(shape(a), set()).add(line)
        except (OSError, ValueError, etree.XMLSyntaxError):
            # Missing/deployed-without-source files remain inspectable in the DB.
            return

    def bind(self, tree):
        root_tree = tree.getroottree()
        for node in elements(tree):
            self.bound[node] = self.lines.get(root_tree.getpath(node))

    def location(self, node):
        line = self.bound.get(node)
        if node not in self.bound:
            candidates = self.signatures.get(shape(node), set())
            line = next(iter(candidates)) if len(candidates) == 1 else None
        return {'file': self.info['file'],
                'line': line if self.info['file'] else None}


class Trace:
    def __init__(self):
        self.root = None
        self.chain = []
        self.histories = {}
        self.sources = {}
        self.sequence = 0

    def source(self, view):
        if view.id not in self.sources:
            self.sources[view.id] = ViewSource(view)
        return self.sources[view.id]

    def event(self, source, node, operation, **extra):
        self.sequence += 1
        return {'sequence': self.sequence, 'operation': operation,
                'view': source.info, **source.location(node), **extra}

    def initialize(self, arch):
        if self.histories:
            return
        self.chain.append(self.root.info)
        self.root.bind(arch)
        for node in elements(arch):
            self.histories[node] = [self.event(self.root, node, 'create')]

    def apply(self, view, source, specs, apply, pre_locate):
        self.initialize(source)
        origin = self.source(view)
        if not isinstance(specs, list):
            origin.bind(specs)
        self.chain.append(origin.info)
        queue = deque(specs if isinstance(specs, list) else [specs])
        while queue:
            spec = queue.popleft()
            if not isinstance(spec.tag, str):
                continue
            if spec.tag == 'data':
                queue.extend(spec)
                continue
            before = set(elements(source))
            moved = []
            target = None
            old_attrs = {}
            operation = spec.get('position', 'inside')
            selector = spec.get('expr') or etree.tostring(spec, encoding='unicode').split('>')[0] + '>'
            event = self.event(origin, spec, operation, selector=selector)
            copied_target = None
            copied_histories = None

            def on_locate(current_spec):
                nonlocal target, old_attrs, copied_target, copied_histories
                if pre_locate:
                    pre_locate(current_spec)
                node = locate_node(source, current_spec)
                if current_spec is spec:
                    target = node
                    old_attrs = dict(node.attrib) if node is not None else {}
                    if node is not None and spec.xpath(".//*[text()='$0']"):
                        copied_target = deepcopy(node)
                        copied_histories = [list(self.histories.get(n, [])) for n in elements(node)]
                elif current_spec.get('position') == 'move' and node is not None:
                    moved.append((node, self.event(origin, current_spec, 'move',
                                                  selector=current_spec.get('expr') or current_spec.get('name'))))

            # Run the real Odoo operation, including Studio's pre_locate hook.
            source = apply(source, spec, on_locate)
            after = set(elements(source))
            for node in after - before:
                self.histories[node] = [{**event, **origin.location(node), 'operation': 'create',
                                         'via': operation}]
            if copied_target is not None:
                # Odoo's $0 replacement deep-copies the selected subtree.
                for node in elements(source):
                    if node not in before and shape(node) == shape(copied_target):
                        for clone, history in zip(elements(node), copied_histories):
                            self.histories[clone] = history + [event]
            if target is not None and target in after:
                changes = {key: {'before': old_attrs.get(key), 'after': target.get(key)}
                           for key in old_attrs.keys() | target.attrib.keys()
                           if old_attrs.get(key) != target.get(key)}
                self.histories.setdefault(target, []).append({**event, 'changes': changes})
            elif target is not None and operation == 'replace':
                prior = self.histories.get(target, [])
                for node in after - before:
                    if self.histories[node] and self.histories[node][0]['sequence'] == event['sequence']:
                        self.histories[node] = prior + self.histories[node]
            for node, move_event in moved:
                if node in after:
                    self.histories.setdefault(node, []).append(move_event)
        return source


class XrayView(models.Model):
    _inherit = 'ir.ui.view'

    def _combine(self, hierarchy):
        trace = _TRACE.get()
        if trace is not None:
            trace.root = trace.source(self)
        arch = super()._combine(hierarchy)
        if trace is not None:
            trace.initialize(arch)
        return arch

    def apply_inheritance_specs(self, source, specs_tree, pre_locate=None):
        trace = _TRACE.get()
        if trace is None:
            return super().apply_inheritance_specs(source, specs_tree, pre_locate)
        return trace.apply(self, source, specs_tree,
                           super().apply_inheritance_specs, pre_locate)


class XrayBase(models.AbstractModel):
    _inherit = 'base'

    @api.model
    def _get_view_cache_key(self, view_id=None, view_type='form', **options):
        return super()._get_view_cache_key(view_id, view_type, **options) + (
            self.env.user.has_group('base.group_system'),)

    def _get_view_postprocessed(self, view, arch, **options):
        if view and self.env.user.has_group('base.group_system'):
            digest = fingerprint(arch)
            tree = arch.getroottree()
            context = {k: v for k, v in self.env.context.items()
                       if k == 'lang' or k.endswith('_view_ref')}
            for node in elements(arch):
                if node.tag != 'field':
                    continue
                identity = {'path': tree.getpath(node), 'fingerprint': digest,
                            'model': self._name, 'field': node.get('name'),
                            'view_type': view.type, 'context': context,
                            'mobile': bool(options.get('mobile'))}
                node.set('data-xray-view-id', str(view.id))
                node.set('data-xray-node', json.dumps(identity, separators=(',', ':')))
        return super()._get_view_postprocessed(view, arch, **options)


class XrayHttp(models.AbstractModel):
    _inherit = 'ir.http'

    @api.model
    def session_info(self):
        result = super().session_info()
        result['xray_enabled'] = self.env.user.has_group('base.group_system')
        return result


def inspect_view_node(env, view_id, identity):
    model = identity.get('model')
    if model not in env or not view_id:
        raise UserError('View ou modelo desconhecido.')
    view = env['ir.ui.view'].browse(view_id).exists()
    if not view or view.model != model:
        raise UserError('A view não pertence ao modelo informado.')
    view.check_access('read')
    env[model].check_access('read')
    context = identity.get('context', {})
    if not isinstance(context, dict):
        raise UserError('Contexto inválido.')
    context = {k: v for k, v in context.items() if k == 'lang' or k.endswith('_view_ref')}
    trace = Trace()
    token = _TRACE.set(trace)
    try:
        arch, resolved = env[model].with_context(**context)._get_view(
            view.id, view.type, mobile=bool(identity.get('mobile')))
    finally:
        _TRACE.reset(token)
    if fingerprint(arch) != identity.get('fingerprint'):
        return {'error': 'A view mudou. Recarregue a página para inspecionar a versão atual.'}
    # Compare generated paths instead of evaluating an arbitrary client XPath.
    tree = arch.getroottree()
    node = next((n for n in elements(arch) if tree.getpath(n) == identity.get('path')), None)
    if node is None or node.tag != 'field' or node.get('name') != identity.get('field'):
        return {'error': 'Elemento não encontrado nesta versão da view.'}
    history = list(trace.histories.get(node, []))
    # A move/attribute change on a containing group affects its descendants too.
    for ancestor in node.iterancestors():
        history.extend({**event, 'scope': tree.getpath(ancestor)}
                       for event in trace.histories.get(ancestor, [])
                       if event['operation'] in ('move', 'attributes', 'replace'))
    history.sort(key=lambda event: event['sequence'])
    return {'view': trace.source(resolved).info,
            'target': {'field': node.get('name'), 'path': identity['path'],
                       'attributes': dict(node.attrib)},
            'history': history, 'inheritance_chain': trace.chain,
            'warning': None if history else 'Elemento criado ou substituído por código Python; origem XML indisponível.'}
