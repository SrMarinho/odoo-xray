#!/usr/bin/env python3
import json
import os
import shutil
import struct
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote


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
            file_path, line = validate_request(message)
            open_editor(file_path, line)
            self.send_json(200, {'ok': True})
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
        file_path, line = validate_request(message)
        command = open_editor(file_path, line)
        response = {'ok': True, 'command': command}
    except Exception as error:
        response = {'ok': False, 'error': str(error)}
    write_message(sys.stdout.buffer, response)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--serve':
        serve(sys.argv[2:])
        raise SystemExit(0)
    main()
