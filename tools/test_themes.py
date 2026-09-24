"""Contrato do sistema de temas: garante que temas ficam isolados (só
declaram --xray-* dentro de :root/:host) e que a aplicação não inventa
tokens fora do que o tema padrão define — criar um tema novo deve bastar
para copiar um arquivo e adicionar uma entrada no registro."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
THEMES_DIR = ROOT / 'extension/themes'
REGISTRY = THEMES_DIR / 'themes.json'

TOKEN_DECL_RE = re.compile(r'(--xray-[a-z-]+)\s*:')
VAR_USE_RE = re.compile(r'var\(\s*(--xray-[a-z-]+)')
SELECTOR_RE = re.compile(r'([^{}]+)\{')

# Variáveis --xray-* que a aplicação define em runtime via JS (por
# instância, ex. o tamanho do painel arrastado pelo usuário) — não são
# tokens de tema e nenhum tema precisa declará-las.
RUNTIME_VARS = {'--xray-panel-width'}


def declared_tokens(path):
    return set(TOKEN_DECL_RE.findall(path.read_text(encoding='utf-8')))


class ThemeContractTest(unittest.TestCase):
    def setUp(self):
        self.registry = json.loads(REGISTRY.read_text())
        self.theme_files = sorted(THEMES_DIR.glob('*.css'))

    def test_registry_matches_files_on_disk(self):
        registry_ids = {theme['id'] for theme in self.registry['themes']}
        file_ids = {path.stem for path in self.theme_files}
        self.assertEqual(registry_ids, file_ids)
        self.assertIn(self.registry['default'], registry_ids)

    def test_every_theme_defines_the_same_token_contract(self):
        reference = declared_tokens(THEMES_DIR / (self.registry['default'] + '.css'))
        self.assertTrue(reference, 'tema padrão não define nenhum token --xray-*')
        for path in self.theme_files:
            with self.subTest(theme=path.stem):
                self.assertEqual(declared_tokens(path), reference)

    def test_theme_file_only_declares_the_root_block(self):
        for path in self.theme_files:
            text = path.read_text(encoding='utf-8')
            with self.subTest(theme=path.stem):
                for selector in (s.strip() for s in SELECTOR_RE.findall(text)):
                    self.assertIn(':root', selector)
                    self.assertIn(':host', selector)

    def test_components_only_use_tokens_the_contract_defines(self):
        reference = declared_tokens(THEMES_DIR / (self.registry['default'] + '.css'))
        sources = (
            ROOT / 'extension/ui.css',
            ROOT / 'extension/options/options.html',
            ROOT / 'extension/src/content.js',
        )
        used = set()
        for source in sources:
            used |= set(VAR_USE_RE.findall(source.read_text(encoding='utf-8')))
        unknown = used - reference - RUNTIME_VARS
        self.assertEqual(unknown, set(), 'tokens usados fora do contrato: ' + ', '.join(sorted(unknown)))


if __name__ == '__main__':
    unittest.main()
