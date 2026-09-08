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
    support.mkdir(parents=True)
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
    assert not {'Passwords','System Settings','ChatGPT'} & set(printed['running_apps'])
    assert printed['active_app'] != 'ChatGPT'
    agent('--once')
    assert len(requests) == 1 and requests[-1][0] == '/update' and requests[-1][1] == 'Bearer '+secret
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
print('PASS: native plist, permission checks, collection/privacy, push/auth, HTTP errors/no redirects, Unicode and payload budget')
