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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote


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
                            locations.append({'file': str(path), 'line': node.lineno, 'klass': klass.name, 'module': path.parent.parent.name, 'host': True})
                        if action == 'locate_field' and isinstance(node, (ast.Assign, ast.AnnAssign)):
                            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                            value = node.value
                            is_odoo_field = (isinstance(value, ast.Call) and
                                             isinstance(value.func, ast.Attribute) and
                                             isinstance(value.func.value, ast.Name) and
                                             value.func.value.id == 'fields')
                            if is_odoo_field and any(isinstance(target, ast.Name) and target.id == symbol for target in targets):
                                locations.append({'file': str(path), 'line': node.lineno, 'klass': klass.name, 'module': path.parent.parent.name, 'host': True})
    return {'locations': locations} if action == 'locate_field' else {'overrides': locations}


def handle_request(message):
    if message.get('action') in ('locate_field', 'locate_method'):
        return declarations(message)
    file_path, line = validate_request(message)
    return {'ok': True, 'command': open_editor(file_path, line)}


def read_message(stream):
    raw_length = stream.read(4)
    if len(raw_length) != 4:
        raise ValueError('mensagem sem tamanho válido')
    length = struct.unpack('=I', raw_length)[0]
    if length > 1024 * 1024:
        raise ValueError('mensagem grande demais')
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError('mensagem incompleta')
    return json.loads(payload.decode('utf-8'))


def write_message(stream, message):
    payload = json.dumps(message).encode('utf-8')
    stream.write(struct.pack('=I', len(payload)))
    stream.write(payload)
    stream.flush()


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


def editor_command(file_path, line):
    target = '%s:%d' % (file_path, line)
    if shutil.which('flatpak'):
        installed = subprocess.run(
            ['flatpak', 'info', 'com.visualstudio.code'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
        if installed:
            # O CLI --goto do Flatpak pode retornar sucesso e deixar o arquivo
            # numa aba inativa. A URL é encaminhada à instância gráfica e ativa
            # o editor exatamente em linha/coluna.
            editor_url = 'vscode://file%s:%d:1' % (quote(file_path, safe='/'), line)
            return ['flatpak', 'run', 'com.visualstudio.code', '--open-url', editor_url]
    code = shutil.which('code')
    if code:
        return [code, '--reuse-window', '--goto', target]
    raise RuntimeError('VS Code não encontrado')


def open_editor(file_path, line):
    command = editor_command(file_path, line)
    if os.environ.get('XRAY_NATIVE_DRY_RUN') != '1':
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
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
            )
            if focus.returncode:
                raise RuntimeError('arquivo aberto, mas não foi possível focar o VS Code: %s' %
                                   (focus.stderr or focus.stdout).strip())
    return command


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = 'OdooXRay/1.0'

    def send_json(self, status, body):
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
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
            if length < 1 or length > 64 * 1024:
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
