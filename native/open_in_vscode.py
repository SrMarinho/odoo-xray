#!/usr/bin/env python3
import json
import ast
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
import xml.parsers.expat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_PRUNED_DIRS = ('.git', 'node_modules', '.venv', 'venv', '__pycache__')


def display_path(path, base):
    """Show the path relative to its project root, prefixed with the
    root's own folder name, instead of the full local filesystem path."""
    return str(Path(base.name, path.relative_to(base)))


def declarations(message):
    """Find declarations in configured host source trees without importing Odoo."""
    model = message.get('model')
    action = message.get('action')
    symbol = message.get('field') if action == 'locate_field' else message.get('method')
    roots = message.get('roots')
    if (action not in ('locate_field', 'locate_method') or
            not isinstance(model, str) or not isinstance(symbol, str) or
            not isinstance(roots, list) or len(roots) > 12 or
            not model or not symbol or
            any(not (part.replace('_', '').isalnum()) for part in model.split('.')) or
            not symbol.isidentifier()):
        raise ValueError('consulta de origem inválida')
    locations = []
    for root in roots:
        if not isinstance(root, str) or not os.path.isabs(root):
            continue
        base = Path(root).resolve()
        if not base.is_dir():
            continue
        for directory, dirs, files in os.walk(base):
            dirs[:] = [name for name in dirs if name not in ('.git', 'node_modules', '.venv', 'venv', '__pycache__')]
            for filename in files:
                if not filename.endswith('.py'):
                    continue
                path = Path(directory, filename)
                try:
                    if path.stat().st_size > 1024 * 1024:
                        continue
                    tree = ast.parse(path.read_text(encoding='utf-8'))
                except (OSError, UnicodeError, SyntaxError):
                    continue
                for klass in tree.body:
                    if not isinstance(klass, ast.ClassDef):
                        continue
                    model_names = []
                    declared_name = None
                    for node in klass.body:
                        if isinstance(node, (ast.Assign, ast.AnnAssign)):
                            names = [target.id for target in node.targets if isinstance(target, ast.Name)] if isinstance(node, ast.Assign) else [node.target.id] if isinstance(node.target, ast.Name) else []
                            if any(name in ('_name', '_inherit') for name in names):
                                value = node.value
                                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                                    model_names.append(value.value)
                                    if '_name' in names:
                                        declared_name = value.value
                                elif isinstance(value, (ast.List, ast.Tuple)):
                                    model_names.extend(item.value for item in value.elts if isinstance(item, ast.Constant) and isinstance(item.value, str))
                    if model not in model_names or (declared_name and declared_name != model):
                        continue
                    for node in klass.body:
                        if action == 'locate_method' and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == symbol:
                            locations.append({'file': str(path), 'display': display_path(path, base), 'line': node.lineno, 'klass': klass.name, 'module': path.parent.parent.name, 'host': True})
                        if action == 'locate_field' and isinstance(node, (ast.Assign, ast.AnnAssign)):
                            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                            value = node.value
                            is_odoo_field = (isinstance(value, ast.Call) and
                                             isinstance(value.func, ast.Attribute) and
                                             isinstance(value.func.value, ast.Name) and
                                             value.func.value.id == 'fields')
                            if is_odoo_field and any(isinstance(target, ast.Name) and target.id == symbol for target in targets):
                                locations.append({'file': str(path), 'display': display_path(path, base), 'line': node.lineno, 'klass': klass.name, 'module': path.parent.parent.name, 'host': True})
    return {'locations': locations} if action == 'locate_field' else {'overrides': locations}


class _XmlNode:
    """Minimal XML tree with source lines, built by xml.parsers.expat (stdlib,
    no lxml dependency on the native host)."""

    __slots__ = ('tag', 'attrib', 'children', 'sourceline', 'text')

    def __init__(self, tag, attrib, sourceline, children=None):
        self.tag = tag
        self.attrib = attrib
        self.children = children if children is not None else []
        self.sourceline = sourceline
        self.text = ''


def parse_xml_lines(text):
    root_holder = []
    stack = []
    parser = xml.parsers.expat.ParserCreate()

    def start(tag, attrs):
        node = _XmlNode(tag, attrs, parser.CurrentLineNumber)
        if stack:
            stack[-1].children.append(node)
        else:
            root_holder.append(node)
        stack.append(node)

    def end(_tag):
        stack.pop()

    def chardata(data):
        if stack:
            stack[-1].text += data

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = chardata
    parser.Parse(text, True)
    if not root_holder:
        raise ValueError('XML sem elemento raiz')
    return root_holder[0]


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def preorder(node):
    return list(walk(node))


def node_shape(node):
    return (node.tag, tuple(sorted(node.attrib.items())), node.text.strip(),
            tuple(node_shape(child) for child in node.children))


def find_arch_files(arch_fs, roots):
    """Locate every file matching arch_fs (relative to an addons root) under
    the mapped host directories, direct join first, else by path suffix."""
    suffix = Path(arch_fs)
    matches = []
    for root in roots:
        if not isinstance(root, str) or not os.path.isabs(root):
            continue
        base = Path(root).resolve()
        if not base.is_dir():
            continue
        direct = base / arch_fs
        if direct.is_file():
            matches.append((direct, base))
            continue
        for directory, dirs, files in os.walk(base):
            dirs[:] = [name for name in dirs if name not in _PRUNED_DIRS]
            if suffix.name not in files:
                continue
            path = Path(directory, suffix.name)
            if path.parts[-len(suffix.parts):] == suffix.parts:
                matches.append((path, base))
    return matches


def resolve_file(message):
    """Resolve an absolute path from Odoo/container inside configured projects.

    Only the uniquely best suffix match is automatic. Equal best matches are
    returned together so the extension can present the ambiguity.
    """
    source = message.get('file')
    roots = message.get('roots')
    if (not isinstance(source, str) or len(source) > 4096 or '\0' in source or
            not os.path.isabs(source) or not isinstance(roots, list) or len(roots) > 12):
        raise ValueError('resolução de arquivo inválida')
    source_parts = Path(source).parts
    scored = {}
    display = {}
    for root in roots:
        if not isinstance(root, str) or not os.path.isabs(root):
            continue
        base = Path(root).resolve()
        if not base.is_dir():
            continue
        for directory, dirs, files in os.walk(base):
            dirs[:] = [name for name in dirs if name not in _PRUNED_DIRS]
            if Path(source).name not in files:
                continue
            path = Path(directory, Path(source).name).resolve()
            score = 0
            for local_part, source_part in zip(reversed(path.parts), reversed(source_parts)):
                if local_part != source_part:
                    break
                score += 1
            # Filename alone is too weak: require at least its parent directory.
            if score >= 2:
                key = str(path)
                if score >= scored.get(key, -1):
                    scored[key] = score
                    display[key] = display_path(path, base)
    if not scored:
        return {'matches': []}
    best = max(scored.values())
    return {'matches': [{'file': path, 'display': display[path], 'score': score}
                        for path, score in sorted(scored.items()) if score == best]}


def locate_view(message):
    """Find the XML record backing a view and the source line of each
    requested node index, comparing the file's arch against the database's
    to avoid claiming a line that does not match the running composition."""
    xml_id = message.get('xml_id')
    arch_fs = message.get('arch_fs')
    arch = message.get('arch')
    nodes = message.get('nodes')
    roots = message.get('roots')
    if (not isinstance(arch, str) or len(arch) > 1024 * 1024 or
            not isinstance(nodes, list) or len(nodes) > 64 or
            any(not isinstance(n, int) or isinstance(n, bool) or n < 0 for n in nodes) or
            not isinstance(roots, list) or len(roots) > 12):
        raise ValueError('consulta de origem de view inválida')
    if not xml_id or not arch_fs:
        return {'matches': []}
    if (not isinstance(xml_id, str) or not isinstance(arch_fs, str) or
            os.path.isabs(arch_fs) or '..' in Path(arch_fs).parts):
        raise ValueError('identificação de view inválida')
    short_id = xml_id.split('.', 1)[1] if '.' in xml_id else xml_id
    try:
        db_signature = node_shape(parse_xml_lines(arch))
    except (ValueError, xml.parsers.expat.ExpatError):
        return {'matches': [], 'error': 'arch do banco não pôde ser interpretada'}

    matches = []
    for path, base in find_arch_files(arch_fs, roots):
        try:
            if path.stat().st_size > 4 * 1024 * 1024:
                continue
            file_root = parse_xml_lines(path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, ValueError, xml.parsers.expat.ExpatError):
            continue
        for record in walk(file_root):
            if record.tag != 'record' or record.attrib.get('id') not in (xml_id, short_id):
                continue
            field = next((c for c in record.children if c.tag == 'field' and c.attrib.get('name') == 'arch'), None)
            if field is None:
                continue
            children = field.children
            disk = children[0] if len(children) == 1 else _XmlNode('data', {}, field.sourceline, children)
            exact = node_shape(disk) == db_signature
            disk_order = preorder(disk)
            lines = {str(index): disk_order[index].sourceline
                     for index in nodes if exact and index < len(disk_order)}
            matches.append({'file': str(path), 'display': display_path(path, base),
                             'record_line': record.sourceline, 'exact': exact, 'lines': lines})
    return {'matches': matches}


def locate_menu(message):
    """Locate a menuitem or explicit ir.ui.menu record by its XML ID."""
    xml_id = message.get('xml_id')
    roots = message.get('roots')
    if (not isinstance(xml_id, str) or '.' not in xml_id or
            not all(part.replace('_', '').replace('-', '').isalnum()
                    for part in xml_id.split('.')) or
            not isinstance(roots, list) or len(roots) > 12):
        raise ValueError('consulta de menu inválida')
    module, short_id = xml_id.split('.', 1)
    locations = []
    for root in roots:
        if not isinstance(root, str) or not os.path.isabs(root):
            continue
        base = Path(root).resolve()
        if not base.is_dir():
            continue
        for directory, dirs, files in os.walk(base):
            dirs[:] = [name for name in dirs if name not in _PRUNED_DIRS]
            for filename in files:
                if not filename.endswith('.xml'):
                    continue
                path = Path(directory, filename)
                try:
                    if path.stat().st_size > 1024 * 1024:
                        continue
                    tree = parse_xml_lines(path.read_text(encoding='utf-8'))
                except (OSError, UnicodeError, ValueError, xml.parsers.expat.ExpatError):
                    continue
                for node in walk(tree):
                    node_id = node.attrib.get('id')
                    is_menuitem = node.tag == 'menuitem'
                    is_menu_record = node.tag == 'record' and node.attrib.get('model') == 'ir.ui.menu'
                    if (is_menuitem or is_menu_record) and node_id in (short_id, xml_id):
                        locations.append({
                            'file': str(path), 'display': display_path(path, base),
                            'line': node.sourceline, 'module': module, 'host': True,
                        })
    return {'locations': locations}


class SourceLocator:
    """Application boundary for source-code lookup operations."""

    def locate_declaration(self, message):
        return declarations(message)

    def locate_view(self, message):
        return locate_view(message)

    def resolve_file(self, message):
        return resolve_file(message)

    def locate_menu(self, message):
        return locate_menu(message)


class EditorService:
    """Validates editor requests before delegating to the platform adapter."""

    def open(self, message):
        file_path, line = validate_request(message)
        return {'ok': True, 'command': open_editor(file_path, line)}


class XrayApplication:
    """Routes protocol actions without knowing HTTP or stdio transport details."""

    def __init__(self, source_locator=None, editor=None):
        self.source_locator = source_locator or SourceLocator()
        self.editor = editor or EditorService()

    def handle(self, message):
        action = message.get('action')
        if action in ('locate_field', 'locate_method'):
            return self.source_locator.locate_declaration(message)
        if action == 'locate_view':
            return self.source_locator.locate_view(message)
        if action == 'resolve_file':
            return self.source_locator.resolve_file(message)
        if action == 'locate_menu':
            return self.source_locator.locate_menu(message)
        return self.editor.open(message)


_APPLICATION = XrayApplication()


def handle_request(message):
    """Compatibility facade shared by the HTTP and Native Messaging adapters."""
    return _APPLICATION.handle(message)


class NativeMessagingProtocol:
    max_message_size = 1024 * 1024

    def read(self, stream):
        raw_length = stream.read(4)
        if len(raw_length) != 4:
            raise ValueError('mensagem sem tamanho válido')
        length = struct.unpack('=I', raw_length)[0]
        if length > self.max_message_size:
            raise ValueError('mensagem grande demais')
        payload = stream.read(length)
        if len(payload) != length:
            raise ValueError('mensagem incompleta')
        return json.loads(payload.decode('utf-8'))

    def write(self, stream, message):
        payload = json.dumps(message).encode('utf-8')
        stream.write(struct.pack('=I', len(payload)))
        stream.write(payload)
        stream.flush()


_NATIVE_PROTOCOL = NativeMessagingProtocol()


def read_message(stream):
    return _NATIVE_PROTOCOL.read(stream)


def write_message(stream, message):
    _NATIVE_PROTOCOL.write(stream, message)


def validate_request(message):
    if message.get('action') != 'open':
        raise ValueError('ação inválida')
    file_path = message.get('file')
    line = message.get('line')
    if not isinstance(file_path, str) or not os.path.isabs(file_path) or '\0' in file_path:
        raise ValueError('arquivo inválido')
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        raise ValueError('linha inválida')
    if not os.path.isfile(file_path):
        raise ValueError('arquivo não encontrado: %s' % file_path)
    return file_path, line


def display_env():
    """Merge live DISPLAY/WAYLAND_DISPLAY from the systemd user manager into
    the process environment. A service started before the compositor
    exports these (WantedBy=default.target races graphical session setup on
    many window managers, e.g. Hyprland without UWSM) would otherwise launch
    GUI apps with no display target, silently."""
    env = dict(os.environ)
    try:
        output = subprocess.run(
            ['systemctl', '--user', 'show-environment'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return env
    for line in output.splitlines():
        key, _, value = line.partition('=')
        if key in ('DISPLAY', 'WAYLAND_DISPLAY') and value:
            env[key] = value
    return env


def editor_command(file_path, line):
    target = '%s:%d' % (file_path, line)
    if shutil.which('flatpak'):
        installed = subprocess.run(
            ['flatpak', 'info', 'com.visualstudio.code'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
        if installed:
            return ['flatpak', 'run', 'com.visualstudio.code',
                    '--reuse-window', '--goto', target]
    code = shutil.which('code')
    if code:
        return [code, '--reuse-window', '--goto', target]
    raise RuntimeError('VS Code não encontrado')


def open_editor(file_path, line):
    command = editor_command(file_path, line)
    if os.environ.get('XRAY_NATIVE_DRY_RUN') != '1':
        env = display_env()
        if command[:3] == ['flatpak', 'run', 'com.visualstudio.code']:
            process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, env=env,
            )
            # Catch an immediate launcher failure without waiting for the GUI
            # process, whose lifetime is the editor window itself.
            time.sleep(0.5)
            returncode = process.poll()
            if returncode not in (None, 0):
                raise RuntimeError('VS Code terminou com código %d' % returncode)
        else:
            completed = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=15,
                env=env,
            )
            if completed.returncode:
                detail = (completed.stderr or completed.stdout or '').strip()
                raise RuntimeError('VS Code terminou com código %d%s' % (
                    completed.returncode, ': ' + detail if detail else ''))
        if shutil.which('hyprctl'):
            # O CLI já entregou arquivo e linha à instância ativa. Só então
            # trazemos essa mesma janela para o workspace atual.
            time.sleep(0.1)
            focus = subprocess.run(
                ['hyprctl', 'dispatch', 'focuswindow', 'class:^(code)$'],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
    return command


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = 'OdooXRay/1.0'

    def _cors_headers(self):
        origin = self.headers.get('Origin', '')
        if origin.startswith('chrome-extension://') or origin.startswith('moz-extension://'):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Odoo-XRay-Extension')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def send_json(self, status, body):
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path != '/open':
            self.send_json(404, {'ok': False, 'error': 'rota desconhecida'})
            return
        extension_id = self.headers.get('X-Odoo-XRay-Extension')
        if extension_id not in self.server.allowed_extension_ids:
            self.send_json(403, {'ok': False, 'error': 'extensão não autorizada'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 1024 * 1024:
                raise ValueError('tamanho de pedido inválido')
            message = json.loads(self.rfile.read(length).decode('utf-8'))
            self.send_json(200, {'ok': True, **handle_request(message)})
        except Exception as error:
            self.send_json(400, {'ok': False, 'error': str(error)})

    def log_message(self, format_string, *args):
        print('%s - %s' % (self.address_string(), format_string % args), file=sys.stderr)


def serve(extension_ids):
    server = ThreadingHTTPServer(('127.0.0.1', 17654), BridgeHandler)
    server.allowed_extension_ids = set(extension_ids)
    server.serve_forever()


def main():
    try:
        message = read_message(sys.stdin.buffer)
        response = {'ok': True, **handle_request(message)}
    except Exception as error:
        response = {'ok': False, 'error': str(error)}
    write_message(sys.stdout.buffer, response)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--serve':
        serve(sys.argv[2:])
        raise SystemExit(0)
    main()
