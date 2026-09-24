import json
from pathlib import Path
import tempfile
import unittest

from build_firefox import ROOT, build


class BrowserManifestsTest(unittest.TestCase):
    def test_each_browser_has_only_its_supported_background(self):
        chromium = json.loads((ROOT / 'extension/manifest.json').read_text())
        self.assertEqual(chromium['background'], {'service_worker': 'src/background.js'})
        with tempfile.TemporaryDirectory() as directory:
            firefox = json.loads((build(directory) / 'manifest.json').read_text())
            self.assertEqual(firefox['background'], {'scripts': ['src/core.js', 'src/background.js']})
            self.assertEqual(firefox['browser_specific_settings']['gecko']['id'],
                             'odoo-xray@srmarinho')
            self.assertEqual(firefox['content_scripts'], chromium['content_scripts'])
            self.assertTrue((Path(directory) / 'src/background.js').is_file())
            self.assertTrue((Path(directory) / 'src/core.js').is_file())
            self.assertTrue((Path(directory) / 'src/interaction.js').is_file())
            self.assertTrue((Path(directory) / 'src/settings.js').is_file())
            self.assertTrue((Path(directory) / 'ui.css').is_file())
            self.assertTrue((Path(directory) / 'themes/themes.json').is_file())
            self.assertTrue((Path(directory) / 'themes/modern.css').is_file())


if __name__ == '__main__':
    unittest.main()
