import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-firefox.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class FirefoxInstallTest(unittest.TestCase):
    def test_registration_matches_extension_and_preserves_chromium(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            chromium = home / '.config/google-chrome/NativeMessagingHosts/com.odoo_xray.editor.json'
            chromium.parent.mkdir(parents=True)
            chromium.write_text('existing registration')
            manifest_path = installer.install(home)
            installer.install(home)
            manifest = json.loads(manifest_path.read_text())
            self.assertEqual(manifest['allowed_extensions'], [installer.EXTENSION_ID])
            self.assertEqual(installer.EXTENSION_ID, 'odoo-xray@srmarinho')
            self.assertEqual(chromium.read_text(), 'existing registration')
            self.assertTrue(Path(manifest['path']).stat().st_mode & 0o100)
            self.assertNotIn('allowed_origins', manifest)


if __name__ == '__main__':
    unittest.main()
