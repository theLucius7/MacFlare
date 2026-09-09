#!/usr/bin/env python3
"""Export only configured installed-app icons with macOS's native image tools.

Python is a development-only dependency. No network, credentials, application
launches, third-party image libraries, or changes to the running agent are used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import struct
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
APP_ROOTS = (Path('/Applications'), Path.home() / 'Applications',
             Path('/System/Applications'), Path('/System/Applications/Utilities'))
ID_PATTERN = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*\Z')
BUNDLE_PATTERN = re.compile(r'[A-Za-z0-9]+(?:[A-Za-z0-9._-]*[A-Za-z0-9])?\Z')
CONTROL_PATTERN = re.compile(r'[\x00-\x1f\x7f]')
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
WORKSPACE_EXPORT = r'''
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(args) {
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile(args[0]);
  var data = icon.TIFFRepresentation;
  if (!data || data.isNil() || !data.writeToFileAtomically(args[1], true)) {
    throw new Error('Cannot export the native application icon.');
  }
}
'''


def text(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 200 and not CONTROL_PATTERN.search(value)


def read_config(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('apps'), list) \
            or not 1 <= len(data['apps']) <= 128:
        raise ValueError('Configuration must contain version 1 and 1 to 128 apps.')
    selected, identifiers = [], set()
    for item in data['apps']:
        if not isinstance(item, dict) or not text(item.get('app')) or not text(item.get('query')):
            raise ValueError('Each configured application needs a name and search query.')
        icon_id, bundle_id = item.get('id'), item.get('bundleId')
        if not isinstance(icon_id, str) or not ID_PATTERN.fullmatch(icon_id) or icon_id in identifiers:
            raise ValueError('Each icon id must be unique, lowercase, and kebab-case.')
        if not isinstance(bundle_id, str) or not BUNDLE_PATTERN.fullmatch(bundle_id):
            raise ValueError(f'Invalid bundleId for {icon_id}.')
        for field in ('aliases', 'matchNames'):
            if not isinstance(item.get(field), list) or not 1 <= len(item[field]) <= 20 \
                    or not all(text(name) for name in item[field]):
                raise ValueError(f'{field} must contain application names for {icon_id}.')
        identifiers.add(icon_id)
        selected.append(item)
    if not selected:
        raise ValueError('Select at least one application in the configuration.')
    return selected


def bundle_identity(path, bundle_id):
    try:
        if path.suffix.lower() != '.app' or not path.is_dir():
            return None
        outer = path.resolve(strict=True)

        def identity(bundle):
            for relative in ('Contents/Info.plist', 'Info.plist'):
                try:
                    metadata = (bundle / relative).resolve(strict=True)
                    if outer not in metadata.parents or not metadata.is_file():
                        continue
                    info = plistlib.loads(metadata.read_bytes())
                    if isinstance(info, dict) and info.get('CFBundleIdentifier') == bundle_id:
                        return info
                except (OSError, ValueError, RuntimeError, plistlib.InvalidFileException):
                    continue
            return None

        info = identity(outer)
        if info is not None:
            return outer, info

        # iOS-on-Mac stores its identity inside a direct Wrapper child. Never
        # recurse into helpers/plugins or follow links that disguise them.
        wrapper = outer / 'Wrapper'
        if wrapper.is_symlink() or not wrapper.is_dir():
            return None
        with os.scandir(wrapper) as entries:
            for index, entry in enumerate(entries):
                if index >= 32:
                    break
                if Path(entry.name).suffix.lower() != '.app' or not entry.is_dir(follow_symlinks=False):
                    continue
                info = identity(Path(entry.path))
                if info is not None:
                    return Path(entry.path), info
        return None
    except (OSError, ValueError, RuntimeError, plistlib.InvalidFileException):
        return None


def bundle_info(path, bundle_id):
    found = bundle_identity(path, bundle_id)
    return found[1] if found is not None else None


def locate_app(item):
    names = dict.fromkeys([item['app'], *item.get('aliases', []), *item.get('matchNames', [])])
    candidates = []
    if item['bundleId'] == 'com.apple.finder':
        candidates.append(Path('/System/Library/CoreServices/Finder.app'))
    for name in names:
        if '/' in name or '\\' in name:
            continue
        filename = name if name.endswith('.app') else name + '.app'
        candidates.extend(root / filename for root in APP_ROOTS)
    for candidate in candidates:
        info = bundle_info(candidate, item['bundleId'])
        if info is not None:
            return candidate, info

    # Exact bundle-id Spotlight query only; never enumerate unrelated applications.
    query = 'kMDItemCFBundleIdentifier == "' + item['bundleId'] + '"'
    try:
        result = subprocess.run(['/usr/bin/mdfind', '-0', query], check=True,
                                capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    for raw in result.stdout.split(b'\0'):
        if not raw:
            continue
        candidate = Path(os.fsdecode(raw))
        info = bundle_info(candidate, item['bundleId'])
        if info is not None:
            return candidate, info
    return None


def primary_icon_resource(bundle, info):
    found = bundle_identity(bundle, info.get('CFBundleIdentifier'))
    if found is None:
        return None
    icon_bundle, identity = found
    outer = bundle.resolve()
    candidates = {}
    for key in ('CFBundleIcons', 'CFBundleIcons~ipad'):
        group = identity.get(key)
        primary = group.get('CFBundlePrimaryIcon') if isinstance(group, dict) else None
        files = primary.get('CFBundleIconFiles') if isinstance(primary, dict) else None
        if not isinstance(files, list):
            continue
        for name in files[:32]:
            if not text(name) or '/' in name or '\\' in name or name in ('.', '..'):
                continue
            stem = name[:-4] if name.lower().endswith('.png') else name
            # Only declared primary names and standard iOS scale/device variants.
            for suffix in ('', '@2x', '@3x', '~ipad', '@2x~ipad', '@3x~ipad', '~iphone', '@2x~iphone', '@3x~iphone'):
                try:
                    candidate = (icon_bundle / (stem + suffix + '.png')).resolve(strict=True)
                    if outer not in candidate.parents or icon_bundle not in candidate.parents \
                            or not candidate.is_file() or candidate.suffix.lower() != '.png':
                        continue
                    # Read dimensions only, including CgBI-optimized iOS PNGs.
                    # Decoding and conversion remain entirely in native sips.
                    with candidate.open('rb') as source:
                        header = source.read(256)
                    if not header.startswith(PNG_SIGNATURE):
                        continue
                    offset = 8
                    while offset + 12 <= len(header):
                        length = struct.unpack('>I', header[offset:offset + 4])[0]
                        if offset + 12 + length > len(header):
                            break
                        if header[offset + 4:offset + 8] == b'IHDR' and length == 13:
                            width, height = struct.unpack('>II', header[offset + 8:offset + 16])
                            if width > 0 and height > 0:
                                candidates[candidate] = width * height
                            break
                        offset += 12 + length
                except (OSError, ValueError, RuntimeError):
                    continue
    return max(candidates, key=lambda path: (candidates[path], path.name)) if candidates else None


def icon_resource(bundle, info):
    filename = info.get('CFBundleIconFile')
    if isinstance(filename, str) and filename:
        resources = (bundle / 'Contents/Resources').resolve()
        candidates = [resources / filename]
        if not Path(filename).suffix:
            candidates = [resources / (filename + extension) for extension in ('.icns', '.png', '.tiff')]
        for candidate in candidates:
            resolved = candidate.resolve()
            if (resolved == resources or resources in resolved.parents) and resolved.is_file() \
                    and resolved.suffix.lower() in ('.icns', '.png', '.tiff', '.tif'):
                return resolved
    return primary_icon_resource(bundle, info)


def run_native(arguments):
    # Only fixed native executables and argument arrays are used; no shell interpolation.
    subprocess.run(arguments, stdin=subprocess.DEVNULL, check=True,
                   capture_output=True, timeout=20)


def inspect_png(path, size):
    data = path.read_bytes()
    if len(data) < 33 or not data.startswith(PNG_SIGNATURE) or data[12:16] != b'IHDR':
        raise ValueError('Native conversion did not produce a PNG.')
    width, height = struct.unpack('>II', data[16:24])
    if not (0 < width <= size and 0 < height <= size):
        raise ValueError('Native conversion produced unexpected icon dimensions.')
    # Inspect only: Python never decodes, draws, resizes, or changes image pixels.
    if data[25] not in (0, 2, 3, 4, 6):
        raise ValueError('Native conversion produced an invalid PNG color type.')
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        if offset + 12 + length > len(data):
            raise ValueError('Truncated PNG chunk.')
        # Native sips emits resolution/colour-space EXIF and TIFF-property XMP.
        # Retain these standard fields while rejecting embedded local paths.
        if kind in (b'tEXt', b'zTXt', b'iTXt', b'eXIf'):
            metadata = data[offset + 8:offset + 8 + length]
            if any(marker.encode(encoding) in metadata
                   for marker in ('/Users/', '/Applications/', 'file://')
                   for encoding in ('utf-8', 'utf-16le', 'utf-16be')):
                raise ValueError('Native PNG metadata contains a local path.')
        offset += 12 + length
        if kind == b'IEND':
            break
    return width, height, hashlib.sha256(data).hexdigest()


def export_icon(bundle, info, item, staging, size, workspace_script):
    target = staging / (item['id'] + '.png')
    resource = icon_resource(bundle, info)
    if resource is not None:
        try:
            run_native(['/usr/bin/sips', '-s', 'format', 'png', '-Z', str(size), str(resource), '--out', str(target)])
            return target, inspect_png(target, size), 'bundle resource'
        except (OSError, ValueError, subprocess.SubprocessError):
            # Asset-catalog-only or unconvertible resources use the system's own icon.
            pass
    native_tiff = staging / (item['id'] + '.tiff')
    run_native(['/usr/bin/osascript', '-l', 'JavaScript', str(workspace_script), str(bundle), str(native_tiff)])
    run_native(['/usr/bin/sips', '-s', 'format', 'png', '-Z', str(size), str(native_tiff), '--out', str(target)])
    return target, inspect_png(target, size), 'NSWorkspace icon'


def check_output_paths(output, selected):
    for path in (output, *output.parents):
        if path.is_symlink():
            raise ValueError('Output directory and its parents must not be symbolic links.')
    for name in ['index.json', *(item['id'] + '.png' for item in selected)]:
        target = output / name
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError('Refusing to replace a non-regular output file.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=REPO / 'config/app-icons.json')
    parser.add_argument('--output-dir', type=Path, default=REPO / 'docs/public/app-icons')
    parser.add_argument('--size', type=int, choices=(128, 256), default=256,
                        help='Maximum pixel dimension; native sips preserves aspect ratio (default: 256).')
    parser.add_argument('--dry-run', action='store_true', help='Locate only the configured apps; do not export or change files.')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Native application icon export requires macOS.')
    selected = read_config(args.config)
    output = args.output_dir.absolute()
    check_output_paths(output, selected)
    located, missing = [], []
    for item in selected:
        found = locate_app(item)
        if found is None:
            missing.append(item['app'])
        else:
            located.append((item, *found))
    if missing:
        raise ValueError('Missing configured applications: ' + ', '.join(missing) + '. No output files changed.')
    if args.dry_run:
        print('Located ' + str(len(located)) + ' configured applications: ' + ', '.join(item['id'] for item, _, _ in located))
        return

    staging_root = REPO / 'work'
    staging_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='export-app-icons-', dir=staging_root) as directory:
        staging = Path(directory)
        workspace_script = staging / 'native-icon.js'
        workspace_script.write_text(WORKSPACE_EXPORT, encoding='utf-8')
        icons, exported = [], []
        for item, bundle, info in located:
            try:
                png, (width, height, sha256), method = export_icon(bundle, info, item, staging, args.size, workspace_script)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                raise ValueError('Could not export ' + item['app'] + '. No output files changed.') from error
            icons.append({
                'id': item['id'], 'app': item['app'],
                'aliases': list(dict.fromkeys(item.get('aliases', []))),
                'imageUrl': '/api/icons/' + item['id'] + '.png',
                'source': 'installed-app', 'credit': '应用图标版权归原作者', 'sourceUrl': None,
                'sha256': sha256,
            })
            exported.append((item['id'], png, width, height, method))
        manifest = staging / 'index.json'
        manifest.write_text(json.dumps({'version': 1, 'icons': icons}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        # All conversions passed before publishing; write the index last.
        check_output_paths(output, selected)
        output.mkdir(parents=True, exist_ok=True)
        for icon_id, png, width, height, method in exported:
            png.chmod(0o644)
            os.replace(png, output / (icon_id + '.png'))
            print(f'{icon_id}: {width}x{height} native PNG ({method})')
        manifest.chmod(0o644)
        os.replace(manifest, output / 'index.json')
    print(f'Exported {len(exported)} native application icons and index.json. No missing applications.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        # Keep app paths, subprocess diagnostics and bundle details out of shared logs.
        print('Icon export failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
