"""macOS integration tests; Python 3 is a development-only dependency.
Uses temporary --config fixtures, never installs launchd jobs or requests Music consent.
"""
import http.server
import json
import pathlib
import plistlib
import secrets
import subprocess
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[2]
requests = []
reply = {'status': 204}
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        data = self.rfile.read(int(self.headers['content-length']))
        requests.append((self.path, self.headers['authorization'], json.loads(data)))
        self.send_response(reply['status'])
        if reply['status'] == 302:
            self.send_header('Location', 'http://127.0.0.1:1/unwanted')
        self.end_headers()
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='macflare-native-test-') as directory:
    fixture_root = pathlib.Path(directory)
    support = fixture_root/'MacFlare'
    support.mkdir(parents=True, mode=0o700)
    config = support/'config.json'
    settings = {'privacy': {'music': False}, 'blocked_apps': ['  ChatGPT  ']}
    config.write_text(json.dumps(settings))
    secret = secrets.token_hex(32)
    secret_source = support/'token'
    secret_source.write_text(secret+'\n')
    secret_source.chmod(0o600)
    def call(args, expected=0):
        result = subprocess.run(args, text=True, capture_output=True, timeout=25)
        assert result.returncode == expected, (result.returncode, result.stdout, result.stderr)
        assert secret not in result.stdout+result.stderr, 'secret appeared in process output'
        return result.stdout
    def runtime(*args, expected=0):
        return call(['/usr/bin/osascript', '-l', 'JavaScript', str(REPO/'agent/runtime.js'), *map(str, args)], expected=expected)

    music_regressions = json.loads(call(['/usr/bin/osascript', '-l', 'JavaScript', str(REPO/'agent/tests/music-regression.js'), str(REPO/'agent/runtime.js')]))
    assert music_regressions['passed'] == 11
    artwork_fixture = fixture_root/'artwork-fixture'
    artwork_fixture.mkdir(mode=0o700)
    artwork_regressions = json.loads(call(['/usr/bin/osascript', '-l', 'JavaScript', str(REPO/'agent/tests/artwork-regression.js'), str(REPO/'agent/runtime.js'), str(artwork_fixture)]))
    assert artwork_regressions['passed'] >= 30
    assert (artwork_fixture/'artwork-cache.json').stat().st_mode & 0o777 == 0o600

    # Profile migration must preserve old schedules and privacy choices. Fixtures
    # exercise both installation inputs without changing HOME or loading launchd.
    origin = f'http://127.0.0.1:{server.server_port}'
    fresh_path = fixture_root/'new-config.json'
    fresh = json.loads(runtime('configure', fresh_path, origin))
    assert fresh['profile'] == 'eco'
    fresh_path.write_text(json.dumps(fresh))
    assert json.loads(runtime('configure', fresh_path, ''))['profile'] == 'eco'
    legacy_path = fixture_root/'legacy-config.json'
    legacy = {'endpoint': origin, 'privacy': {'music': False, 'running_apps': False}, 'blocked_apps': ['Custom Private App']}
    legacy_path.write_text(json.dumps(legacy))
    migrated = json.loads(runtime('configure', legacy_path, ''))
    assert migrated['profile'] == 'realtime'
    assert migrated['privacy']['music'] is False and migrated['privacy']['running_apps'] is False
    assert migrated['blocked_apps'] == legacy['blocked_apps'] and migrated['endpoint'] == origin
    assert json.loads(legacy_path.read_text()) == legacy, 'configure must not rewrite its source file'
    for selected in ['eco', 'realtime']:
        overridden = json.loads(runtime('configure', legacy_path, '', selected))
        assert overridden['profile'] == selected
        assert overridden['privacy'] == migrated['privacy'] and overridden['blocked_apps'] == migrated['blocked_apps']
    overridden = json.loads(runtime('configure', fresh_path, '', 'realtime'))
    fresh_path.write_text(json.dumps(overridden))
    assert json.loads(runtime('configure', fresh_path, ''))['profile'] == 'realtime'
    assert json.loads(runtime('configure', fresh_path, '', 'eco'))['profile'] == 'eco'
    staged_path = fixture_root/'staged-eco.json'
    staged_path.write_text(runtime('configure', legacy_path, '', 'eco'))
    staged_plist = plistlib.loads(runtime('plist', REPO/'agent/macflare.sh', legacy_path, staged_path).encode())
    assert staged_plist['StartInterval'] == 120
    assert staged_plist['ProgramArguments'][-1] == str(legacy_path), 'staged profile must retain the final config path'
    assert plistlib.loads(runtime('plist', REPO/'agent/macflare.sh', legacy_path).encode())['StartInterval'] == 30
    assert 'every 120 seconds' in runtime('schedule-message', staged_path)
    assert 'must be 180' in runtime('schedule-message', staged_path)
    assert 'every 30 seconds' in runtime('schedule-message', legacy_path)
    assert 'must be 60' in runtime('schedule-message', legacy_path)
    invalid_path = fixture_root/'invalid-profile.json'
    for invalid_profile in ['fast', '__proto__', None, 120]:
        invalid_path.write_text(json.dumps(dict(legacy, profile=invalid_profile)))
        runtime('configure', invalid_path, '', expected=1)
        runtime('validate', invalid_path, secret_source, expected=1)
    call([str(REPO/'scripts/install.sh'), '--profile', 'invalid'], expected=2)
    call([str(REPO/'scripts/install.sh'), '--profile'], expected=2)

    configured = call(['/usr/bin/osascript', '-l', 'JavaScript', str(REPO/'agent/runtime.js'), 'configure', str(config), f'http://127.0.0.1:{server.server_port}'])
    config.write_text(configured)
    config.chmod(0o600)
    installed = REPO/'agent/macflare.sh'
    def agent(*args, expected=0):
        return call([str(installed), '--config', str(config), *args], expected=expected)
    plist_raw = call(['/usr/bin/osascript', '-l', 'JavaScript', str(REPO/'agent/runtime.js'), 'plist', str(installed), str(config)])
    plist = plistlib.loads(plist_raw.encode())
    assert plist['StartInterval'] == 30 and plist['RunAtLoad'] is True
    assert plist['LimitLoadToSessionType'] == 'Aqua'
    assert plist['ProgramArguments'] == ['/bin/bash',str(installed),'--once','--config',str(config)]
    printed = json.loads(agent('--print'))
    assert printed['schema_version'] == 1 and printed['music']['state'] == 'unavailable'
    assert 'profile' not in printed, 'local scheduling configuration must not change the API payload'
    assert not {'Passwords','System Settings','ChatGPT'} & set(printed['running_apps'])
    assert printed['active_app'] != 'ChatGPT'
    cache = support/'artwork-cache.json'
    cache.write_text((artwork_fixture/'artwork-cache.json').read_text())
    cache.chmod(0o600)
    agent('--once')
    assert not cache.exists(), 'privacy.music=false must delete the current-song cache'
    assert len(requests) == 1 and requests[-1][0] == '/api/update' and requests[-1][1] == 'Bearer '+secret
    result = json.loads((support/'last-result.json').read_text())
    assert result['success'] is True and result['http_status'] == 204
    reply['status'] = 302
    agent(expected=1)
    assert len(requests) == 2
    result = json.loads((support/'last-result.json').read_text())
    assert result['success'] is False and result['http_status'] == 302
    reply['status'] = 401
    agent(expected=1)
    result = json.loads((support/'last-result.json').read_text())
    assert result['success'] is False and result['http_status'] == 401
    config.chmod(0o644)
    agent(expected=1)
    assert len(requests) == 3
    config.chmod(0o600)
    settings = json.loads(config.read_text())
    settings['privacy'] = {key:False for key in ['active_app','running_apps','battery','system','music']}
    config.write_text(json.dumps(settings))
    private = json.loads(agent('--print'))
    assert private['active_app'] is None and 'running_apps' not in private
    assert private['battery'] == {'percent':None,'charging':None,'power_source':'unknown'}
    assert all(value is None for value in private['system'].values())
    base = fixture_root/'base.json'
    private['active_app'] = '中文 "引号" \\ 路径 😀'
    private['running_apps'] = ['中'*200+str(index) for index in range(64)]
    base.write_text(json.dumps(private,ensure_ascii=False))
    music = fixture_root/'music.json'
    music.write_text(json.dumps({'state':'playing','track':'星晴 🌌 "测试"','artist':'周杰伦'},ensure_ascii=False))
    merged_raw = call(['/usr/bin/osascript','-l','JavaScript',str(REPO/'agent/runtime.js'),'merge',str(base),str(music)])
    merged = json.loads(merged_raw)
    assert merged['active_app'] == private['active_app']
    assert merged['music']['track'] == '星晴 🌌 "测试"'
    assert len(merged_raw.encode()) <= 15001 and len(merged['running_apps']) < 64
server.shutdown()
print('PASS: Music state/metadata and native artwork/cache/security regressions, profile migration/validation and staged schedules, native plist, permission checks, collection/privacy, push/auth, HTTP errors/no redirects, Unicode and payload budget')
