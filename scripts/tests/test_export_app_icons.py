"""Synthetic application bundles only; no installed-app reads or native tools."""
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib


SPEC = importlib.util.spec_from_file_location(
    'export_app_icons', Path(__file__).resolve().parents[1] / 'export-app-icons.py')
EXPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORTER)
BUNDLE_ID = 'dev.example.Player'


def png_fixture(width=1, height=1, color_type=2, cgbi=False, alpha=0, single_pixel=False):
    """Small parser fixtures; no application image pixels are read or edited."""
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    data = EXPORTER.PNG_SIGNATURE
    if cgbi:
        data += chunk(b'CgBI', b'\0\0\0\0')
    data += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0))
    pixel = b'\0\0\0' + (bytes([alpha]) if color_type == 6 else b'')
    rows = (b'\0' + pixel * width) * height
    if single_pixel:
        rows = rows[:4] + b'\xff' + rows[5:]
    data += chunk(b'IDAT', zlib.compress(rows))
    return data + chunk(b'IEND', b'')


class BundleIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='macflare-icon-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / 'Example.app'
        self.bundle.mkdir()

    def metadata(self, relative, bundle_id=BUNDLE_ID):
        path = self.bundle / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        info = {'CFBundleIdentifier': bundle_id, 'CFBundleDisplayName': 'Example'}
        path.write_bytes(plistlib.dumps(info))
        return info

    def test_configuration_accepts_legacy_underscore_bundle_identifier(self):
        item = {'app': 'Image Capture', 'id': 'image-capture', 'bundleId': 'com.apple.Image_Capture',
                'query': 'Image Capture', 'aliases': ['Image Capture'], 'matchNames': ['Image Capture']}
        config = self.root / 'config.json'
        config.write_text(json.dumps({'version': 1, 'apps': [item]}), encoding='utf-8')
        self.assertEqual(EXPORTER.read_config(config), [item])

    def test_configuration_rejects_bundle_query_injection_and_paths(self):
        item = {'app': 'Example', 'id': 'example', 'query': 'Example',
                'aliases': ['Example'], 'matchNames': ['Example']}
        config = self.root / 'config.json'
        for bundle_id in ('com.example" || true || "', "com.example'", 'com.example\\escape',
                          '../Example.app', 'com/example', 'com.example\n', 'com.example\0',
                          'com.example app', 'com.example.*', 'com.example.＿app'):
            with self.subTest(bundle_id=bundle_id):
                config.write_text(json.dumps({'version': 1, 'apps': [{**item, 'bundleId': bundle_id}]}), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Invalid bundleId'):
                    EXPORTER.read_config(config)

    def test_standard_macos_bundle_requires_exact_identity(self):
        expected = self.metadata('Contents/Info.plist')
        self.assertEqual(EXPORTER.bundle_info(self.bundle, BUNDLE_ID), expected)
        for wrong in ('dev.example', BUNDLE_ID.lower(), BUNDLE_ID + '.Helper'):
            with self.subTest(wrong=wrong):
                self.assertIsNone(EXPORTER.bundle_info(self.bundle, wrong))

    def test_root_info_plist_is_supported(self):
        expected = self.metadata('Info.plist')
        self.assertEqual(EXPORTER.bundle_info(self.bundle, BUNDLE_ID), expected)

    def test_wrapper_accepts_only_direct_application_identity(self):
        for relative in ('Wrapper/Player.app/Info.plist', 'Wrapper/Player.app/Contents/Info.plist'):
            with self.subTest(relative=relative):
                expected = self.metadata(relative)
                self.assertEqual(EXPORTER.bundle_info(self.bundle, BUNDLE_ID), expected)
                (self.bundle / relative).unlink()

    def test_locate_preserves_outer_bundle_for_native_workspace_icon(self):
        expected = self.metadata('Wrapper/Player.app/Info.plist')
        item = {'app': 'Example', 'bundleId': BUNDLE_ID, 'aliases': [], 'matchNames': []}
        with patch.object(EXPORTER, 'APP_ROOTS', (self.root,)), \
                patch.object(EXPORTER.subprocess, 'run', side_effect=AssertionError('No native search expected')):
            self.assertEqual(EXPORTER.locate_app(item), (self.bundle, expected))

    def test_nested_helpers_plugins_and_unrelated_identities_do_not_match(self):
        self.metadata('Contents/Info.plist', 'dev.example.Other')
        self.metadata('Contents/Library/LoginItems/Helper.app/Contents/Info.plist')
        self.metadata('Contents/PlugIns/Plugin.app/Contents/Info.plist')
        self.metadata('Wrapper/Player.app/Info.plist', 'dev.example.Other')
        self.metadata('Wrapper/Player.app/Contents/Helpers/Helper.app/Info.plist')
        self.metadata('Wrapper/Subdirectory/Hidden.app/Info.plist')
        self.metadata('Wrapper/Plugin.appex/Info.plist')
        self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))

    def test_invalid_standard_metadata_does_not_hide_valid_root_metadata(self):
        self.metadata('Contents/Info.plist')
        (self.bundle / 'Contents/Info.plist').write_bytes(b'not a property list')
        expected = self.metadata('Info.plist')
        self.assertEqual(EXPORTER.bundle_info(self.bundle, BUNDLE_ID), expected)

    def test_metadata_symlinks_cannot_escape_outer_bundle(self):
        outside = self.root / 'outside.plist'
        outside.write_bytes(plistlib.dumps({'CFBundleIdentifier': BUNDLE_ID}))
        for relative in ('Contents/Info.plist', 'Info.plist', 'Wrapper/Player.app/Info.plist'):
            with self.subTest(relative=relative):
                metadata = self.bundle / relative
                metadata.parent.mkdir(parents=True, exist_ok=True)
                metadata.symlink_to(outside)
                self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))
                metadata.unlink()

    def test_wrapper_and_application_links_cannot_import_external_bundles(self):
        outside = self.root / 'outside'
        app = outside / 'Player.app'
        app.mkdir(parents=True)
        (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': BUNDLE_ID}))
        wrapper = self.bundle / 'Wrapper'
        wrapper.symlink_to(outside, target_is_directory=True)
        self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))
        wrapper.unlink()
        wrapper.mkdir()
        (wrapper / 'Player.app').symlink_to(app, target_is_directory=True)
        self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))

    def test_wrapper_links_cannot_relabel_internal_helpers(self):
        self.metadata('Contents/Helpers/Helper.app/Info.plist')
        wrapper = self.bundle / 'Wrapper'
        wrapper.symlink_to(self.bundle / 'Contents/Helpers', target_is_directory=True)
        self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))
        wrapper.unlink()
        wrapper.mkdir()
        (wrapper / 'Helper.app').symlink_to(self.bundle / 'Contents/Helpers/Helper.app', target_is_directory=True)
        self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))

    def test_wrapper_scan_is_bounded(self):
        expected = self.metadata('Wrapper/Selected.app/Info.plist')
        wrapper = self.bundle / 'Wrapper'
        for index in range(32):
            (wrapper / f'Other-{index:02d}.txt').touch()
        with EXPORTER.os.scandir(wrapper) as scan:
            entries = sorted(scan, key=lambda entry: entry.name)
        with patch.object(EXPORTER.os, 'scandir', return_value=nullcontext(iter(entries))):
            self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))
        with patch.object(EXPORTER.os, 'scandir', return_value=nullcontext(iter(entries[-1:]))):
            self.assertEqual(EXPORTER.bundle_info(self.bundle, BUNDLE_ID), expected)

    def test_missing_non_application_and_symlink_loop_fail_closed(self):
        self.assertIsNone(EXPORTER.bundle_info(self.root / 'Missing.app', BUNDLE_ID))
        self.assertIsNone(EXPORTER.bundle_info(self.root, BUNDLE_ID))
        (self.bundle / 'Info.plist').symlink_to(self.bundle / 'Info.plist')
        self.assertIsNone(EXPORTER.bundle_info(self.bundle, BUNDLE_ID))

    def primary_metadata(self, files, ipad_files=None):
        relative = 'Wrapper/Player.app/Info.plist'
        info = self.metadata(relative)
        info['CFBundleIcons'] = {'CFBundlePrimaryIcon': {'CFBundleIconFiles': files}}
        if ipad_files is not None:
            info['CFBundleIcons~ipad'] = {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ipad_files}}
        (self.bundle / relative).write_bytes(plistlib.dumps(info))
        return info, (self.bundle / relative).parent

    def test_primary_icon_uses_largest_declared_variant_in_exact_wrapper(self):
        info, inner = self.primary_metadata(['AppIcon60x60'], ['AppIcon83.5x83.5'])
        selected = inner / 'AppIcon60x60@3x.png'
        selected.write_bytes(png_fixture(180, 180, cgbi=True))
        (inner / 'AppIcon60x60@2x.png').write_bytes(png_fixture(120, 120))
        (inner / 'AppIcon83.5x83.5@2x~ipad.png').write_bytes(png_fixture(167, 167))
        (inner / 'Unrelated.png').write_bytes(png_fixture(256, 256))
        self.assertEqual(EXPORTER.icon_resource(self.bundle, info), selected.resolve())
        self.assertIsNone(EXPORTER.icon_resource(self.bundle, {**info, 'CFBundleIdentifier': 'dev.example.Other'}))
        # Caller-supplied icon names cannot replace the matched bundle's declaration.
        info['CFBundleIcons'] = {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['Unrelated']}}
        self.assertEqual(EXPORTER.icon_resource(self.bundle, info), selected.resolve())

    def test_primary_icon_rejects_traversal_and_escaping_resource_links(self):
        info, inner = self.primary_metadata(['../outside', '/outside', 'Folder\\Icon', 'External', 'Sibling'])
        external = self.root / 'outside.png'
        external.write_bytes(png_fixture())
        (inner / 'External.png').symlink_to(external)
        sibling = self.bundle / 'Wrapper/Other.app'
        sibling.mkdir()
        (sibling / 'Icon.png').write_bytes(png_fixture())
        (inner / 'Sibling.png').symlink_to(sibling / 'Icon.png')
        self.assertIsNone(EXPORTER.icon_resource(self.bundle, info))

    def test_alternate_icons_and_helper_resources_are_not_primary_icons(self):
        info, inner = self.primary_metadata(['Contents/Helpers/Helper.app/Icon'])
        info['CFBundleIcons']['CFBundleAlternateIcons'] = {'Other': {'CFBundleIconFiles': ['OtherIcon']}}
        (inner / 'Info.plist').write_bytes(plistlib.dumps(info))
        (inner / 'OtherIcon.png').write_bytes(png_fixture())
        helper = inner / 'Contents/Helpers/Helper.app'
        helper.mkdir(parents=True)
        (helper / 'Icon.png').write_bytes(png_fixture())
        self.assertIsNone(EXPORTER.icon_resource(self.bundle, info))

    def test_opaque_and_alpha_pngs_are_accepted_without_changing_pixels(self):
        for color_type in (2, 6):
            with self.subTest(color_type=color_type):
                image = self.root / 'native.png'
                original = png_fixture(color_type=color_type)
                image.write_bytes(original)
                self.assertEqual(EXPORTER.inspect_png(image, 256)[:2], (1, 1))
                self.assertEqual(image.read_bytes(), original)

    def test_declared_wrapper_png_uses_native_sips_before_workspace_fallback(self):
        info, inner = self.primary_metadata(['AppIcon'])
        source = inner / 'AppIcon@3x.png'
        source.write_bytes(png_fixture(cgbi=True))
        stage = self.root / 'stage'
        stage.mkdir()
        calls = []

        def native(arguments):
            calls.append(arguments)
            if arguments[0] == '/usr/bin/sips':
                self.assertIn(str(source.resolve()), arguments)
                Path(arguments[-1]).write_bytes(png_fixture(color_type=2))
            else:
                self.assertTrue(arguments[-2].endswith('native-visibility.js'))

        with patch.object(EXPORTER, 'run_native', side_effect=native):
            result = EXPORTER.export_icon(self.bundle, info, {'id': 'example'}, stage, 256, stage / 'unused.js')
        self.assertEqual(len(calls), 2)
        self.assertEqual(result[1][:2], (1, 1))
        self.assertEqual(result[2], 'bundle resource')

    def test_empty_resource_falls_back_but_empty_workspace_output_fails(self):
        info, inner = self.primary_metadata(['AppIcon'])
        (inner / 'AppIcon.png').write_bytes(png_fixture())
        stage = self.root / 'stage'
        stage.mkdir()
        for fallback_empty in (False, True):
            with self.subTest(fallback_empty=fallback_empty):
                checks = []

                def native(arguments):
                    if arguments[0] == '/usr/bin/sips':
                        Path(arguments[-1]).write_bytes(png_fixture())
                    elif arguments[-2].endswith('native-visibility.js'):
                        checks.append(arguments[-1])
                        if len(checks) == 1 or fallback_empty:
                            raise subprocess.CalledProcessError(1, arguments[0])

                with patch.object(EXPORTER, 'run_native', side_effect=native):
                    if fallback_empty:
                        with self.assertRaises(subprocess.CalledProcessError):
                            EXPORTER.export_icon(self.bundle, info, {'id': 'example'}, stage, 256, stage / 'workspace.js')
                    else:
                        result = EXPORTER.export_icon(self.bundle, info, {'id': 'example'}, stage, 256, stage / 'workspace.js')
                        self.assertEqual(result[2], 'NSWorkspace icon')
                self.assertEqual(len(checks), 2)

    @unittest.skipUnless(sys.platform == 'darwin', 'Native Core Image visibility check requires macOS')
    def test_native_visibility_accepts_sparse_faint_and_opaque_images(self):
        script = self.root / 'visibility.js'
        script.write_text(EXPORTER.VISIBILITY_CHECK, encoding='utf-8')
        fixtures = (
            ('transparent', png_fixture(32, 32, color_type=6), False),
            ('opaque RGB', png_fixture(32, 32), True),
            ('opaque alpha', png_fixture(32, 32, color_type=6, alpha=255), True),
            ('faint alpha', png_fixture(32, 32, color_type=6, alpha=1), True),
            ('one visible pixel', png_fixture(256, 256, color_type=6, single_pixel=True), True),
            ('invalid image', b'not an image', False),
        )
        for label, contents, visible in fixtures:
            with self.subTest(label=label):
                image = self.root / 'fixture.png'
                image.write_bytes(contents)
                command = ['/usr/bin/osascript', '-l', 'JavaScript', str(script), str(image)]
                if visible:
                    EXPORTER.run_native(command)
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        EXPORTER.run_native(command)
                self.assertEqual(image.read_bytes(), contents)


if __name__ == '__main__':
    unittest.main()
